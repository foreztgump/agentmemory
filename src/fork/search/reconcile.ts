import { logger } from "../../logger.js";
import type { StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import type { CompressedObservation, Memory, Session } from "../../types.js";
import { sessionObservationTotals } from "../kv/observation-stats.js";
import { countRows, scanRows } from "../kv/paged-scan.js";
import type { ReconcileReport } from "./backend-status.js";
import type { SearchWorkerClient } from "./client.js";
import type { CollectionReconciler } from "./collection-reconcile.js";
import { docOfRecord, type IndexDoc } from "./doc-of-record.js";
import type { BackendHealth } from "./health.js";
import type { SearchOutbox } from "./outbox.js";
import type { ContentRev, DocStub, EntryStub } from "./protocol.js";
import type { RemoteKeywordIndex } from "./remote-index.js";

const SCAN_PAGE = 1000;
/** A repair pass waits for the outbox above this, so a wiped index never fills it while the worker is healthy. */
const BACKPRESSURE_PENDING = 2000;
const FIRST_PASS_DELAY_MS = 5000;

export type Unit = { kind: "session"; sessionId: string } | { kind: "gone"; sessionId: string } | { kind: "memories" };

export interface UnitDiff {
  /** Indexable records with no live doc. */
  missing: string[];
  /** Docs whose indexed content differs from the record. */
  stale: string[];
  /** Live docs with no indexable record. */
  leaked: string[];
}

/** Pure: compares what the records want indexed (id to rev) with the live entries of one unit. */
export function diffDocs(wanted: ReadonlyMap<string, string>, indexed: readonly EntryStub[]): UnitDiff {
  const seen = new Set<string>();
  const stale: string[] = [];
  const leaked: string[] = [];
  for (const doc of indexed) {
    seen.add(doc.id);
    const rev = wanted.get(doc.id);
    if (rev === undefined) leaked.push(doc.id);
    else if (rev !== doc.rev) stale.push(doc.id);
  }
  return { missing: [...wanted.keys()].filter((id) => !seen.has(id)), stale, leaked };
}

const unitKey = (unit: Unit): string => (unit.kind === "memories" ? "memories" : unit.sessionId);

export interface ReconcilerDeps {
  client: SearchWorkerClient;
  keyword: RemoteKeywordIndex;
  outbox: SearchOutbox;
  health: BackendHealth;
  intervalMs: number;
  sweepPerPass: number;
  /** Lessons and images: compared in full after the docs on every pass. */
  collections?: readonly CollectionReconciler[];
}

interface UnitResult { added: number; deleted: number; wanted: number }

/**
 * Repairs the derived index from the records. Every pass compares per-session
 * row counts with the index's per-session counts and compares a unit doc by
 * doc only when they differ, plus a few sessions in rotation (an offsetting
 * lost add and lost delete leave the counts equal). Missing and stale docs are
 * re-added, leaked docs deleted (a tombstone). Vectors are not touched here: a
 * re-added doc has no vector and the re-embed loop finds it. Nothing is
 * persisted, so a pass interrupted by a crash simply runs again.
 */
export class Reconciler {
  private kv: StateKV | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private memoriesDue = true;
  /** Memory key and index counts when the memories last compared clean; they are read whole only when either moves. */
  private memoriesSettled: { keys: number; indexed: number } | null = null;
  private spillsSeen = 0;
  /** Sessions whose counts differ for a reason a doc-by-doc compare found harmless (rows that are not indexable). */
  private settled = new Map<string, { rows: number; indexed: number }>();
  private verifiedAt = new Map<string, number>();
  private outstanding = new Map<string, number>();
  private finishedOnce = false;
  private state: ReconcileReport = { state: "waiting", startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null };

  constructor(private readonly deps: ReconcilerDeps) {}

  start(kv: StateKV): void {
    if (this.kv) return;
    this.kv = kv;
    if (this.deps.intervalMs === 0) {
      this.state = { ...this.state, state: "off" };
      for (const collection of this.collections) collection.turnOff();
      return;
    }
    this.deps.health.onRecover(() => {
      this.memoriesDue = true;
      this.kick();
    });
    for (const collection of this.collections) collection.health.onRecover(() => this.kick());
    this.schedule(FIRST_PASS_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  kick(): void {
    void this.runPass();
  }

  /** One pass; a call while one runs joins it. */
  runPass(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  get collections(): readonly CollectionReconciler[] {
    return this.deps.collections ?? [];
  }

  report(): ReconcileReport {
    return this.state;
  }

  /** Indexable records still absent after the last pass; null until a pass has finished. */
  missing(): { observations: number; memories: number } | null {
    if (!this.finishedOnce) return null;
    let observations = 0;
    for (const [key, n] of this.outstanding) if (key !== "memories") observations += n;
    return { observations, memories: this.outstanding.get("memories") ?? 0 };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runPass().finally(() => this.schedule(this.deps.intervalMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private async pass(): Promise<void> {
    await this.passDocs();
    for (const collection of this.collections) {
      if (!this.kv || this.stopped) return;
      await collection.run(this.kv, () => this.stopped);
    }
  }

  private async passDocs(): Promise<void> {
    const { client, outbox, health } = this.deps;
    const kv = this.kv;
    if (!kv || this.stopped) return;
    if (!health.ok) {
      this.state = { ...this.state, state: "paused-degraded" };
      return;
    }
    const started = Date.now();
    this.state = { ...this.state, state: "running", startedAt: new Date(started).toISOString(), error: null };
    let added = 0;
    let deleted = 0;
    let checked = 0;
    try {
      await outbox.drainFor(1000);
      const counts = new Map(await client.sessionCounts());
      const sessionIds = await scanRows<Session, string>(kv, KV.sessions, (s) => s.id);
      this.state = { ...this.state, sessions: sessionIds.length };
      const known = new Set(sessionIds);
      const units: Unit[] = [];
      for (const id of counts.keys()) if (!known.has(id)) units.push({ kind: "gone", sessionId: id });
      const rowsOf = new Map<string, number>();
      const agreeing: string[] = [];
      for (const id of sessionIds) {
        const rows = (await sessionObservationTotals(kv, id)).rows;
        const indexed = counts.get(id) ?? 0;
        rowsOf.set(id, rows);
        const memo = this.settled.get(id);
        if (rows === indexed || (memo?.rows === rows && memo.indexed === indexed)) agreeing.push(id);
        else units.push({ kind: "session", sessionId: id });
      }
      for (const id of agreeing) this.outstanding.delete(id);
      const rotation = agreeing.sort((a, b) => (this.verifiedAt.get(a) ?? 0) - (this.verifiedAt.get(b) ?? 0)).slice(0, this.deps.sweepPerPass);
      for (const id of rotation) units.push({ kind: "session", sessionId: id });
      const spills = outbox.counters.spilled;
      const memoryKeys = await countRows(kv, KV.memories);
      const memoriesIndexed = (await client.stats()).memories;
      const memo = this.memoriesSettled;
      if (this.memoriesDue || spills !== this.spillsSeen || memo?.keys !== memoryKeys || memo.indexed !== memoriesIndexed) units.push({ kind: "memories" });

      const results: Array<[Unit, UnitResult]> = [];
      for (const unit of units) {
        if (this.stopped || !health.ok) {
          this.state = { ...this.state, state: "paused-degraded", checked, added, deleted };
          return;
        }
        const result = await this.verify(kv, unit);
        added += result.added;
        deleted += result.deleted;
        checked++;
        this.verifiedAt.set(unitKey(unit), Date.now());
        results.push([unit, result]);
      }

      // Repairs are only queued; count what the index holds once they have landed.
      await outbox.drainFor(10_000);
      const after = new Map(await client.sessionCounts());
      const memoriesAfter = results.some(([u]) => u.kind === "memories") ? (await client.stats()).memories : 0;
      for (const [unit, result] of results) {
        if (unit.kind === "gone") continue;
        const indexed = unit.kind === "memories" ? memoriesAfter : after.get(unit.sessionId) ?? 0;
        const missing = Math.max(0, result.wanted - indexed);
        if (missing > 0) this.outstanding.set(unitKey(unit), missing);
        else this.outstanding.delete(unitKey(unit));
        if (unit.kind === "session" && missing === 0) this.settled.set(unit.sessionId, { rows: rowsOf.get(unit.sessionId) ?? 0, indexed });
        if (unit.kind === "memories") this.memoriesSettled = missing === 0 ? { keys: memoryKeys, indexed } : null;
      }
      for (const key of this.outstanding.keys()) if (key !== "memories" && !known.has(key)) this.outstanding.delete(key);
      for (const key of this.settled.keys()) if (!known.has(key)) this.settled.delete(key);
      for (const key of this.verifiedAt.keys()) if (key !== "memories" && !known.has(key)) this.verifiedAt.delete(key);
      if (results.some(([u]) => u.kind === "memories")) {
        this.memoriesDue = false;
        this.spillsSeen = spills;
      }
      this.finishedOnce = true;
      const finished = Date.now();
      this.state = { state: "idle", startedAt: this.state.startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, sessions: sessionIds.length, checked, added, deleted, error: null };
      if (added > 0 || deleted > 0) logger.info("search index reconciled", { added, deleted, checked, durationMs: finished - started });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("search index reconcile failed; the next pass retries", { error });
      this.state = { ...this.state, state: health.ok ? "idle" : "paused-degraded", checked, added, deleted, error };
    }
  }

  private async verify(kv: StateKV, unit: Unit): Promise<UnitResult> {
    // The index is read before the records: a doc a writer adds after this read cannot look leaked.
    const indexed = await this.scanAll(unit.kind === "memories" ? undefined : unit.sessionId);
    const docs = new Map<string, IndexDoc>();
    let wanted: Map<string, ContentRev>;
    if (unit.kind === "session") {
      for (const row of await kv.list<CompressedObservation>(KV.observations(unit.sessionId))) {
        const doc = docOfRecord("observation", row);
        if (doc) docs.set(doc.obs.id, doc);
      }
      wanted = new Map([...docs].map(([id, doc]) => [id, doc.rev]));
    } else if (unit.kind === "memories") {
      const pairs = await scanRows<Memory, [string, ContentRev] | null>(kv, KV.memories, (m) => {
        const doc = docOfRecord("memory", m);
        return doc ? [m.id, doc.rev] : null;
      });
      wanted = new Map(pairs.filter((p): p is [string, ContentRev] => p !== null));
    } else {
      wanted = new Map();
    }

    const diff = diffDocs(wanted, indexed);
    let added = 0;
    for (const id of [...diff.missing, ...diff.stale]) {
      if (this.stopped) break;
      // Removed by this process since the records were read: re-adding would undo that delete.
      if (this.deps.keyword.removedHere(id)) continue;
      const doc = unit.kind === "memories"
        ? docOfRecord("memory", await kv.get<Memory>(KV.memories, id))
        : docOfRecord("observation", await kv.get<CompressedObservation>(KV.observations(unit.sessionId), id));
      if (!doc) continue;
      this.deps.keyword.add(doc.obs, doc.layer);
      added++;
      await this.backpressure();
    }
    let deleted = 0;
    for (const id of diff.leaked) {
      if (this.stopped) break;
      // Records are written before their doc, so a record present now means the doc is wanted after all.
      const row = unit.kind === "memories" ? await kv.get(KV.memories, id) : await kv.get(KV.observations(unit.sessionId), id);
      if (docOfRecord(unit.kind === "memories" ? "memory" : "observation", row)) continue;
      this.deps.keyword.remove(id);
      deleted++;
      await this.backpressure();
    }
    return { added, deleted, wanted: wanted.size };
  }

  private async scanAll(sessionId: string | undefined): Promise<DocStub[]> {
    const docs: DocStub[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.client.scanDocs(sessionId, cursor, SCAN_PAGE);
      docs.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return docs;
  }

  private async backpressure(): Promise<void> {
    const { outbox, health } = this.deps;
    while (outbox.pending > BACKPRESSURE_PENDING && health.ok && !this.stopped) await outbox.drainFor(5000);
  }
}

import { logger } from "../../logger.js";
import type { StateKV } from "../../state/kv.js";
import { lessonToObservation } from "../../state/memory-utils.js";
import { KV } from "../../state/schema.js";
import type { ImageEmbedding, LessonIndexPort } from "../../state/search-ports.js";
import { termSourceOf } from "../../state/term-extraction.js";
import type { Lesson } from "../../types.js";
import { scanRows } from "../kv/paged-scan.js";
import type { CollectionName, CollectionStatus, ReconcileReport } from "./backend-status.js";
import type { SearchWorkerClient } from "./client.js";
import type { BackendHealth } from "./health.js";
import type { RemoteImageIndex } from "./images.js";
import { convergeLessons } from "./lessons.js";
import type { SearchOutbox } from "./outbox.js";
import { contentRev, imageRev, type EntryStub } from "./protocol.js";
import { diffDocs, type UnitDiff } from "./reconcile.js";

const PAGE = 1000;
const DRAIN_MS = 10_000;

/** How one collection is derived from its records. */
export interface CollectionRecords {
  /** id to revision of every record the collection should hold, read page by page. */
  wanted(kv: StateKV): Promise<Map<string, string>>;
  /** Re-derives these ids from their records: writes the live ones, removes the rest. Never embeds. */
  repair(kv: StateKV, ids: readonly string[]): Promise<void>;
}

export function lessonRecords(index: LessonIndexPort): CollectionRecords {
  return {
    wanted: async (kv) =>
      new Map(
        (await scanRows<Lesson, [string, string] | null>(kv, KV.lessons, (l) => (l.deleted ? null : [l.id, contentRev(termSourceOf(lessonToObservation(l)))])))
          .filter((pair): pair is [string, string] => pair !== null),
      ),
    repair: (kv, ids) => convergeLessons(index, kv, ids),
  };
}

/** Repairs copy the stored vector from the record; nothing is re-embedded. */
export function imageRecords(index: RemoteImageIndex): CollectionRecords {
  return {
    wanted: async (kv) => new Map(await scanRows<ImageEmbedding, [string, string]>(kv, KV.imageEmbeddings, (e) => [e.imageRef, imageRev(e)])),
    repair: async (kv, ids) => {
      const rows = await kv.getMany<ImageEmbedding>(KV.imageEmbeddings, [...ids]);
      ids.forEach((id, i) => {
        const row = rows[i];
        if (row) index.put(row);
        else index.remove(id);
      });
    },
  };
}

/**
 * Compares a small collection (lessons, images) with its records in full on
 * every reconcile pass, holding only id and revision pairs, and re-derives
 * every entry that is missing, stale or has no record. A repair re-reads the
 * record, so an entry written or removed during the pass converges on the
 * next one at the latest.
 * ponytail: a full compare per pass is linear in the collection; gate it on
 * counts, as the docs memories unit does, if a collection reaches tens of thousands.
 */
export class CollectionReconciler {
  private found: { missing: number; extra: number } | null = null;
  private state: ReconcileReport = { state: "waiting", startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null };

  constructor(
    readonly name: CollectionName,
    private readonly deps: { client: SearchWorkerClient; health: BackendHealth; outbox: SearchOutbox; records: CollectionRecords },
  ) {}

  get health(): BackendHealth {
    return this.deps.health;
  }

  turnOff(): void {
    this.state = { ...this.state, state: "off" };
  }

  async probe(deadlineMs: number): Promise<void> {
    const { health, client } = this.deps;
    if (health.ok || health.allowRequest()) await health.probe(client, deadlineMs);
  }

  status(): CollectionStatus {
    const { health, outbox } = this.deps;
    const now = health.current;
    return {
      state: now.ok ? "healthy" : "degraded",
      reason: now.ok ? null : now.reason,
      pendingWrites: outbox.pending,
      droppedWrites: outbox.counters.spilled,
      missing: this.found?.missing ?? null,
      extra: this.found?.extra ?? null,
      reconcile: this.state,
    };
  }

  async run(kv: StateKV, stopped: () => boolean): Promise<void> {
    const { health, outbox, records } = this.deps;
    const off = this.state.state === "off";
    if (!health.ok) {
      if (!off) this.state = { ...this.state, state: "paused-degraded" };
      return;
    }
    const started = Date.now();
    this.state = { ...this.state, state: "running", startedAt: new Date(started).toISOString(), error: null };
    try {
      await outbox.drainFor(1000);
      const diff = await this.compare(kv);
      const checked = diff.checked;
      const repair = [...diff.missing, ...diff.stale, ...diff.leaked];
      let sent = 0;
      while (sent < repair.length && health.ok && !stopped()) {
        const page = repair.slice(sent, sent + PAGE);
        await records.repair(kv, page);
        sent += page.length;
        await outbox.drainFor(DRAIN_MS);
      }
      const added = Math.min(sent, diff.missing.length + diff.stale.length);
      const deleted = sent - added;
      if (stopped() || !health.ok) {
        this.state = { ...this.state, state: "paused-degraded", checked, added, deleted };
        return;
      }
      if (repair.length > 0) await this.compare(kv);
      const finished = Date.now();
      this.state = { state: off ? "off" : "idle", startedAt: this.state.startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, checked, added, deleted, error: null };
      if (repair.length > 0) logger.info(`search ${this.name} collection reconciled`, { added, deleted, missing: this.found?.missing, extra: this.found?.extra });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`search ${this.name} collection reconcile failed; the next pass retries`, { error });
      this.state = { ...this.state, state: off ? "off" : health.ok ? "idle" : "paused-degraded", error };
    }
  }

  /** The index is read before the records: an entry a writer adds after this read cannot look extra. Publishes what it found. */
  private async compare(kv: StateKV): Promise<UnitDiff & { checked: number }> {
    const indexed: EntryStub[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.client.scanEntries(cursor, PAGE);
      indexed.push(...page.items);
      cursor = page.next;
    } while (cursor);
    const wanted = await this.deps.records.wanted(kv);
    const diff = diffDocs(wanted, indexed);
    this.found = { missing: diff.missing.length + diff.stale.length, extra: diff.leaked.length };
    return { ...diff, checked: wanted.size };
  }
}

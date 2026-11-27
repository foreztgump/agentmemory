import type { StateKV } from "../state/kv.js";
import { collectAll } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { KeywordIndexPort } from "../state/search-ports.js";
import type { CompressedObservation, Session } from "../types.js";
import { ObservationStats, observationStatsOf, sessionOf } from "./kv/observation-stats.js";

export interface UnindexedScan {
  sessions: number;
  missing: CompressedObservation[];
}

async function unindexedRows(rows: CompressedObservation[], idx: KeywordIndexPort): Promise<CompressedObservation[]> {
  await idx.prefetch?.(rows.map((obs) => obs.id));
  return rows.filter((obs) => obs.title && obs.narrative && !idx.has(obs.id));
}

function indexedTotal(indexed: Map<string, number>): number {
  let total = 0;
  for (const count of indexed.values()) total += count;
  return total;
}

/**
 * Remembers which sessions can hold unindexed observations so a health tick lists only those.
 * A full pass applies upstream's rule to every session. Later passes recheck only sessions
 * whose rows or record were written since, and sessions that still had unindexed rows.
 */
class UnindexedTracker {
  private sessionIds = new Set<string>();
  private dirty = new Set<string>();
  private missing = new Map<string, CompressedObservation[]>();
  private journal: Array<{ id: string; deleted: boolean }> | null = null;
  private primed = false;
  private epoch = -1;
  private lastIndexedTotal = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: StateKV,
    private readonly stats: ObservationStats,
  ) {
    stats.onWrite((scope, key, deleted, failed) => this.onWrite(scope, key, deleted && !failed));
  }

  scan(idx: KeywordIndexPort, epoch: number): Promise<UnindexedScan> {
    const run = this.chain.then(() => this.pass(idx, epoch));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private onWrite(scope: string, key: string, deleted: boolean): void {
    if (scope === KV.sessions) {
      if (this.journal) this.journal.push({ id: key, deleted });
      else this.applySession(key, deleted);
      return;
    }
    const sessionId = sessionOf(scope);
    if (sessionId !== null) this.dirty.add(sessionId);
  }

  private applySession(id: string, deleted: boolean): void {
    if (deleted) {
      this.sessionIds.delete(id);
      this.missing.delete(id);
    } else {
      this.sessionIds.add(id);
      this.dirty.add(id);
    }
  }

  private async pass(idx: KeywordIndexPort, epoch: number): Promise<UnindexedScan> {
    const indexed = await idx.observationCountsBySession();
    const total = indexedTotal(indexed);
    const full = !this.primed || epoch !== this.epoch || total < this.lastIndexedTotal;
    const taken = this.dirty;
    this.dirty = new Set();
    try {
      if (full) await this.fullPass(idx, indexed);
      else await this.incrementalPass(idx, indexed, taken);
    } catch (error) {
      for (const id of taken) this.dirty.add(id);
      if (full) this.primed = false;
      throw error;
    }
    this.primed = true;
    this.epoch = epoch;
    this.lastIndexedTotal = total;
    return { sessions: this.sessionIds.size, missing: [...this.missing.values()].flat() };
  }

  private async fullPass(idx: KeywordIndexPort, indexed: Map<string, number>): Promise<void> {
    this.journal = [];
    try {
      const sessions = await collectAll<Session>(this.kv, KV.sessions);
      const missing = new Map<string, CompressedObservation[]>();
      for (const session of sessions) {
        const known = session.observationCount ?? 0;
        if (known > 0 && known <= (indexed.get(session.id) ?? 0)) continue;
        const found = await unindexedRows(await this.kv.list<CompressedObservation>(KV.observations(session.id)), idx);
        if (found.length > 0) missing.set(session.id, found);
      }
      const journal = this.journal;
      this.journal = null;
      this.sessionIds = new Set(sessions.map((session) => session.id));
      this.missing = missing;
      for (const { id, deleted } of journal) this.applySession(id, deleted);
      for (const id of this.missing.keys()) if (!this.sessionIds.has(id)) this.missing.delete(id);
    } finally {
      this.journal = null;
    }
  }

  private async incrementalPass(idx: KeywordIndexPort, indexed: Map<string, number>, taken: Set<string>): Promise<void> {
    const candidates = new Set([...taken, ...this.missing.keys()]);
    for (const id of candidates) {
      if (!this.sessionIds.has(id)) {
        this.missing.delete(id);
        continue;
      }
      const known = (await this.stats.totals(id)).rows;
      if (known === 0 || known <= (indexed.get(id) ?? 0)) {
        this.missing.delete(id);
        continue;
      }
      const found = await unindexedRows(await this.kv.list<CompressedObservation>(KV.observations(id)), idx);
      if (found.length > 0) this.missing.set(id, found);
      else this.missing.delete(id);
    }
  }
}

const trackers = new WeakMap<object, UnindexedTracker>();

/**
 * Same result as upstream's findUnindexedObservations, without re-listing a session whose rows
 * did not change. Returns undefined when kv carries no observation stats, so upstream's own scan runs.
 */
export async function trackedUnindexedObservations(
  kv: StateKV,
  idx: KeywordIndexPort,
  epoch: number,
): Promise<UnindexedScan | undefined> {
  const stats = observationStatsOf(kv);
  if (!stats) return undefined;
  let tracker = trackers.get(kv);
  if (!tracker) {
    tracker = new UnindexedTracker(kv, stats);
    trackers.set(kv, tracker);
  }
  return tracker.scan(idx, epoch);
}

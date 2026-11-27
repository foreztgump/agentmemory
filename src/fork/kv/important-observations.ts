import { idKey, orderKey, orderLikeInsertion, type StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import { logger } from "../../logger.js";
import type { CompressedObservation, ImportantObservationEntry, SessionImportantObservations } from "../../types.js";

/** The rows context injection may show for a session without a summary. */
export const isImportantObservation = (o: CompressedObservation | null | undefined): boolean =>
  Boolean(o?.title) && o!.importance >= 5;

export function importantEntry(key: unknown, row: unknown): ImportantObservationEntry | null {
  const typed = row as CompressedObservation | null | undefined;
  if (typeof key !== "string" || !isImportantObservation(typed)) return null;
  const at = orderKey(typed);
  return { key, id: idKey(typed), importance: typed!.importance, at: Number.isFinite(at) ? at : null };
}

function sameEntry(a: ImportantObservationEntry | null, b: ImportantObservationEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return a.key === b.key && a.id === b.id && a.importance === b.importance && a.at === b.at;
}

/** Highest importance first, then the order the redis backend lists rows in, the order context injection has always shown. */
function byInjectionOrder(a: ImportantObservationEntry, b: ImportantObservationEntry): number {
  if (a.importance !== b.importance) return b.importance - a.importance;
  const atA = a.at ?? Number.POSITIVE_INFINITY;
  const atB = b.at ?? Number.POSITIVE_INFINITY;
  if (atA !== atB) return atA < atB ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function topImportant(rows: CompressedObservation[], limit: number): CompressedObservation[] {
  return orderLikeInsertion(rows.filter(isImportantObservation))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);
}

/** Entries an index row keeps. Context injection shows five per session; the rest is slack so deleting a shown row rarely forces a rescan. */
export const IMPORTANT_KEEP = 20;

/** The first IMPORTANT_KEEP entries in injection order, and how many important rows that leaves out. */
function bounded(entries: ImportantObservationEntry[], omitted = 0): Pick<SessionImportantObservations, "entries" | "omitted"> {
  const sorted = [...entries].sort(byInjectionOrder);
  return { entries: sorted.slice(0, IMPORTANT_KEEP), omitted: omitted + Math.max(0, sorted.length - IMPORTANT_KEEP) };
}

/**
 * The index after one row changes from `before` to `after`. Every left-out row ranks after the last
 * kept entry, so a kept row can go without a rescan; a row that ranks after the last kept entry
 * while others are left out is counted with them, since only a scan could place it among them.
 */
function applied(
  index: Pick<SessionImportantObservations, "entries" | "omitted">,
  key: string,
  before: ImportantObservationEntry | null,
  after: ImportantObservationEntry | null,
): Pick<SessionImportantObservations, "entries" | "omitted"> {
  const kept = index.entries.filter((entry) => entry.key !== key);
  let omitted = index.omitted;
  if (kept.length === index.entries.length && before !== null) omitted = Math.max(0, omitted - 1);
  if (after !== null) {
    const last = kept[kept.length - 1];
    if (omitted > 0 && (last === undefined || byInjectionOrder(after, last) > 0)) omitted++;
    else kept.push(after);
  }
  return bounded(kept, omitted);
}

/**
 * One KV.obsImportant row per session: the key, importance and insertion-order keys of the leading
 * rows context injection could show (at most IMPORTANT_KEEP, plus a count of the important rows left
 * out), so it reads those rows by key instead of the whole session and each write costs the same in
 * a session of any size. The owner (ObservationStats) calls `applyLocked` inside its per-session
 * lock on every write to `mem:obs:<session>`. A session written before the index existed has no row
 * until context first reads it, which builds the row from one paged scan; so does a session whose
 * kept entries fell below what context shows while important rows were left out. Reads check each row they fetch against its entry and rebuild the session on any
 * mismatch, so a stale entry can never inject a deleted row.
 */
export class ImportantObservationIndex {
  constructor(
    private readonly base: StateKV,
    private readonly lock: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>,
  ) {}

  async applyLocked(sessionId: string, key: string, oldRow: unknown, newRow: unknown, rowsBefore: number, rowsAfter: number): Promise<void> {
    if (rowsAfter === 0) {
      if (rowsBefore > 0) await this.base.delete(KV.obsImportant, sessionId);
      return;
    }
    const before = rowsBefore === 0 ? null : importantEntry(key, oldRow);
    const after = importantEntry(key, newRow);
    if (rowsBefore > 0 && sameEntry(before, after)) return;
    const stored = rowsBefore === 0
      ? { entries: [], omitted: 0 }
      : await this.base.get<SessionImportantObservations>(KV.obsImportant, sessionId);
    if (!stored) return;
    await this.store(sessionId, applied({ entries: stored.entries, omitted: stored.omitted ?? 0 }, key, before, after));
  }

  /** Stores the index built from a full scan of the session, or drops it when the scan could not key every row. The caller holds the session lock. */
  async replaceLocked(sessionId: string, entries: ImportantObservationEntry[] | null, rows: number): Promise<void> {
    if (rows === 0 || entries === null) await this.base.delete(KV.obsImportant, sessionId);
    else await this.store(sessionId, bounded(entries));
  }

  /** The `limit` rows context injection shows for the session, in the order it shows them. */
  async top(sessionId: string, limit: number): Promise<CompressedObservation[]> {
    const stored = await this.base.get<SessionImportantObservations>(KV.obsImportant, sessionId);
    if (stored && (limit <= stored.entries.length || !(stored.omitted > 0))) {
      const picked = [...stored.entries].sort(byInjectionOrder).slice(0, limit);
      const rows = await Promise.all(
        picked.map((entry) => this.base.get<CompressedObservation>(KV.observations(sessionId), entry.key)),
      );
      if (rows.every((row, i) => sameEntry(importantEntry(picked[i]!.key, row), picked[i]!))) {
        return rows as CompressedObservation[];
      }
      logger.warn("important-observation index disagreed with the session's rows; rebuilding it", { sessionId });
    }
    return this.lock(sessionId, () => this.rebuildLocked(sessionId, limit));
  }

  private async rebuildLocked(sessionId: string, limit: number): Promise<CompressedObservation[]> {
    const kept: CompressedObservation[] = [];
    const entries: ImportantObservationEntry[] = [];
    let rows = 0;
    let keyed = true;
    for await (const page of this.base.iterate<CompressedObservation>(KV.observations(sessionId))) {
      for (const row of page) {
        if (!row) continue;
        rows++;
        if (!isImportantObservation(row)) continue;
        kept.push(row);
        const entry = importantEntry(row.id, row);
        if (entry) entries.push(entry);
        else keyed = false;
      }
    }
    if (rows > 0 && keyed) await this.store(sessionId, bounded(entries));
    return topImportant(kept, limit);
  }

  private async store(sessionId: string, index: Pick<SessionImportantObservations, "entries" | "omitted">): Promise<void> {
    await this.base.set<SessionImportantObservations>(KV.obsImportant, sessionId, { ...index, updatedAt: new Date().toISOString() });
  }
}

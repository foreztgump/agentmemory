import type { IIIClient } from "iii-sdk";
import type { StateKV, StateSetReply } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import { logger } from "../../logger.js";
import type { CompressedObservation, SessionObservationStats } from "../../types.js";
import {
  EMPTY_SESSION_TOTALS,
  observationSourceTotals,
  type SessionSourceTotals,
} from "../../functions/observation-source-budget.js";

const OBS_PREFIX = KV.observations("");
const READY_KEY = "\u0000ready";
const READY_VERSION = 2;
const STATS = Symbol.for("agentmemory.fork.observationStats");

type UpdateOp = { type: string; path: string; value?: unknown };
export type WriteListener = (scope: string, key: string, deleted: boolean) => void;

export function sessionOf(scope: string): string | null {
  return scope.startsWith(OBS_PREFIX) && scope.length > OBS_PREFIX.length ? scope.slice(OBS_PREFIX.length) : null;
}

type Tally = SessionSourceTotals & Pick<SessionObservationStats, "lowImportanceRows" | "lowImportanceOldestMs">;
type Contribution = { totals: SessionSourceTotals; lowMs: number | null };

const EMPTY_CONTRIBUTION: Contribution = { totals: EMPTY_SESSION_TOTALS, lowMs: null };
const EMPTY_TALLY: Tally = { ...EMPTY_SESSION_TOTALS, lowImportanceRows: 0, lowImportanceOldestMs: null };

/** The timestamp of a row auto-forget could remove for low importance, or null when it never could. */
function lowImportanceMs(row: CompressedObservation): number | null {
  if (!row.timestamp || !((row.importance ?? 5) <= 2)) return null;
  const ms = new Date(row.timestamp).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function contribution(row: unknown): Contribution {
  if (row === null || row === undefined) return EMPTY_CONTRIBUTION;
  const typed = row as CompressedObservation;
  return { totals: observationSourceTotals([typed]), lowMs: lowImportanceMs(typed) };
}

function shift(base: Tally, removed: Contribution, added: Contribution): Tally {
  const totals: SessionSourceTotals = {
    rows: Math.max(0, base.rows - removed.totals.rows + added.totals.rows),
    sourceBytes: Math.max(0, base.sourceBytes - removed.totals.sourceBytes + added.totals.sourceBytes),
    summaryBytes: Math.max(0, base.summaryBytes - removed.totals.summaryBytes + added.totals.summaryBytes),
  };
  if (base.lowImportanceRows === undefined) return totals;
  const lowImportanceRows = Math.max(
    0,
    base.lowImportanceRows - (removed.lowMs === null ? 0 : 1) + (added.lowMs === null ? 0 : 1),
  );
  const earlier = [base.lowImportanceOldestMs ?? null, added.lowMs].filter((ms): ms is number => ms !== null);
  return {
    ...totals,
    lowImportanceRows,
    lowImportanceOldestMs: lowImportanceRows === 0 || earlier.length === 0 ? null : Math.min(...earlier),
  };
}

/**
 * Keeps one SessionObservationStats row per session in step with every write to
 * `mem:obs:<session>`, so capture can check the per-session cap and source budget
 * without listing the session. All stat changes for a session run under one
 * in-process lock (the redis backend's kv.update already assumes one writer process).
 */
export class ObservationStats {
  private readonly listeners = new Set<WriteListener>();

  constructor(private readonly base: StateKV) {}

  /** Calls `listener` after every set, update and delete on any scope, also when the write or its bookkeeping threw, since the write may have landed. Returns the unsubscribe function. */
  onWrite(listener: WriteListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(scope: string, key: string, deleted: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(scope, key, deleted);
      } catch (error) {
        logger.warn("observation stats write listener failed", { error: String(error) });
      }
    }
  }

  private lock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return withKeyedLock(`obs-stats:${sessionId}`, fn);
  }

  private async current(sessionId: string): Promise<Tally> {
    const stored = await this.base.get<SessionObservationStats>(KV.obsStats, sessionId);
    if (stored) return stored;
    return this.lock(sessionId, () => this.loadLocked(sessionId));
  }

  async totals(sessionId: string): Promise<SessionSourceTotals> {
    return this.current(sessionId);
  }

  async totalsExcluding(sessionId: string, row: unknown): Promise<SessionSourceTotals> {
    return shift(await this.current(sessionId), contribution(row), EMPTY_CONTRIBUTION);
  }

  /**
   * How many rows of the session auto-forget could remove for low importance, and a lower
   * bound on the earliest of their timestamps. Undefined when the stored row predates the
   * tracking, so the caller must scan the session.
   */
  async lowImportance(sessionId: string): Promise<{ rows: number; oldestMs: number | null } | undefined> {
    const tally = await this.current(sessionId);
    if (tally.rows === 0) return { rows: 0, oldestMs: null };
    if (tally.lowImportanceRows === undefined) return undefined;
    return { rows: tally.lowImportanceRows, oldestMs: tally.lowImportanceOldestMs ?? null };
  }

  async recount(sessionId: string): Promise<SessionSourceTotals> {
    return this.lock(sessionId, () => this.recountLocked(sessionId));
  }

  async afterChange<T>(
    scope: string,
    key: string,
    write: () => Promise<T>,
    read: () => Promise<unknown>,
    deleted = false,
  ): Promise<T> {
    const sessionId = sessionOf(scope);
    if (sessionId === null) {
      try {
        return await write();
      } finally {
        this.notify(scope, key, deleted);
      }
    }
    return this.lock(sessionId, async () => {
      try {
        const before = await this.loadLocked(sessionId);
        const oldRow = await this.base.get(scope, key);
        const result = await write();
        const newRow = await read();
        const after = shift(before, contribution(oldRow), contribution(newRow));
        await this.storeLocked(sessionId, after, before.rows);
        return result;
      } finally {
        this.notify(scope, key, deleted);
      }
    });
  }

  private async loadLocked(sessionId: string): Promise<Tally> {
    const stored = await this.base.get<SessionObservationStats>(KV.obsStats, sessionId);
    if (stored) return stored;
    if (await this.base.get(KV.obsStats, READY_KEY)) {
      const session = await this.base.get<{ observationCount?: number }>(KV.sessions, sessionId);
      if (!session?.observationCount) return EMPTY_TALLY;
    }
    return this.recountLocked(sessionId);
  }

  private async recountLocked(sessionId: string): Promise<Tally> {
    let tally = EMPTY_TALLY;
    for await (const page of this.base.iterate<CompressedObservation>(KV.observations(sessionId))) {
      for (const row of page) tally = shift(tally, EMPTY_CONTRIBUTION, contribution(row));
    }
    await this.storeLocked(sessionId, tally, -1);
    return tally;
  }

  private async storeLocked(sessionId: string, tally: Tally, previousRows: number): Promise<void> {
    if (tally.rows === 0) await this.base.delete(KV.obsStats, sessionId);
    else await this.base.set<SessionObservationStats>(KV.obsStats, sessionId, { ...tally, updatedAt: new Date().toISOString() });
    if (tally.rows === previousRows) return;
    const session = await this.base.get<{ observationCount?: number }>(KV.sessions, sessionId);
    if (session && session.observationCount !== tally.rows) {
      await this.base.update(KV.sessions, sessionId, [{ type: "set", path: "observationCount", value: tally.rows }]);
    }
  }

  async repairAll(): Promise<{ sessions: number; observations: number }> {
    let sessions = 0;
    let observations = 0;
    for (const scope of await this.observationScopes()) {
      const sessionId = sessionOf(scope)!;
      observations += (await this.recount(sessionId)).rows;
      sessions++;
    }
    await this.base.set(KV.obsStats, READY_KEY, { v: READY_VERSION, at: new Date().toISOString(), sessions, observations });
    return { sessions, observations };
  }

  private async observationScopes(): Promise<string[]> {
    try {
      return (await this.base.listGroups()).filter((scope) => sessionOf(scope) !== null);
    } catch {
      const scopes: string[] = [];
      for await (const page of this.base.iterate<{ id?: string }>(KV.sessions)) {
        for (const session of page) if (typeof session?.id === "string") scopes.push(KV.observations(session.id));
      }
      return scopes;
    }
  }

  /** True once a repair has filled every stats field this version keeps. An older marker still means a missing row is an empty session. */
  async isReady(): Promise<boolean> {
    const marker = await this.base.get<{ v?: number }>(KV.obsStats, READY_KEY);
    return (marker?.v ?? 1) >= READY_VERSION;
  }
}

export function observationStatsOf(kv: unknown): ObservationStats | undefined {
  return (kv as { [STATS]?: ObservationStats } | null)?.[STATS];
}

/**
 * Session totals for the cap check and source budget. Uses the maintained stats when
 * kv carries them; otherwise lists the session as upstream does.
 */
export async function sessionObservationTotals(
  kv: StateKV,
  sessionId: string,
  excluding?: unknown,
): Promise<SessionSourceTotals> {
  const stats = observationStatsOf(kv);
  if (stats) return excluding === undefined ? stats.totals(sessionId) : stats.totalsExcluding(sessionId, excluding);
  const rows = await kv.list<CompressedObservation>(KV.observations(sessionId));
  const id = (excluding as { id?: unknown } | undefined)?.id;
  return observationSourceTotals(id === undefined ? rows : rows.filter((row) => row?.id !== id));
}

export function withObservationStats<K extends StateKV>(kv: K): K {
  const stats = new ObservationStats(kv);
  const wrapped = Object.create(kv) as K & { [STATS]: ObservationStats };
  const { set, update, delete: remove, get } = kv;
  wrapped[STATS] = stats;
  wrapped.set = <T>(scope: string, key: string, value: T) =>
    stats.afterChange(scope, key, () => set.call(wrapped, scope, key, value) as Promise<StateSetReply<T>>, async () => value);
  wrapped.update = <T>(scope: string, key: string, ops: UpdateOp[]) =>
    stats.afterChange(scope, key, () => update.call(wrapped, scope, key, ops) as Promise<T>, () => get.call(wrapped, scope, key));
  wrapped.delete = (scope: string, key: string) =>
    stats.afterChange(scope, key, () => remove.call(wrapped, scope, key), async () => null, true);
  return wrapped;
}

export function registerObservationStatsRepair(sdk: IIIClient, kv: StateKV): void {
  sdk.registerFunction("mem::obs-stats-repair", async (input: { sessionId?: string } = {}) => {
    const stats = observationStatsOf(kv);
    if (!stats) return { success: false, error: "observation stats are not enabled on this worker" };
    if (typeof input?.sessionId === "string" && input.sessionId.length > 0) {
      const totals = await stats.recount(input.sessionId);
      return { success: true, sessions: 1, observations: totals.rows };
    }
    return { success: true, ...(await stats.repairAll()) };
  });
}

export function repairObservationStatsOnce(kv: StateKV): void {
  const stats = observationStatsOf(kv);
  if (!stats) return;
  void stats
    .isReady()
    .then(async (ready) => {
      if (ready) return;
      const started = Date.now();
      const result = await stats.repairAll();
      logger.info("observation stats repaired", { ...result, ms: Date.now() - started });
    })
    .catch((error) => logger.warn("observation stats repair failed", { error: String(error) }));
}

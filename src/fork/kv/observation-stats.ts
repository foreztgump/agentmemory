import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";
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
const STATS = Symbol.for("agentmemory.fork.observationStats");

type UpdateOp = { type: string; path: string; value?: unknown };
export type WriteListener = (scope: string, key: string, deleted: boolean) => void;

export function sessionOf(scope: string): string | null {
  return scope.startsWith(OBS_PREFIX) && scope.length > OBS_PREFIX.length ? scope.slice(OBS_PREFIX.length) : null;
}

function contribution(row: unknown): SessionSourceTotals {
  return row === null || row === undefined
    ? EMPTY_SESSION_TOTALS
    : observationSourceTotals([row as CompressedObservation]);
}

function shift(base: SessionSourceTotals, removed: SessionSourceTotals, added: SessionSourceTotals): SessionSourceTotals {
  return {
    rows: Math.max(0, base.rows - removed.rows + added.rows),
    sourceBytes: Math.max(0, base.sourceBytes - removed.sourceBytes + added.sourceBytes),
    summaryBytes: Math.max(0, base.summaryBytes - removed.summaryBytes + added.summaryBytes),
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

  /** Calls `listener` after every successful set, update and delete on any scope. Returns the unsubscribe function. */
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

  async totals(sessionId: string): Promise<SessionSourceTotals> {
    const stored = await this.base.get<SessionObservationStats>(KV.obsStats, sessionId);
    if (stored) return stored;
    return this.lock(sessionId, () => this.loadLocked(sessionId));
  }

  async totalsExcluding(sessionId: string, row: unknown): Promise<SessionSourceTotals> {
    return shift(await this.totals(sessionId), contribution(row), EMPTY_SESSION_TOTALS);
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
      const result = await write();
      this.notify(scope, key, deleted);
      return result;
    }
    return this.lock(sessionId, async () => {
      const before = await this.loadLocked(sessionId);
      const oldRow = await this.base.get(scope, key);
      const result = await write();
      const newRow = await read();
      const after = shift(before, contribution(oldRow), contribution(newRow));
      await this.storeLocked(sessionId, after, before.rows);
      this.notify(scope, key, deleted);
      return result;
    });
  }

  private async loadLocked(sessionId: string): Promise<SessionSourceTotals> {
    const stored = await this.base.get<SessionObservationStats>(KV.obsStats, sessionId);
    if (stored) return stored;
    if (await this.base.get(KV.obsStats, READY_KEY)) {
      const session = await this.base.get<{ observationCount?: number }>(KV.sessions, sessionId);
      if (!session?.observationCount) return EMPTY_SESSION_TOTALS;
    }
    return this.recountLocked(sessionId);
  }

  private async recountLocked(sessionId: string): Promise<SessionSourceTotals> {
    let totals = EMPTY_SESSION_TOTALS;
    for await (const page of this.base.iterate<CompressedObservation>(KV.observations(sessionId))) {
      totals = shift(totals, EMPTY_SESSION_TOTALS, observationSourceTotals(page));
    }
    await this.storeLocked(sessionId, totals, -1);
    return totals;
  }

  private async storeLocked(sessionId: string, totals: SessionSourceTotals, previousRows: number): Promise<void> {
    if (totals.rows === 0) await this.base.delete(KV.obsStats, sessionId);
    else await this.base.set<SessionObservationStats>(KV.obsStats, sessionId, { ...totals, updatedAt: new Date().toISOString() });
    if (totals.rows === previousRows) return;
    const session = await this.base.get<{ observationCount?: number }>(KV.sessions, sessionId);
    if (session && session.observationCount !== totals.rows) {
      await this.base.update(KV.sessions, sessionId, [{ type: "set", path: "observationCount", value: totals.rows }]);
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
    await this.base.set(KV.obsStats, READY_KEY, { at: new Date().toISOString(), sessions, observations });
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

  async isReady(): Promise<boolean> {
    return Boolean(await this.base.get(KV.obsStats, READY_KEY));
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
    stats.afterChange(scope, key, () => set.call(wrapped, scope, key, value) as Promise<T>, async () => value);
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

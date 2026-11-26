import type { StateKV } from "../../state/kv.js";
import type { Session } from "../../types.js";
import { KV } from "../../state/schema.js";
import { RETENTION_KV } from "./scopes.js";

/**
 * The project-active clock (design 6): age counts only days on which the item's project had a session.
 *
 * The design says to read it from the project's session index, but `mem:idx:project-sessions` keeps only
 * the 50 newest sessions per project (session-index.ts), too few to measure 180 or 365 active days. So the
 * sweep keeps its own `mem:retention:active-days` (project -> sorted UTC day numbers), refreshed from one
 * paged pass over mem:sessions per sweep (ids and dates only). A few hundred numbers per project. The stored
 * days are never dropped, so a deleted session's day stays active; a project with no session left in
 * mem:sessions reads as empty (age 0, nothing older), the safe side.
 *
 * Boundary semantics, which every window depends on:
 *   - A day is a UTC day number, `Math.floor(ms / 86_400_000)`. A timestamp is truncated to its UTC day, so
 *     time of day never counts.
 *   - A session makes one day active: the UTC day of its `startedAt`.
 *   - Age of a timestamp t is the number of active days strictly after t's own day and up to today's UTC
 *     day. t's own day is never counted, active or not. A day after today (clock skew) is not counted.
 *   - An item is older than a window of N days when its age is at least N, except a timestamp whose own day
 *     is after today (clock skew), which is never older than any window. With N = 0 (the test windows) every
 *     item up to today is older. The cutoff rule (`t < cutoffForActiveDays(project, N)`) is normative.
 *   - A project with no active days has age 0 for every timestamp.
 */
export interface ActiveClock {
  /** Age of `since` in active days of `project`, as defined above. */
  activeDaysSince(project: string, since: Date): number;

  /**
   * The cutoff for a window of `days` active days: `t` is older than the window exactly when
   * `t < cutoffForActiveDays(project, days)`, so a timestamp at or after the cutoff is inside it. It is
   * 00:00 UTC of the `days`-th most recent active day (today counted when active). For `days` = 0 it is
   * 00:00 UTC of the day after today. A project with fewer than `days` active days returns `new Date(0)`,
   * so nothing is older. Use this where a stored timestamp is compared, such as the `retrieved` signal's
   * `mem:access` read, instead of a wall-clock window: an idle project's days do not age its items.
   */
  cutoffForActiveDays(project: string, days: number): Date;
}

export const MS_PER_DAY = 86_400_000;

const dayOf = (at: Date): number => Math.floor(at.getTime() / MS_PER_DAY);

function upperBound(days: readonly number[], day: number): number {
  let low = 0;
  let high = days.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (days[mid]! <= day) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Pure. `days` must be sorted ascending with no duplicates; the loader writes it that way and this does
 * not check, so an unsorted list gives an undefined count. Counts `d` with `sinceDay < d <= todayDay`.
 * An empty list gives 0.
 */
export function countActiveDaysAfter(days: readonly number[], sinceDay: number, todayDay: number): number {
  return Math.max(0, upperBound(days, todayDay) - upperBound(days, sinceDay));
}

/**
 * Pure. The UTC day number whose start is the cutoff for a window of `windowDays`: the `windowDays`-th
 * most recent day of `days` that is at most `todayDay`; `todayDay + 1` for `windowDays` = 0; null when
 * there are fewer than `windowDays` such days. Same preconditions as countActiveDaysAfter.
 */
export function activeDayCutoff(days: readonly number[], windowDays: number, todayDay: number): number | null {
  if (windowDays === 0) return todayDay + 1;
  const upToToday = upperBound(days, todayDay);
  return upToToday < windowDays ? null : days[upToToday - windowDays]!;
}

async function sessionDaysByProject(kv: StateKV): Promise<Map<string, Set<number>>> {
  const found = new Map<string, Set<number>>();
  for await (const page of kv.iterate<Session>(KV.sessions)) {
    for (const session of page) {
      const day = dayOf(new Date(session.startedAt));
      if (typeof session.project !== "string" || !Number.isFinite(day)) continue;
      const set = found.get(session.project) ?? new Set<number>();
      set.add(day);
      found.set(session.project, set);
    }
  }
  return found;
}

export async function loadActiveClock(kv: StateKV, now: () => Date): Promise<ActiveClock> {
  const todayDay = dayOf(now());
  const merged = new Map<string, readonly number[]>();
  const fromSessions = [...(await sessionDaysByProject(kv))];
  const storedLists = await kv.getMany<number[]>(RETENTION_KV.activeDays, fromSessions.map(([project]) => project));
  for (const [i, [project, fresh]] of fromSessions.entries()) {
    const read = storedLists[i];
    const stored = Array.isArray(read) ? read : [];
    const days = [...new Set([...stored, ...fresh])].sort((a, b) => a - b);
    if (days.length !== stored.length) await kv.set(RETENTION_KV.activeDays, project, days);
    merged.set(project, days);
  }
  const daysOf = (project: string): readonly number[] => merged.get(project) ?? [];
  return {
    activeDaysSince(project, since) {
      const sinceDay = dayOf(since);
      return Number.isFinite(sinceDay) ? countActiveDaysAfter(daysOf(project), sinceDay, todayDay) : 0;
    },
    cutoffForActiveDays(project, days) {
      const cutoffDay = activeDayCutoff(daysOf(project), days, todayDay);
      return new Date(cutoffDay === null ? 0 : cutoffDay * MS_PER_DAY);
    },
  };
}

import type { StateKV } from "../../state/kv.js";

/**
 * The project-active clock (design 6): age counts only days on which the item's project had a session.
 *
 * The design says to read it from the project's session index, but `mem:idx:project-sessions` keeps only
 * the 50 newest sessions per project (session-index.ts), too few to measure 180 or 365 active days. So the
 * sweep keeps its own `mem:retention:active-days` (project -> sorted UTC day numbers), refreshed from one
 * paged pass over mem:sessions per sweep (ids and dates only). A few hundred numbers per project.
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

/**
 * Pure. `days` must be sorted ascending with no duplicates; the loader writes it that way and this does
 * not check, so an unsorted list gives an undefined count. Counts `d` with `sinceDay < d <= todayDay`.
 * An empty list gives 0.
 */
export function countActiveDaysAfter(days: readonly number[], sinceDay: number, todayDay: number): number {
  void days;
  void sinceDay;
  void todayDay;
  // TODO: binary search for the first day > sinceDay and the first day > todayDay; return the difference.
  throw new Error("not implemented");
}

/**
 * Pure. The UTC day number whose start is the cutoff for a window of `windowDays`: the `windowDays`-th
 * most recent day of `days` that is at most `todayDay`; `todayDay + 1` for `windowDays` = 0; null when
 * there are fewer than `windowDays` such days. Same preconditions as countActiveDaysAfter.
 */
export function activeDayCutoff(days: readonly number[], windowDays: number, todayDay: number): number | null {
  void days;
  void windowDays;
  void todayDay;
  throw new Error("not implemented");
}

export function loadActiveClock(kv: StateKV, now: () => Date): Promise<ActiveClock> {
  void kv;
  void now;
  throw new Error("not implemented");
}

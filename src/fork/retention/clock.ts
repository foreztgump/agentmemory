import type { StateKV } from "../../state/kv.js";

/**
 * The project-active clock (design 6): age counts only days on which the item's project had a session.
 *
 * The design says to read it from the project's session index, but `mem:idx:project-sessions` keeps only
 * the 50 newest sessions per project (session-index.ts), too few to measure 180 or 365 active days. So the
 * sweep keeps its own `mem:retention:active-days` (project -> sorted UTC day numbers), refreshed from one
 * paged pass over mem:sessions per sweep (ids and dates only). A few hundred numbers per project.
 */
export interface ActiveClock {
  /** Number of distinct active days of `project` after `since` and up to now. */
  activeDaysSince(project: string, since: Date): number;
}

/** Pure: days is sorted ascending. */
export function countActiveDaysAfter(days: readonly number[], sinceDay: number): number {
  void days;
  void sinceDay;
  // TODO: binary search for the first day > sinceDay; return days.length - index.
  throw new Error("not implemented");
}

export function loadActiveClock(kv: StateKV): Promise<ActiveClock> {
  void kv;
  throw new Error("not implemented");
}

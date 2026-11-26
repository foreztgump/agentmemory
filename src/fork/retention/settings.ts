import type { Windows } from "./types.js";

/**
 * Parsed once at boot from env. A stack is `on` only when every window and the grace period are set:
 * an undecided stack has no windows to run with, so retention there does nothing (R15, buddy today).
 *
 *   AM_RETENTION=enforce|off                         (default off; the kill switch, design 7.8)
 *   AM_RETENTION_WINDOWS=trim:45,obs:180,sup:180,cold:365   project-active days (D1)
 *   AM_RETENTION_GRACE_DAYS=30                       (D2)
 *   AM_RETENTION_RECALL_CASES=/path/cases.json       golden recall cases (D5); none means report-only
 *   AM_RETENTION_INTERVAL_MS=604800000               weekly (D11); 0 = manual only
 */
export type RetentionSettings =
  | { readonly mode: "off"; readonly why: string }
  | {
      readonly mode: "enforce";
      readonly windows: Windows;
      readonly graceDays: number;
      /** recall@10 points a run may lose before it restores itself (D5: 2). */
      readonly recallStopPoints: number;
      /** First enforcing run moves at most this share of observations (design 7.5). */
      readonly firstRunObservationShare: number;
      readonly recallCasesPath: string | null;
      readonly intervalMs: number;
    };

/** Fixed, not configurable: rows per paged read (the sweep's memory bound, R12), the pause between pages and the two protection thresholds below. */
export const RETENTION_PAGE_SIZE = 200;
export const RETENTION_PAGE_PAUSE_MS = 25;
/** Fixed protection threshold (design 6): a row with `importance` at or above it is never a candidate. */
export const RETENTION_IMPORTANCE_FLOOR = 8;
/** Fixed spill threshold (design 6): the cited-by-memory set moves to `RETENTION_KV.sweepScratch` above this many ids. */
export const RETENTION_SPILL_IDS = 500_000;

export function parseRetentionSettings(env: Record<string, string | undefined>): RetentionSettings {
  void env;
  // TODO: off unless AM_RETENTION=enforce AND AM_RETENTION_WINDOWS has all four keys AND
  //  AM_RETENTION_GRACE_DAYS is a whole number. Reject anything malformed with a logged reason
  //  (mode off, why) instead of falling back to defaults. Decimal integers only (^\d+$), as TEE-1169's settings.
  throw new Error("not implemented");
}

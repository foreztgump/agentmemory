import type { RetentionDeps } from "./satellites.js";
import type { Protector } from "./protect.js";
import type { ItemRef, RunId } from "./types.js";

export interface RestoreResult {
  readonly restored: number;
  /** Items whose live row had been rewritten since the move; the live row was kept, the entry dropped. */
  readonly keptLive: number;
  /** Items that had no stored vector; the re-embed loop fills them (expected 0 when vectors were readable). */
  readonly reembedNeeded: number;
}

/** Restores every entry of a run, paged; the run row records why. Audited (R13). Idempotent. */
export function restoreRun(deps: RetentionDeps, runId: RunId, why: string): Promise<RestoreResult> {
  void deps;
  void runId;
  void why;
  throw new Error("not implemented");
}

/**
 * Restores single items, located through mem:retention:items by `itemKey(ref)` (one point read each).
 * Includes demotes. Takes refs, not bare ids: observation ids can repeat across imported sessions.
 */
export function restoreItems(deps: RetentionDeps, refs: readonly ItemRef[], why: string): Promise<RestoreResult> {
  void deps;
  void refs;
  void why;
  throw new Error("not implemented");
}

export interface PurgeResult {
  readonly purged: number;
  /** Became protected during grace (pinned, newly cited) and went back instead of being purged. */
  readonly restoredBack: number;
  readonly runsEmptied: number;
}

/**
 * Daily: for runs whose closedAt is older than their grace period, page the vault. Re-judge protection
 * for each entry with `protect.recheck` (design 4.6); a protected one is reinstated. Otherwise: finalize
 * satellites (image ref once, access log, score, facets, embeddings), write the observation tombstone,
 * vault.take. An emptied run's vault scope is deleted and its row keeps the counts. Audited per run (R13).
 *
 * `protect` is built by the caller once per purge pass, `createProtector(kv, settings.windows, clock)`
 * with the current settings' windows (not each run's snapshot) and a clock loaded at `now`, so the re-check
 * sees the pins, citations and accesses of today. RunRow.graceDays only bounds which runs are visited.
 */
export function purgeExpired(deps: RetentionDeps, protect: Protector, now: Date): Promise<PurgeResult> {
  void deps;
  void protect;
  void now;
  throw new Error("not implemented");
}

import type { RetentionDeps } from "./satellites.js";
import type { RetentionSettings } from "./settings.js";
import type { RecallHarness } from "./recall-check.js";
import type { RunReport } from "./report.js";
import type { RunId, RunRow } from "./types.js";

export interface SweepRequest {
  readonly dryRun: boolean;
  /** Tests and staging only (R2, R5, R6 use zero windows); the REST layer does not accept it. */
  readonly windowsOverride?: RunRow["windows"];
  readonly graceDaysOverride?: number;
}

export type SweepResult =
  | { readonly kind: "off"; readonly why: string }
  | { readonly kind: "busy"; readonly heldBy: string }
  | { readonly kind: "done"; readonly runId: RunId; readonly outcome: RunRow["outcome"]; readonly report: RunReport };

/**
 * One run as a state machine over a persisted RunRow (seal, plan, check-before, apply, check-after,
 * settle, done):
 *   0. settings off -> { off } and nothing else (R15). Lease in mem:retention:control (heartbeat; a stale
 *      lease is taken over) plus an in-process keyed lock, so two sweeps never overlap.
 *   1. An unfinished run row -> recoverRun, then continue it from its phase and cursor (R12).
 *   2. seal: page mem:sessions, sealSession for each ended session; refresh the active-days clock.
 *   3. plan: stream planCandidates; every candidate goes through Protector.judge and into the report.
 *      Dry run stops here and writes the report (R1: no live write; only mem:retention:* bookkeeping).
 *   4. check-before: no golden cases -> outcome "refused", report only. Else score.
 *   5. apply: displace each Cleared item; persist the cursor after each batch; stop stage O at the run's
 *      observationCap (10% of observations on the stack's first enforcing run); pause between pages.
 *   6. check-after: harness.settle(), score, judgeRecall. "restore" -> restoreRun with the reason (R9).
 *   7. settle and done: write report, one audit entry per stage (R13), release the lease.
 */
export function runSweep(deps: RetentionDeps, settings: RetentionSettings, harness: RecallHarness, req: SweepRequest): Promise<SweepResult> {
  void deps;
  void settings;
  void harness;
  void req;
  throw new Error("not implemented");
}

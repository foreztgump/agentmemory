import type { RetentionDeps } from "./satellites.js";
import type { RetentionSettings } from "./settings.js";
import type { RecallHarness } from "./recall-check.js";
import type { RunReport } from "./report.js";
import type { FinalOutcome, RunId, RunRow } from "./types.js";

export interface SweepRequest {
  readonly dryRun: boolean;
  /** Tests and staging only (R2, R5, R6 use zero windows); the REST layer does not accept it. */
  readonly windowsOverride?: RunRow["windows"];
  readonly graceDaysOverride?: number;
}

export type SweepResult =
  | { readonly kind: "off"; readonly why: string }
  | { readonly kind: "busy"; readonly heldBy: string }
  | { readonly kind: "done"; readonly runId: RunId; readonly outcome: FinalOutcome; readonly report: RunReport };

/**
 * One run as a state machine over a persisted RunRow (seal, plan, check-before, apply, settle,
 * check-after, done). Settle comes before check-after: the recall check must read an index the docs
 * outbox has drained, or disk-mode removals not yet landed skew the keep or restore verdict:
 *   0. settings off -> { off } and nothing else (R15). Lease in mem:retention:control (heartbeat; a stale
 *      lease is taken over) plus an in-process keyed lock, so two sweeps never overlap.
 *   1. An unfinished run row -> recoverRun, then continue it from its phase and cursor (R12).
 *   2. seal: page mem:sessions, sealSession for each ended session; refresh the active-days clock.
 *   3. plan: stream planCandidates; every candidate goes through Protector.judge and into the report.
 *      Dry run stops here and writes the report (R1: no live write; only mem:retention:* bookkeeping).
 *   4. check-before: no golden cases -> outcome "refused", report only. Else score.
 *   5. apply: displace each Cleared item; persist the cursor after each batch; stop stage O at the run's
 *      observationCap (10% of observations on the stack's first enforcing run); pause between pages.
 *   6. settle: harness.settle() drains the docs outbox so the removals have landed.
 *   7. check-after: score, judgeRecall. "restore" -> restoreRun with the reason (R9), then settle once more
 *      so the restored docs have landed before the run closes.
 *   8. done: write report, one audit entry per stage (R13), release the lease. The outcome is final
 *      (FinalOutcome); a run that is not done keeps outcome "running".
 */
export function runSweep(deps: RetentionDeps, settings: RetentionSettings, harness: RecallHarness, req: SweepRequest): Promise<SweepResult> {
  void deps;
  void settings;
  void harness;
  void req;
  throw new Error("not implemented");
}

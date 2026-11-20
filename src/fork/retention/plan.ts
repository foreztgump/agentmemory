import type { StateKV } from "../../state/kv.js";
import type { ActiveClock } from "./clock.js";
import type { Candidate } from "./protect.js";
import type { Cursor, Windows } from "./types.js";

/**
 * The plan is a stream, never a stored list (graft from the sonnet candidate): dry run, report, apply and
 * resume all read the same generator, and a resumed run recomputes it from `cursor`. Memory held at any
 * time: one session's rows (at most MAX_OBS_PER_SESSION, 5000 under D9) or one page of memories.
 *
 * Order: T and O per sealed session (paged over mem:retention:seals), then S, X, C (paged over
 * mem:memories). Yields a batch per unit plus the cursor that is safe to persist after the batch is applied.
 *
 *  T  rows older than trimDays (active clock) whose `source` is not already truncated
 *  O  rows older than observationDays; graph-cited rows yielded last within the session
 *  S  isLatest=false, successor resolved (ChainProof), stopped being latest more than supersededDays ago
 *  X  forgetAfter in the past (soft delete, then grace, instead of auto-forget's hard delete)
 *  C  latest, retention score below cold, no access for coldDays, not architecture/preference
 */
export interface PlanBatch {
  readonly candidates: readonly Candidate[];
  readonly cursorAfter: Cursor;
}

export function planCandidates(kv: StateKV, clock: ActiveClock, windows: Windows, from: Cursor | null): AsyncGenerator<PlanBatch> {
  void kv;
  void clock;
  void windows;
  void from;
  throw new Error("not implemented");
}

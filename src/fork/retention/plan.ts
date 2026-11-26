import type { StateKV } from "../../state/kv.js";
import type { ActiveClock } from "./clock.js";
import type { Candidate } from "./protect.js";
import type { Cursor, Windows } from "./types.js";

/**
 * The plan is a stream, never a stored list (graft from the sonnet candidate): dry run, report, apply and
 * resume all read the same generator, and a resumed run recomputes it from `cursor`.
 *
 * Memory held at any time: one page (RETENTION_PAGE_SIZE) of rows or memories, plus, while paging a
 * session, that session's row keys (ids only). No session is assumed small. MAX_OBS_PER_SESSION gates only
 * native captures; imported sessions (jsonl replay, export import) bypass it, and MAX_IMPORT_OBS_PER_SESSION
 * only limits an export import. So a session unit is walked in pages whatever its size, and a batch
 * is a page of one session, not the whole session.
 *
 * Order: T and O per sealed session (paged over mem:retention:seals, each session paged by sorted row key),
 * then S, X, C (paged over mem:memories). Yields a batch per page plus the cursor that is safe to persist
 * after the batch is applied. Within a session the uncited pages come first and the graph-cited rows
 * second (`Cursor.within.pass`), so cited rows go last.
 *
 *  T  rows older than trimDays (active clock) whose `source` is not already truncated
 *  O  rows older than observationDays
 *  S  isLatest=false, successor resolved (ChainProof), stopped being latest more than supersededDays ago
 *  X  forgetAfter in the past (soft delete, then grace, instead of auto-forget's hard delete)
 *  C  latest, retention score below cold, no access for coldDays, not architecture/preference
 * "Older than" is the clock's rule (clock.ts): active-day age at least the window.
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

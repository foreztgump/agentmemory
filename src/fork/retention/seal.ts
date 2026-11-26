import type { StateKV } from "../../state/kv.js";
import type { Session, SessionSummary } from "../../types.js";
import type { SealProof } from "./protect.js";
import type { SessionSeal } from "./types.js";

export type SealRefusal =
  | "active"
  | "recent-capture"
  | "no-summary"
  | "summary-out-of-date"
  | "compression-pending";

/**
 * What `judgeSeal` needs to know about a session's rows, gathered by one paged pass (`readSessionFacts`),
 * so no caller holds a session's rows. Imported sessions bypass MAX_OBS_PER_SESSION and can be large.
 */
export interface SessionRowFacts {
  /** Rows that count toward the summary: those with a title (summary-state.ts `summaryObservations`). */
  readonly summaryRowCount: number;
  /**
   * Byte-for-byte what `summaryFingerprint(session, summaryObservations(rows))` returns, computed by
   * hashing the same JSON in pieces, page by page, in the summary's order (compressedAt or timestamp,
   * then id). Only (id, sort time) per row is held, never the rows.
   */
  readonly summaryFingerprint: string;
  /** Latest row timestamp, null for a session with no rows. */
  readonly lastObservationAt: string | null;
  /** False while any row still awaits LLM compression. */
  readonly allCompressed: boolean;
}

/**
 * Pure. Design 3.1: a session seals when it ended (completed or abandoned), its last observation is more
 * than a day old, the summary covers the rows (`summary.coveredFingerprint` equals `facts.summaryFingerprint`
 * and `summary.observationCount` equals `facts.summaryRowCount`, the rule of `summaryCovers` applied to the
 * facts), and every row finished compression (or the stack has no LLM compression, true on both stacks
 * today). A session without a summary never seals, so a stack with no LLM provider never deletes
 * observations (reported as undigested backlog).
 *
 * An existing seal whose fingerprint no longer matches is dropped, unless `trimmed` is set: then the
 * stored summary is the digest of record (D10) and the seal stands.
 */
export function judgeSeal(
  session: Session,
  facts: SessionRowFacts,
  summary: SessionSummary | null,
  existing: SessionSeal | null,
  opts: { now: Date; llmCompression: boolean },
): { kind: "sealed"; proof: SealProof } | { kind: "refused"; why: SealRefusal } {
  void session;
  void facts;
  void summary;
  void existing;
  void opts;
  throw new Error("not implemented");
}

/**
 * One paged pass over a session's rows: row keys first, then values in pages of RETENTION_PAGE_SIZE.
 * Memory is one page plus one (id, sort time) pair per row, whatever the session's size.
 */
export function readSessionFacts(kv: StateKV, session: Session): Promise<SessionRowFacts> {
  void kv;
  void session;
  throw new Error("not implemented");
}

/** Reads one session through `readSessionFacts` (paged, never a whole-session list), judges it and writes or drops its seal. */
export function sealSession(kv: StateKV, sessionId: string, opts: { now: Date; llmCompression: boolean }): Promise<ReturnType<typeof judgeSeal>> {
  void kv;
  void sessionId;
  void opts;
  throw new Error("not implemented");
}

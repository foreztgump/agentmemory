import type { StateKV } from "../../state/kv.js";
import type { CompressedObservation, Session, SessionSummary } from "../../types.js";
import type { SealProof } from "./protect.js";
import type { SessionSeal } from "./types.js";

export type SealRefusal =
  | "active"
  | "recent-capture"
  | "no-summary"
  | "summary-out-of-date"
  | "compression-pending";

/**
 * Pure. Design 3.1: a session seals when it ended (completed or abandoned), its last observation is more
 * than a day old, `summaryCovers(session, rows, summary)` holds, and every row finished compression (or
 * the stack has no LLM compression, true on both stacks today). A session without a summary never seals,
 * so a stack with no LLM provider never deletes observations (reported as undigested backlog).
 *
 * An existing seal whose fingerprint no longer matches is dropped, unless `trimmed` is set: then the
 * stored summary is the digest of record (D10) and the seal stands.
 */
export function judgeSeal(
  session: Session,
  rows: readonly CompressedObservation[],
  summary: SessionSummary | null,
  existing: SessionSeal | null,
  opts: { now: Date; llmCompression: boolean },
): { kind: "sealed"; proof: SealProof } | { kind: "refused"; why: SealRefusal } {
  void session;
  void rows;
  void summary;
  void existing;
  void opts;
  throw new Error("not implemented");
}

/** Reads one session (rows are capped per session, so a list is fine), judges it and writes or drops its seal. */
export function sealSession(kv: StateKV, sessionId: string, opts: { now: Date; llmCompression: boolean }): Promise<ReturnType<typeof judgeSeal>> {
  void kv;
  void sessionId;
  void opts;
  throw new Error("not implemented");
}

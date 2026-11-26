import { createHash } from "node:crypto";
import { needsCompression, type StoredObservation } from "../../functions/compression-state.js";
import type { StateKV } from "../../state/kv.js";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import { KV } from "../../state/schema.js";
import type { CompressedObservation, Session, SessionSummary } from "../../types.js";
import type { SealProof } from "./protect.js";
import { MS_PER_DAY } from "./clock.js";
import { RETENTION_KV } from "./scopes.js";
import { RETENTION_PAGE_SIZE } from "./settings.js";
import type { SessionSeal } from "./types.js";

export type SealRefusal =
  | "active"
  | "recent-capture"
  | "no-summary"
  | "summary-out-of-date"
  | "compression-pending"
  | "no-session";

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
   * then id). Only (id, sort time) per row is held, never the rows. Empty when a row changed or vanished
   * between the pass that orders the rows and the pass that hashes them: it then matches no summary.
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
 * An existing seal is dropped on any refusal (active, recent capture, out of date, compression pending),
 * unless `trimmed` is set: then the stored summary is the digest of record (D10) and the seal stands. A seal that still matches stands
 * as it is, so sealing twice keeps the first `sealedAt`. `graphExtracted` is written false: nothing
 * records that graph extraction ran, and nothing reads the flag yet.
 */
export function judgeSeal(
  session: Session,
  facts: SessionRowFacts,
  summary: SessionSummary | null,
  existing: SessionSeal | null,
  opts: { now: Date; llmCompression: boolean },
): { kind: "sealed"; proof: SealProof } | { kind: "refused"; why: SealRefusal } {
  if (existing?.trimmed) return { kind: "sealed", proof: { seal: existing } };
  if (session.status === "active") return { kind: "refused", why: "active" };
  if (facts.lastObservationAt !== null && !(opts.now.getTime() - Date.parse(facts.lastObservationAt) > MS_PER_DAY)) {
    return { kind: "refused", why: "recent-capture" };
  }
  if (!summary) return { kind: "refused", why: "no-summary" };
  const covers = Boolean(summary.coveredFingerprint) && summary.coveredFingerprint === facts.summaryFingerprint
    && summary.observationCount === facts.summaryRowCount;
  if (!covers) return { kind: "refused", why: "summary-out-of-date" };
  if (opts.llmCompression && !facts.allCompressed) return { kind: "refused", why: "compression-pending" };
  if (existing && existing.summaryFingerprint === facts.summaryFingerprint && existing.observationCount === facts.summaryRowCount) {
    return { kind: "sealed", proof: { seal: existing } };
  }
  const seal: SessionSeal = {
    sessionId: session.id,
    sealedAt: opts.now.toISOString(),
    summaryFingerprint: facts.summaryFingerprint,
    observationCount: facts.summaryRowCount,
    graphExtracted: false,
    trimmed: false,
  };
  return { kind: "sealed", proof: { seal } };
}

interface RowOrder {
  readonly key: string;
  readonly id: string;
  readonly sortAt: string;
}

const sortTime = (row: CompressedObservation): string => row.compressedAt ?? row.timestamp;

async function* rowPages(kv: StateKV, scope: string, keys: readonly string[]): AsyncGenerator<Array<CompressedObservation | null>> {
  for (let start = 0; start < keys.length; start += RETENTION_PAGE_SIZE) {
    const slice = keys.slice(start, start + RETENTION_PAGE_SIZE);
    const rows = await kv.getMany<CompressedObservation>(scope, slice);
    if (rows.length !== slice.length) throw new Error(`getMany returned ${rows.length} values for ${slice.length} keys in ${scope}`);
    yield rows;
  }
}

/**
 * One paged pass over a session's rows: row keys first, then values in pages of RETENTION_PAGE_SIZE.
 * Memory is one page plus one (id, sort time) pair per row, whatever the session's size.
 *
 * Pass one reads every row for its timestamp, its compression state and its place in the summary's
 * order. Pass two reads the summarised rows again in that order and hashes the JSON `summaryFingerprint`
 * would build, in pieces: the opening of the array, each row's inner array, the closing.
 */
export async function readSessionFacts(kv: StateKV, session: Session): Promise<SessionRowFacts> {
  const scope = KV.observations(session.id);
  const keys = await kv.listKeys(scope);
  const ordered: RowOrder[] = [];
  let lastObservationAt: string | null = null;
  let allCompressed = true;
  let page = 0;
  for await (const rows of rowPages(kv, scope, keys)) {
    for (const [i, row] of rows.entries()) {
      if (!row) continue;
      if (lastObservationAt === null || row.timestamp > lastObservationAt) lastObservationAt = row.timestamp;
      if (needsCompression(row as StoredObservation)) allCompressed = false;
      if (row.title) ordered.push({ key: keys[page * RETENTION_PAGE_SIZE + i]!, id: row.id, sortAt: sortTime(row) });
    }
    page++;
  }
  ordered.sort((a, b) => a.sortAt.localeCompare(b.sortAt) || a.id.localeCompare(b.id));

  const hash = createHash("sha256");
  const opening = JSON.stringify([session.id, session.project, session.cwd, session.agentId, session.startedAt]);
  hash.update(`${opening.slice(0, -1)},[`);
  let stable = true;
  let written = 0;
  pages: for await (const rows of rowPages(kv, scope, ordered.map((r) => r.key))) {
    for (const [i, row] of rows.entries()) {
      const expected = ordered[written + i]!;
      if (!row || !row.title || row.id !== expected.id || sortTime(row) !== expected.sortAt) {
        stable = false;
        break pages;
      }
      hash.update(`${written + i > 0 ? "," : ""}${JSON.stringify([row.id, row.type, row.title, row.narrative, row.facts, row.files, row.concepts])}`);
    }
    written += rows.length;
  }
  hash.update("]]");
  return {
    summaryRowCount: ordered.length,
    summaryFingerprint: stable ? hash.digest("hex") : "",
    lastObservationAt,
    allCompressed,
  };
}

/**
 * Reads one session through `readSessionFacts` (paged, never a whole-session list), judges it and writes or drops its seal,
 * under the `obs:<sessionId>` lock summarize publishes under, so the seal is judged against one summary and one set of rows.
 */
export function sealSession(kv: StateKV, sessionId: string, opts: { now: Date; llmCompression: boolean }): Promise<ReturnType<typeof judgeSeal>> {
  return withKeyedLock(`obs:${sessionId}`, () => judgeAndStoreSeal(kv, sessionId, opts));
}

async function judgeAndStoreSeal(kv: StateKV, sessionId: string, opts: { now: Date; llmCompression: boolean }): Promise<ReturnType<typeof judgeSeal>> {
  const [session, summary, existing] = await Promise.all([
    kv.get<Session>(KV.sessions, sessionId),
    kv.get<SessionSummary>(KV.summaries, sessionId),
    kv.get<SessionSeal>(RETENTION_KV.seals, sessionId),
  ]);
  if (!session) return { kind: "refused", why: "no-session" };
  const verdict = judgeSeal(session, await readSessionFacts(kv, session), summary, existing, opts);
  if (verdict.kind === "refused") {
    if (existing) await kv.delete(RETENTION_KV.seals, sessionId);
  } else if (verdict.proof.seal !== existing) {
    await kv.set(RETENTION_KV.seals, sessionId, verdict.proof.seal);
  }
  return verdict;
}

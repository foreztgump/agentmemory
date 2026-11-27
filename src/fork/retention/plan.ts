import { logger } from "../../logger.js";
import { createGraphIndexReader, type GraphIndexReader } from "../../state/graph-retrieval-index.js";
import type { StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import type { CompressedObservation, Memory, RetentionScore, Session } from "../../types.js";
import type { ActiveClock } from "./clock.js";
import type { Candidate, ChainProof, SealProof } from "./protect.js";
import { RETENTION_KV } from "./scopes.js";
import { RETENTION_COLD_SCORE, RETENTION_PAGE_SIZE } from "./settings.js";
import type { Cursor, SessionSeal, Stage, Windows } from "./types.js";

/**
 * The plan is a stream, never a stored list (graft from the sonnet candidate): dry run, report, apply and
 * resume all read the same generator, and a resumed run recomputes it from `cursor`.
 *
 * Memory held at any time: one page (RETENTION_PAGE_SIZE) of rows or memories, plus the sorted key list of
 * the unit being walked (ids only: the sealed sessions, one session's rows, the memories) and, for stage S, the
 * successor map of the memories that replaced another (a few hundred entries). No session is assumed small.
 * MAX_OBS_PER_SESSION gates only native captures; imported sessions (jsonl replay, export import) bypass it, and
 * MAX_IMPORT_OBS_PER_SESSION only limits an export import. So a session unit is walked in pages whatever its
 * size, and a batch is a page of one session, not the whole session.
 *
 * Order: T and O per sealed session (paged over mem:retention:seals in key order, each session in row-key order),
 * then S, X, C (paged over mem:memories in key order). Yields a batch per page, empty ones included, plus the
 * cursor that is safe to persist after the batch is applied. Within a session the uncited pages come first and the
 * graph-cited stage O rows second (`Cursor.within.pass`), so cited rows go last.
 *
 * The seal is read as stored: the sweep's seal phase has just judged it. `displace` re-reads each row, so a row
 * rewritten since is skipped, and a session whose summary moved on since is caught by the next seal phase.
 *
 *  O  rows older than observationDays (a row also older than trimDays is one O candidate, not a T and an O)
 *  T  rows older than trimDays whose `source` is not already truncated
 *  X  forgetAfter in the past, whatever isLatest says (soft delete, then grace, instead of auto-forget's hard delete)
 *  S  isLatest=false, successor resolved (ChainProof), stopped being latest (`updatedAt`) more than supersededDays ago
 *  C  latest, older than coldDays, retention score below RETENTION_COLD_SCORE (a memory with no score is never cold).
 *     Type, deliberate saves and access are the Protector's signals, so the report counts them.
 * "Older than" is the clock's cutoff rule (clock.ts): `t < clock.cutoffForActiveDays(project, days)`. A memory
 * with no `project` reads the clock of project "", which has no active days, so only a zero window ages it.
 */
export interface PlanBatch {
  readonly candidates: readonly Candidate[];
  readonly cursorAfter: Cursor;
}

type ObservationRef = Extract<Candidate["ref"], { kind: "observation" }>;

const sortedKeys = async (kv: StateKV, scope: string): Promise<string[]> => (await kv.listKeys(scope)).sort();
const after = (keys: readonly string[], last: string | null): string[] => (last === null ? [...keys] : keys.filter((key) => key > last));

export async function* planCandidates(kv: StateKV, clock: ActiveClock, windows: Windows, from: Cursor | null, now: Date): AsyncGenerator<PlanBatch> {
  if (from?.unit !== "memories") {
    yield* planSessions(kv, clock, windows, from);
    from = null;
  }
  yield* planMemories(kv, clock, windows, from?.after ?? null, now);
}

async function* planSessions(kv: StateKV, clock: ActiveClock, windows: Windows, from: Cursor | null): AsyncGenerator<PlanBatch> {
  let done = from?.after ?? null;
  let resume = from?.within;
  for (const sessionId of after(await sortedKeys(kv, RETENTION_KV.seals), done)) {
    const [seal, session] = await Promise.all([kv.get<SessionSeal>(RETENTION_KV.seals, sessionId), kv.get<Session>(KV.sessions, sessionId)]);
    if (seal && session) yield* planSession(kv, clock, windows, { seal, project: session.project }, done, resume);
    done = sessionId;
    resume = undefined;
  }
  yield { candidates: [], cursorAfter: { unit: "memories", after: null } };
}

async function* planSession(
  kv: StateKV,
  clock: ActiveClock,
  windows: Windows,
  session: { readonly seal: SessionSeal; readonly project: string },
  done: string | null,
  resume: Cursor["within"],
): AsyncGenerator<PlanBatch> {
  const { seal, project } = session;
  const scope = KV.observations(seal.sessionId);
  const keys = await sortedKeys(kv, scope);
  const proof: SealProof = { seal };
  const cutoffs = { O: clock.cutoffForActiveDays(project, windows.observationDays), T: clock.cutoffForActiveDays(project, windows.trimDays) };
  const eligible = (row: CompressedObservation): "T" | "O" | null => {
    const at = Date.parse(row.timestamp);
    if (Number.isNaN(at)) return null;
    if (at < cutoffs.O.getTime()) return "O";
    return at < cutoffs.T.getTime() && row.source && !row.source.truncated ? "T" : null;
  };
  // One verdict per id for both passes, so a graph change between them cannot yield a row twice. At most one entry per row key.
  const verdicts = new Map<string, boolean>();
  const citedOf = async (ids: readonly string[]): Promise<ReadonlySet<string>> => {
    const unread = ids.filter((id) => !verdicts.has(id));
    if (unread.length > 0) {
      const fresh = await graphCitedIds(kv, unread);
      for (const id of unread) verdicts.set(id, fresh.has(id));
    }
    return new Set(ids.filter((id) => verdicts.get(id)));
  };
  for (const pass of ["uncited", "graph-cited"] as const) {
    if (resume?.pass === "graph-cited" && pass === "uncited") continue;
    let last = resume?.pass === pass ? resume.afterRowId : null;
    const rest = after(keys, last);
    for (let start = 0; start < rest.length; start += RETENTION_PAGE_SIZE) {
      const slice = rest.slice(start, start + RETENTION_PAGE_SIZE);
      const planned = (await kv.getMany<CompressedObservation>(scope, slice)).flatMap((row) => {
        const stage = row ? eligible(row) : null;
        return row && stage ? [{ row, stage }] : [];
      });
      const cited = await citedOf(planned.filter((p) => p.stage === "O").map((p) => p.row.id));
      const candidates = planned.filter((p) => cited.has(p.row.id) === (pass === "graph-cited")).map(({ row, stage }): Candidate => {
        const ref: ObservationRef = { kind: "observation", sessionId: seal.sessionId, id: row.id };
        const window = stage === "O" ? windows.observationDays : windows.trimDays;
        const reason = { stage, ageActiveDays: clock.activeDaysSince(project, new Date(row.timestamp)), note: `older than ${window} active days` };
        return { project, stage, ref, row, proof, reason, ...(cited.has(row.id) ? { graphCited: true as const } : {}) };
      });
      last = slice.at(-1)!;
      yield { candidates, cursorAfter: { unit: "sessions", after: done, within: { pass, afterRowId: last } } };
    }
  }
}

const GRAPH_CHUNK = 100;

/**
 * Ids that a graph node or edge cites, by two posting reads each. `createGraphIndexReader` caps its reads, so
 * a chunk of GRAPH_CHUNK ids gets its own reader. An index that is not ready (a null reader) cites nothing. Any
 * other failure, a reader that cannot be created, a read that fails or one that runs out of budget, counts as
 * cited, which only moves the row later in the plan.
 */
export async function graphCitedIds(kv: StateKV, ids: readonly string[]): Promise<ReadonlySet<string>> {
  const cited = new Set<string>();
  for (let start = 0; start < ids.length; start += GRAPH_CHUNK) {
    const chunk = ids.slice(start, start + GRAPH_CHUNK);
    let reader: GraphIndexReader | null;
    try {
      reader = await createGraphIndexReader(kv);
    } catch (err) {
      logger.warn("graph index reader failed, counting the chunk as cited", { ids: chunk.length, error: err instanceof Error ? err.message : String(err) });
      for (const id of chunk) cited.add(id);
      continue;
    }
    if (!reader) continue;
    for (const id of chunk) {
      try {
        const [nodes, edges] = await Promise.all([reader.posting("observation", id, { limit: 1 }), reader.posting("edgeObservation", id, { limit: 1 })]);
        if (nodes.total > 0 || edges.total > 0 || reader.exhausted) cited.add(id);
      } catch {
        cited.add(id);
      }
    }
  }
  return cited;
}

async function* planMemories(kv: StateKV, clock: ActiveClock, windows: Windows, done: string | null, now: Date): AsyncGenerator<PlanBatch> {
  const rest = after(await sortedKeys(kv, KV.memories), done);
  let successors: ReadonlyMap<string, string> | null = null;
  const older = (project: string, at: string, days: number): boolean => Date.parse(at) < clock.cutoffForActiveDays(project, days).getTime();
  const reasonOf = (stage: Stage, project: string, at: string, days: number | null) => ({
    stage, ageActiveDays: clock.activeDaysSince(project, new Date(at)), note: days === null ? "forgetAfter has passed" : `older than ${days} active days`,
  });
  for (let start = 0; start < rest.length; start += RETENTION_PAGE_SIZE) {
    const slice = rest.slice(start, start + RETENTION_PAGE_SIZE);
    const rows = (await kv.getMany<Memory>(KV.memories, slice)).filter((row): row is Memory => row !== null);
    const scores = await kv.getMany<RetentionScore>(KV.retentionScores, rows.filter((m) => m.isLatest).map((m) => m.id));
    const scoreOf = new Map(rows.filter((m) => m.isLatest).map((m, i) => [m.id, scores[i]?.score]));
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const project = row.project ?? "";
      const ref = { kind: "memory" as const, id: row.id };
      if (row.forgetAfter && Date.parse(row.forgetAfter) < now.getTime()) {
        candidates.push({ project, stage: "X", ref, row, reason: reasonOf("X", project, row.forgetAfter, null) });
      } else if (row.isLatest === false && older(project, row.updatedAt, windows.supersededDays)) {
        successors ??= await successorIndex(kv);
        const proof = await proveChain(kv, row, successors);
        if (proof) candidates.push({ project, stage: "S", ref, row, proof, reason: reasonOf("S", project, row.updatedAt, windows.supersededDays) });
      } else if (row.isLatest && older(project, row.createdAt, windows.coldDays) && (scoreOf.get(row.id) ?? Infinity) < RETENTION_COLD_SCORE) {
        candidates.push({ project, stage: "C", ref, row, reason: reasonOf("C", project, row.createdAt, windows.coldDays) });
      }
    }
    yield { candidates, cursorAfter: { unit: "memories", after: slice.at(-1)! } };
  }
}

/** Old id to the id of the best row that lists it as `parentId` or in `supersedes`: highest version, then newest. Only rows that replace another are held. */
export async function successorIndex(kv: StateKV): Promise<ReadonlyMap<string, Memory["id"]>> {
  const best = new Map<string, Memory>();
  for await (const page of kv.iterate<Memory>(KV.memories)) {
    for (const row of page) {
      for (const id of new Set([...(row?.supersedes ?? []), ...(row?.parentId ? [row.parentId] : [])])) {
        const held = best.get(id);
        if (row && (!held || (row.version ?? 1) > (held.version ?? 1) || ((row.version ?? 1) === (held.version ?? 1) && row.createdAt > held.createdAt))) best.set(id, row);
      }
    }
  }
  return new Map([...best].map(([id, row]) => [id, row.id]));
}

const strictlyNewer = (next: Memory, current: Memory): boolean =>
  (next.version ?? 1) > (current.version ?? 1) && Date.parse(next.createdAt) >= Date.parse(current.createdAt);

/**
 * Stage S proof (design 5.4): follow the successors of a superseded memory to the row that is latest, and
 * accept it only when every hop is a strictly newer row (a higher version, no earlier `createdAt`). The
 * version rises on every hop, so a chain that loops back cannot resolve and the walk ends. A missing
 * successor, a stale one or a chain that never reaches a latest row gives null, and the memory is not a candidate.
 */
export async function proveChain(kv: StateKV, row: Memory, successors: ReadonlyMap<string, string>): Promise<ChainProof | null> {
  let current = row;
  for (;;) {
    const nextId = successors.get(current.id);
    const next = nextId === undefined ? null : await kv.get<Memory>(KV.memories, nextId);
    if (!next || !strictlyNewer(next, current)) return null;
    if (next.isLatest) return { successorId: next.id } as ChainProof;
    current = next;
  }
}

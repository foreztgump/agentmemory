import { summaryFingerprint, summaryObservations } from "../../../src/functions/summary-state.js";
import { loadActiveClock } from "../../../src/fork/retention/clock.js";
import { displace } from "../../../src/fork/retention/move.js";
import { planCandidates, type PlanBatch } from "../../../src/fork/retention/plan.js";
import { createProtector, type Candidate, type Cleared, type Protector, type Verdict } from "../../../src/fork/retention/protect.js";
import { sealSession } from "../../../src/fork/retention/seal.js";
import { itemKey, RETENTION_KV, type Pin } from "../../../src/fork/retention/scopes.js";
import type { Cursor, ItemRef, Windows } from "../../../src/fork/retention/types.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation, Session, SessionSummary } from "../../../src/types.js";
import { NOW, observation, openRun, RUN, seedObservation, seedSession, type Rig } from "./move-fixtures.js";

export const ZERO: Windows = { trimDays: 0, observationDays: 0, supersededDays: 0, coldDays: 0 };

export const clockOf = (r: Rig) => loadActiveClock(r.kv, () => NOW);

export type SummaryKind = "covers" | "none" | "stale";

/**
 * A session with `count` rows, a summary of the given kind, and its seal judged by the real `sealSession`,
 * so a plan reads seals the sweep would have written.
 */
export async function sealedSession(
  r: Rig,
  id: string,
  count: number,
  opts: { summary?: SummaryKind; status?: Session["status"]; rows?: CompressedObservation[]; project?: string } = {},
): Promise<CompressedObservation[]> {
  await seedSession(r, id, { status: opts.status ?? "completed", ...(opts.project ? { project: opts.project } : {}) });
  const rows = opts.rows ?? Array.from({ length: count }, (_, i) => observation(`${id}_o${i}`, id));
  for (const row of rows) await seedObservation(r, row, { seed: undefined });
  const session = (await r.kv.get<Session>(KV.sessions, id))!;
  const kind = opts.summary ?? "covers";
  if (kind !== "none") {
    const covered = summaryObservations(kind === "stale" ? rows.slice(1) : rows);
    const summary: SessionSummary = {
      sessionId: id, project: session.project, createdAt: "2026-04-02T00:00:00.000Z", title: "summary", narrative: "a narrative that is long enough",
      keyDecisions: [], filesModified: [], concepts: [], observationCount: covered.length, coveredFingerprint: summaryFingerprint(session, covered),
    };
    await r.kv.set(KV.summaries, id, summary);
  }
  await sealSession(r.kv, id, { now: NOW, llmCompression: false });
  return rows;
}

export async function planAll(r: Rig, windows: Windows, from: Cursor | null = null): Promise<PlanBatch[]> {
  const batches: PlanBatch[] = [];
  for await (const batch of planCandidates(r.kv, await clockOf(r), windows, from, NOW)) batches.push(batch);
  return batches;
}

export const candidatesOf = (batches: readonly PlanBatch[]): Candidate[] => batches.flatMap((b) => [...b.candidates]);

export async function judgeAll(r: Rig, windows: Windows, candidates: readonly Candidate[], protector?: Protector) {
  const judge = protector ?? await createProtector(r.kv, windows, await clockOf(r));
  const verdicts: Verdict[] = [];
  for (const candidate of candidates) verdicts.push(await judge.judge(candidate));
  const cleared = verdicts.flatMap((v): Cleared[] => (v.kind === "clear" ? [v.item] : []));
  const protectedBy = Object.fromEntries(verdicts.flatMap((v) => (v.kind === "protected" ? [[itemKey(v.candidate.ref), v.signal]] : [])));
  return { judge, cleared, protectedBy };
}

/** The plan-and-move of an enforcing sweep: every cleared candidate is displaced, a stage C one is demoted. */
export async function planAndMove(r: Rig, windows: Windows = ZERO) {
  await openRun(r);
  const planned = candidatesOf(await planAll(r, windows));
  const outcome = await judgeAll(r, windows, planned);
  for (const item of outcome.cleared) await displace(r.deps, r.vault, RUN, item);
  return { planned, ...outcome };
}

export const pin = (r: Rig, ref: ItemRef): Promise<Pin> =>
  r.kv.set(RETENTION_KV.pins, itemKey(ref), { ref, who: "owner", reason: "test", pinnedAt: NOW.toISOString() });

export const liveIds = async (r: Rig, sessionId: string): Promise<string[]> => (await r.kv.listKeys(KV.observations(sessionId))).sort();

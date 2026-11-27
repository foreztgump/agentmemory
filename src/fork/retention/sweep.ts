import { randomUUID } from "node:crypto";
import { isAutoCompressEnabled } from "../../config.js";
import { safeAudit } from "../../functions/audit.js";
import { logger } from "../../logger.js";
import { generateId, KV } from "../../state/schema.js";
import type { Session } from "../../types.js";
import { sessionObservationTotals } from "../kv/observation-stats.js";
import { loadActiveClock, type ActiveClock } from "./clock.js";
import { demotedBy } from "./demote.js";
import { displace, recoverRun } from "./move.js";
import { planCandidates } from "./plan.js";
import { clearSweepScratch, createProtector, type Protector } from "./protect.js";
import { judgeRecall, type RecallHarness, type RecallJudgement, type RecallScore } from "./recall-check.js";
import { createReportBuilder, type RunReport } from "./report.js";
import { restoreRun } from "./restore.js";
import { newRunRow, RunStore } from "./run-store.js";
import type { RetentionDeps } from "./satellites.js";
import { RETENTION_KV } from "./scopes.js";
import { sealSession, type SealRefusal } from "./seal.js";
import { RETENTION_PAGE_PAUSE_MS, RETENTION_PAGE_SIZE, type RetentionSettings } from "./settings.js";
import { STAGE_DISPOSITION, type FinalOutcome, type Phase, type RunId, type RunRow, type Stage } from "./types.js";
import { Vault } from "./vault.js";

export interface SweepRequest {
  readonly dryRun: boolean;
  /** Tests and staging only (R2, R5, R6 use zero windows); the REST layer does not accept it. */
  readonly windowsOverride?: RunRow["windows"];
  readonly graceDaysOverride?: number;
  /** Tests only: the pause between moved pages, which is RETENTION_PAGE_PAUSE_MS otherwise. */
  readonly pauseMs?: number;
}

export type SweepResult =
  | { readonly kind: "off"; readonly why: string }
  | { readonly kind: "busy"; readonly heldBy: string }
  /** The heartbeat found the lease taken by another process. The run stays open, and the next sweep resumes it. */
  | { readonly kind: "lease-lost" }
  | { readonly kind: "done"; readonly runId: RunId; readonly outcome: FinalOutcome; readonly report: RunReport };

const STAGES: readonly Stage[] = ["T", "O", "S", "X", "C"];
const SWEEP_FUNCTION = "mem::retention-sweep";
/** `mem:retention:control` key: how many enforcing runs ended kept. The first one is capped (design 7.5). */
const ENFORCED_KEY = "enforced-runs";

type Enforce = Extract<RetentionSettings, { readonly mode: "enforce" }>;

class LeaseLost extends Error {}

interface Sweep {
  readonly deps: RetentionDeps;
  readonly settings: Enforce;
  readonly harness: RecallHarness;
  readonly runs: RunStore;
  readonly vault: Vault;
  readonly owner: string;
  readonly pauseMs: number;
  resumed: boolean;
  lost: boolean;
  unreadable: number;
  clock?: ActiveClock;
  protector?: Protector;
}

/**
 * One run as a state machine over a persisted RunRow (seal, plan, check-before, apply, settle, check-after,
 * done). Settle comes before check-after: the recall check must read an index the docs outbox has drained, or
 * disk-mode removals not yet landed skew the keep or restore verdict.
 *
 *   0. settings off -> { off }, with no read or write (R15). The lease in mem:retention:control admits one
 *      sweep at a time; it is heartbeated before every batch, and a sweep that finds it lost stops with
 *      `lease-lost`, leaving the run open.
 *   1. An unfinished enforcing run is resumed: `recoverRun`, then the scratch scope is cleared (release on a
 *      Protector that did not spill does nothing), then `held` and each stage's `moved` are recounted from the
 *      run's vault, since a crash can land between a move and the count. An unfinished dry run is closed, not
 *      resumed. A dry run never resumes or recovers anything.
 *   2. seal: every session through `sealSession`, with no lock held, right before the plan.
 *   3. plan: stream `planCandidates` (given `deps.now()`), judge each candidate with one Protector, build the
 *      report and write it. Dry run ends here (R1: no live write, only mem:retention:* bookkeeping and audit).
 *   4. check-before: no golden case, or an unreadable case file -> outcome "refused", report only. Else score.
 *   5. apply: re-stream from `cursor`, displace each Cleared item, stage O up to the run's `observationCap`,
 *      stage C demoted through `displace` (no vault entry, so no `held`). `held`, counters and the cursor are saved after every batch,
 *      empty ones included, then the sweep pauses.
 *   6. settle: `harness.settle()`.
 *   7. check-after: score and judge. A "restore" verdict, or a check that cannot run, calls `restoreRun` with
 *      the reason (R9), re-reads the run row (restoreRun changed it) and settles again.
 *   8. done: report, one audit entry for the seal and one per stage (R13), lease released.
 *
 * ponytail: the plan is streamed twice in an enforcing run (once for the report, once to apply), so a run reads
 * every sealed session's rows twice; storing the plan would trade that for a scope that grows with it.
 */
export async function runSweep(deps: RetentionDeps, settings: RetentionSettings, harness: RecallHarness, req: SweepRequest): Promise<SweepResult> {
  if (settings.mode === "off") return { kind: "off", why: settings.why };
  const runs = new RunStore(deps.kv, deps.now);
  const owner = `sweep-${randomUUID()}`;
  const lease = await runs.acquireLease(owner);
  if (!lease.held) return { kind: "busy", heldBy: lease.heldBy };
  const s: Sweep = {
    deps, settings, harness, runs, vault: new Vault(deps.kv), owner, pauseMs: req.pauseMs ?? RETENTION_PAGE_PAUSE_MS,
    resumed: false, lost: false, unreadable: 0,
  };
  try {
    return await drive(s, await openRun(s, req));
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: "lease-lost" };
    throw err;
  } finally {
    if (!s.lost) {
      await s.protector?.release().catch((err) => logger.warn("retention: scratch release failed", { error: String(err) }));
      await runs.releaseLease(owner).catch((err) => logger.warn("retention: lease release failed", { error: String(err) }));
    }
  }
}

async function openRun(s: Sweep, req: SweepRequest): Promise<RunRow> {
  const now = s.deps.now().toISOString();
  if (!req.dryRun) {
    const open = (await s.runs.unfinished()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const stale of open.filter((run) => run.dryRun)) {
      await s.runs.save({ ...stale, phase: "done", outcome: "dry-run", closedAt: now });
    }
    const resume = open.find((run) => !run.dryRun);
    if (resume) {
      s.resumed = true;
      return recover(s, resume);
    }
  }
  const row = newRunRow({
    id: generateId("ret") as RunId,
    dryRun: req.dryRun,
    windows: req.windowsOverride ?? s.settings.windows,
    graceDays: req.graceDaysOverride ?? s.settings.graceDays,
    ranBy: s.owner,
    startedAt: now,
  });
  await s.runs.save(row);
  return row;
}

async function recover(s: Sweep, row: RunRow): Promise<RunRow> {
  await recoverRun(s.deps, s.vault, row.id);
  await beat(s);
  await clearSweepScratch(s.deps.kv);
  const moved = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
  let held = 0;
  for await (const page of s.vault.pages(row.id, RETENTION_PAGE_SIZE)) {
    for (const entry of page) {
      moved[entry.stage]++;
      held++;
    }
    await beat(s);
  }
  // A demote holds no vault entry; its record in mem:retention:demoted is what a stage C count comes from.
  let scanned = 0;
  for await (const record of demotedBy(s.deps.kv, row.id)) {
    if (!record.restoring) moved.C++;
    if (++scanned % RETENTION_PAGE_SIZE === 0) await beat(s);
  }
  for (const stage of STAGES) row.counters[stage].moved = moved[stage];
  row.held = held;
  row.ranBy = s.owner;
  await beat(s);
  return s.runs.save(row);
}

async function beat(s: Sweep): Promise<void> {
  if (await s.runs.heartbeat(s.owner)) return;
  s.lost = true;
  throw new LeaseLost();
}

const pause = (s: Sweep): Promise<void> => (s.pauseMs > 0 ? new Promise((resolve) => setTimeout(resolve, s.pauseMs)) : Promise.resolve());

async function advance(s: Sweep, row: RunRow, phase: Phase): Promise<void> {
  row.phase = phase;
  await s.runs.save(row);
}

async function drive(s: Sweep, row: RunRow): Promise<SweepResult> {
  if (row.phase === "seal" || row.phase === "plan") {
    const sealed = await sealPhase(s);
    await advance(s, row, "plan");
    await planPhase(s, row, sealed);
    if (row.dryRun) return finish(s, row, "dry-run", "dry run: nothing moved");
    await advance(s, row, "check-before");
  }
  if (row.phase === "check-before") {
    const refusal = await checkBefore(s, row);
    if (refusal !== null) return finish(s, row, "refused", refusal);
    row.observationCap = await firstRunCap(s);
    await advance(s, row, "apply");
  }
  if (row.phase === "apply") {
    await applyPhase(s, row);
    await advance(s, row, "settle");
  }
  if (row.phase === "settle") {
    await s.harness.settle();
    await beat(s);
    await advance(s, row, "check-after");
  }
  return checkAfter(s, row);
}

interface SealTally {
  sealed: number;
  readonly refused: Map<SealRefusal, number>;
}

async function sealPhase(s: Sweep): Promise<SealTally> {
  const opts = { now: s.deps.now(), llmCompression: isAutoCompressEnabled() };
  const tally: SealTally = { sealed: 0, refused: new Map() };
  for await (const page of s.deps.kv.iterate<Session>(KV.sessions)) {
    for (const session of page) {
      const verdict = await sealSession(s.deps.kv, session.id, opts);
      if (verdict.kind === "sealed") tally.sealed++;
      else tally.refused.set(verdict.why, (tally.refused.get(verdict.why) ?? 0) + 1);
    }
    await beat(s);
  }
  return tally;
}

const clockOf = async (s: Sweep): Promise<ActiveClock> => (s.clock ??= await loadActiveClock(s.deps.kv, s.deps.now));

/** One Protector per sweep, built at first use and released in `runSweep`'s finally. */
async function protectorOf(s: Sweep, row: RunRow): Promise<Protector> {
  return (s.protector ??= await createProtector(s.deps.kv, row.windows, await clockOf(s)));
}

async function loadDraft(s: Sweep, runId: RunId): Promise<RunReport> {
  const draft = await s.deps.kv.get<RunReport>(RETENTION_KV.reports, runId);
  if (!draft) throw new Error(`retention run ${runId} has no plan report to continue from`);
  return draft;
}

async function patchDraft(s: Sweep, runId: RunId, patch: Partial<RunReport>): Promise<void> {
  await s.deps.kv.set(RETENTION_KV.reports, runId, { ...(await loadDraft(s, runId)), ...patch });
}

async function planPhase(s: Sweep, row: RunRow, sealed: SealTally): Promise<void> {
  const protector = await protectorOf(s, row);
  const builder = createReportBuilder(row.id, row.dryRun);
  builder.sealed(sealed.sealed);
  for (const [why, count] of sealed.refused) builder.undigested(why, count);
  for (const stage of STAGES) row.counters[stage] = { planned: 0, moved: 0, bytes: 0, protectedHits: 0 };
  for await (const batch of planCandidates(s.deps.kv, await clockOf(s), row.windows, null, s.deps.now())) {
    await beat(s);
    for (const candidate of batch.candidates) {
      builder.candidate(candidate);
      row.counters[candidate.stage].planned++;
      const verdict = await protector.judge(candidate);
      if (verdict.kind === "protected") {
        builder.protectedHit(verdict.signal, candidate);
        row.counters[candidate.stage].protectedHits++;
      }
    }
  }
  await s.deps.kv.set(RETENTION_KV.reports, row.id, builder.finish({ protectionHits: protector.hits(), resumed: s.resumed }));
  await s.runs.save(row);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The reason the run must not go on, or null once the before-score is stored. */
async function checkBefore(s: Sweep, row: RunRow): Promise<string | null> {
  let before: RecallScore;
  try {
    const cases = await s.harness.cases();
    if (!cases.some((c) => c.golden)) return "no golden recall cases are configured, so the run is report-only";
    before = await s.harness.score(cases);
  } catch (err) {
    return `the recall check could not run: ${messageOf(err)}`;
  }
  await beat(s);
  await patchDraft(s, row.id, { recall: { before: before.recallAt10, after: null, verdict: "pending", goldenBefore: [...before.goldenHit] } });
  return null;
}

/** Design 7.5: the first enforcing run moves at most a share of the stack's observations; null once a run has been kept. */
async function firstRunCap(s: Sweep): Promise<number | null> {
  if (((await s.deps.kv.get<number>(RETENTION_KV.control, ENFORCED_KEY)) ?? 0) > 0) return null;
  let total = 0;
  for await (const page of s.deps.kv.iterate<Session>(KV.sessions)) {
    const totals = await Promise.all(page.map((session) => sessionObservationTotals(s.deps.kv, session.id)));
    for (const { rows } of totals) total += rows;
    await beat(s);
  }
  return Math.floor(total * s.settings.firstRunObservationShare);
}

async function applyPhase(s: Sweep, row: RunRow): Promise<void> {
  const protector = await protectorOf(s, row);
  for await (const batch of planCandidates(s.deps.kv, await clockOf(s), row.windows, row.cursor, s.deps.now())) {
    await beat(s);
    for (const candidate of batch.candidates) {
      const verdict = await protector.judge(candidate);
      if (verdict.kind === "protected") continue;
      if (candidate.stage === "O" && row.observationCap !== null && row.counters.O.moved >= row.observationCap) continue;
      const result = await displace(s.deps, s.vault, row.id, verdict.item);
      if (result.moved) {
        row.counters[candidate.stage].moved++;
        row.counters[candidate.stage].bytes += result.bytes;
        if (STAGE_DISPOSITION[candidate.stage] !== "demote") row.held++;
      } else if (result.skipped === "unreadable") {
        s.unreadable++;
      }
    }
    row.cursor = batch.cursorAfter;
    await s.runs.save(row);
    await pause(s);
  }
  await patchDraft(s, row.id, { vectorUnreadable: s.unreadable });
}

async function checkAfter(s: Sweep, row: RunRow): Promise<SweepResult> {
  if (row.restoredBecause !== undefined) return restoreAll(s, row, row.restoredBecause);
  const draft = await loadDraft(s, row.id);
  const before = draft.recall;
  if (!before) throw new Error(`retention run ${row.id} reached its after-check with no before-score`);
  let judgement: RecallJudgement;
  let after: number | null = null;
  try {
    const score = await s.harness.score(await s.harness.cases());
    after = score.recallAt10;
    judgement = judgeRecall({ recallAt10: before.before, goldenHit: new Set(before.goldenBefore) }, score, s.settings.recallStopPoints);
  } catch (err) {
    judgement = { kind: "restore", why: `the recall check could not run: ${messageOf(err)}` };
  }
  await beat(s);
  const recall = (verdict: "keep" | "restore") => ({ ...before, after, verdict });
  if (judgement.kind === "keep") return finish(s, row, "kept", "recall check passed", { recall: recall("keep") });
  return restoreAll(s, row, judgement.why, { recall: recall("restore") });
}

/** `restoreRun` changes the run row (`held`, `restoredBecause`), so the row is read again; the index is settled once more so the restored documents have landed. */
async function restoreAll(s: Sweep, row: RunRow, why: string, patch: Partial<RunReport> = {}): Promise<SweepResult> {
  const result = await restoreRun(s.deps, row.id, why);
  const fresh = (await s.runs.get(row.id)) ?? row;
  await beat(s);
  await s.harness.settle();
  return finish(s, fresh, "restored", why, { ...patch, restored: { why, restored: result.restored, keptLive: result.keptLive, deferred: result.deferred } });
}

async function finish(s: Sweep, row: RunRow, outcome: FinalOutcome, reason: string, patch: Partial<RunReport> = {}): Promise<SweepResult> {
  const draft = await loadDraft(s, row.id);
  const report: RunReport = {
    ...draft,
    ...patch,
    outcome,
    ...(outcome === "refused" || outcome === "restored" ? { why: reason } : {}),
    resumed: s.resumed || draft.resumed,
    observationCap: row.observationCap,
    vectorUnreadable: Math.max(s.unreadable, draft.vectorUnreadable),
    perStage: Object.fromEntries(STAGES.map((stage) => [stage, { ...draft.perStage[stage], moved: row.counters[stage].moved }])) as RunReport["perStage"],
  };
  await s.deps.kv.set(RETENTION_KV.reports, row.id, report);
  await auditRun(s, row, report, reason);
  if (outcome === "kept") {
    await s.deps.kv.set(RETENTION_KV.control, ENFORCED_KEY, ((await s.deps.kv.get<number>(RETENTION_KV.control, ENFORCED_KEY)) ?? 0) + 1);
  }
  row.phase = "done";
  row.outcome = outcome;
  row.closedAt = s.deps.now().toISOString();
  await s.runs.save(row);
  return { kind: "done", runId: row.id, outcome, report };
}

/** R13: one entry for the seal and one per stage, so a run always leaves the same six entries. */
async function auditRun(s: Sweep, row: RunRow, report: RunReport, reason: string): Promise<void> {
  const common = { runId: row.id, dryRun: row.dryRun, outcome: report.outcome, reason, restored: report.outcome === "restored" };
  await safeAudit(s.deps.kv, "retention_seal", SWEEP_FUNCTION, [row.id], { ...common, sealed: report.sealed, undigested: report.undigested });
  for (const stage of STAGES) {
    const counters = row.counters[stage];
    const operation = STAGE_DISPOSITION[stage] === "demote" ? "retention_demote" : "retention_soft_delete";
    await safeAudit(s.deps.kv, operation, SWEEP_FUNCTION, [row.id], {
      ...common, stage, planned: counters.planned, moved: counters.moved, bytes: counters.bytes, protectedHits: counters.protectedHits,
    });
  }
}

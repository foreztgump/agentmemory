import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import { recoverRun } from "./move.js";
import { clearSweepScratch } from "./protect.js";
import { restoreItems, restoreRun, type RestoreResult } from "./restore.js";
import type { RunReport } from "./report.js";
import { LEASE_STALE_MS, RunStore } from "./run-store.js";
import type { RetentionDeps } from "./satellites.js";
import { RETENTION_KV } from "./scopes.js";
import { realScheduler, type Scheduler } from "./timers.js";
import type { ItemRef, RunId, RunRow } from "./types.js";
import { Vault } from "./vault.js";

const MS_PER_DAY = 86_400_000;

export type RestoreRequest = { readonly runId: RunId } | { readonly refs: readonly ItemRef[] };

export type RestoreOutcome =
  | ({ readonly kind: "done" } & RestoreResult)
  | { readonly kind: "busy"; readonly heldBy: string }
  | { readonly kind: "not-found" }
  /** Another process took the lease mid-restore. The restore stopped before its next write; repeating it finishes it. */
  | { readonly kind: "lease-lost" };

const REQUESTED = "restore requested";

class LeaseLost extends Error {}

/**
 * `mem::retention-restore`. Runs under the sweep lease, the one the sweep and the purge take. `restoreRun` and
 * `restoreItems` read and rewrite the run row of every run they touch (`held`), and a sweep or a purge rewrites
 * that row too, so a restore beside either would lose an update. A held lease answers `busy`. Per entry the restore
 * was already safe against a purge, which `reinstate` rereads under the item lock; the lease covers the run row.
 * The restore heartbeats the lease before each batch of writes (`beat`) and stops with `lease-lost` once another
 * process has it, leaving that owner's lease alone. A timer also renews the lease, for a page slow enough to outlast
 * it, and stops once a renewal finds it gone.
 *
 * A run that has not finished is one a sweep died in (a live sweep holds the lease, so this answers `busy` beside it).
 * It is recovered, restored and closed as `restored`, with retention on or off: with retention off no sweep would
 * ever close it, and with it on the operator asked for the run undone, not resumed.
 */
export async function restoreLeased(deps: RetentionDeps, req: RestoreRequest, scheduler: Scheduler = realScheduler): Promise<RestoreOutcome> {
  const runs = new RunStore(deps.kv, deps.now);
  const owner = `restore-${randomUUID()}`;
  const lease = await runs.acquireLease(owner);
  if (!lease.held) return { kind: "busy", heldBy: lease.heldBy };
  let lost = false;
  const renewal = scheduler.every(LEASE_STALE_MS / 3, async () => {
    if (lost || (await runs.heartbeat(owner).catch(() => true))) return;
    lost = true;
    renewal.stop();
    logger.warn("retention restore: the lease was taken over while restoring");
  });
  const beat = async (): Promise<void> => {
    if (!lost && (await runs.heartbeat(owner))) return;
    lost = true;
    renewal.stop();
    throw new LeaseLost();
  };
  try {
    if ("refs" in req) return { kind: "done", ...(await restoreItems(deps, req.refs, REQUESTED, { beat })) };
    const run = await runs.get(req.runId);
    if (!run) return { kind: "not-found" };
    if (run.phase === "done") return { kind: "done", ...(await restoreRun(deps, req.runId, REQUESTED, { beat })) };
    return { kind: "done", ...(await restoreUnfinished(deps, runs, run, beat)) };
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: "lease-lost" };
    throw err;
  } finally {
    renewal.stop();
    if (!lost) await runs.releaseLease(owner).catch((err) => logger.warn("retention restore: lease release failed", { error: String(err) }));
  }
}

/**
 * The sweep's own recovery first (`recoverRun` settles moves cut off mid-way, and the crashed sweep's scratch is cleared),
 * then `restoreRun`, then the run row and its report, if the run got that far, are closed the way a sweep closes a restored run.
 */
async function restoreUnfinished(deps: RetentionDeps, runs: RunStore, run: RunRow, beat: () => Promise<void>): Promise<RestoreResult> {
  const requested = `${REQUESTED}; the run had stopped in phase ${run.phase}`;
  const why = run.restoredBecause ?? requested;
  await recoverRun(deps, new Vault(deps.kv), run.id);
  await beat();
  await clearSweepScratch(deps.kv);
  const result = await restoreRun(deps, run.id, requested, { beat });
  await beat();
  const fresh = (await runs.get(run.id)) ?? run;
  const report = await deps.kv.get<RunReport>(RETENTION_KV.reports, run.id);
  if (report) {
    const restored = { why, restored: result.restored, keptLive: result.keptLive, deferred: result.deferred };
    await deps.kv.set<RunReport>(RETENTION_KV.reports, run.id, { ...report, outcome: "restored", why, restored });
  }
  await runs.save({ ...fresh, phase: "done", outcome: "restored", closedAt: deps.now().toISOString() });
  return result;
}

export interface RunSummary {
  readonly id: RunId;
  readonly dryRun: boolean;
  readonly phase: RunRow["phase"];
  readonly outcome: RunRow["outcome"];
  readonly startedAt: string;
  readonly closedAt: string | null;
  /** Entries still restorable from the run's vault: what the purge has not taken yet. */
  readonly held: number;
  readonly graceDays: number;
  /** `closedAt` plus the grace period: from then on the purge may take the held entries. */
  readonly graceEndsAt: string | null;
  readonly purgedAt: string | null;
  readonly restoredBecause: string | null;
}

export type ReportOutcome =
  /** `report` is null for a run that wrote none (it died before the plan). */
  | { readonly kind: "found"; readonly report: RunReport | null; readonly run: RunSummary }
  | { readonly kind: "not-found" };

function summarize(run: RunRow): RunSummary {
  return {
    id: run.id,
    dryRun: run.dryRun,
    phase: run.phase,
    outcome: run.outcome,
    startedAt: run.startedAt,
    closedAt: run.closedAt ?? null,
    held: run.held,
    graceDays: run.graceDays,
    graceEndsAt: run.closedAt ? new Date(Date.parse(run.closedAt) + run.graceDays * MS_PER_DAY).toISOString() : null,
    purgedAt: run.purgedAt ?? null,
    restoredBecause: run.restoredBecause ?? null,
  };
}

/**
 * `mem::retention-report`: the stored report of one run, or of the newest run, beside its run row, which carries what
 * the report cannot: `held`, `graceEndsAt` and `purgedAt` change after the run ends, as restores and the purge take entries.
 * The run rows are a bounded scope (about 60 a year), so listing them is cheap.
 */
export async function readReport(deps: RetentionDeps, runId?: RunId): Promise<ReportOutcome> {
  const run = runId
    ? await new RunStore(deps.kv, deps.now).get(runId)
    : (await deps.kv.list<RunRow>(RETENTION_KV.runs)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!run) return { kind: "not-found" };
  const report = await deps.kv.get<RunReport>(RETENTION_KV.reports, run.id);
  return { kind: "found", report, run: summarize(run) };
}

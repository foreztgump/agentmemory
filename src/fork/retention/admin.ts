import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import { restoreItems, restoreRun, type RestoreResult } from "./restore.js";
import type { RunReport } from "./report.js";
import { LEASE_STALE_MS, RunStore } from "./run-store.js";
import type { RetentionDeps } from "./satellites.js";
import { RETENTION_KV } from "./scopes.js";
import { realScheduler, type Scheduler } from "./timers.js";
import type { ItemRef, RunId, RunRow } from "./types.js";

const MS_PER_DAY = 86_400_000;

export type RestoreRequest = { readonly runId: RunId } | { readonly refs: readonly ItemRef[] };

export type RestoreOutcome =
  | ({ readonly kind: "done" } & RestoreResult)
  | { readonly kind: "busy"; readonly heldBy: string }
  | { readonly kind: "not-found" }
  /** The run has not finished: a sweep resumes it, and restoring under it would race the sweep's own run row. */
  | { readonly kind: "run-open" };

/**
 * `mem::retention-restore`. Runs under the sweep lease, the one the sweep and the purge take. `restoreRun` and
 * `restoreItems` read and rewrite the run row of every run they touch (`held`), and a sweep or a purge rewrites
 * that row too, so a restore beside either would lose an update. A held lease answers `busy`. Per entry the restore
 * was already safe against a purge, which `reinstate` rereads under the item lock; the lease covers the run row.
 * The lease is renewed on a timer while the restore pages (it has no heartbeat hook of its own), and
 * a restore that outlives it, after a stall, finishes anyway: every step repeats safely.
 * ponytail: a lease taken over mid-restore is not noticed until the restore ends; give `restoreRun` a `beat` if that matters.
 */
export async function restoreLeased(deps: RetentionDeps, req: RestoreRequest, scheduler: Scheduler = realScheduler): Promise<RestoreOutcome> {
  const runs = new RunStore(deps.kv, deps.now);
  const owner = `restore-${randomUUID()}`;
  const lease = await runs.acquireLease(owner);
  if (!lease.held) return { kind: "busy", heldBy: lease.heldBy };
  const renewal = scheduler.every(LEASE_STALE_MS / 3, async () => {
    if (!(await runs.heartbeat(owner).catch(() => false))) logger.warn("retention restore: the lease was taken over while restoring");
  });
  try {
    if ("refs" in req) return { kind: "done", ...(await restoreItems(deps, req.refs, "restore requested")) };
    const run = await runs.get(req.runId);
    if (!run) return { kind: "not-found" };
    if (run.phase !== "done") return { kind: "run-open" };
    return { kind: "done", ...(await restoreRun(deps, req.runId, "restore requested")) };
  } finally {
    renewal.stop();
    await runs.releaseLease(owner).catch((err) => logger.warn("retention restore: lease release failed", { error: String(err) }));
  }
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

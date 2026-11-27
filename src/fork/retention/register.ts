import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";
import { getEnvVar } from "../../config.js";
import { logger } from "../../logger.js";
import { getSearchRuntime } from "../../state/search-ports.js";
import { readReport, restoreLeased } from "./admin.js";
import { pinItem, unpinItem } from "./pin.js";
import { runPurge } from "./purge.js";
import { createRecallHarness } from "./recall-check.js";
import type { RetentionDeps } from "./satellites.js";
import { activeVectorReader } from "./vectors.js";
import { parseRetentionSettings, RETENTION_SETTING_KEYS, retentionEnforceRequested, type RetentionEnv } from "./settings.js";
import { runSweep } from "./sweep.js";
import { realScheduler, startRetentionTimers, type Scheduler } from "./timers.js";
import type { ItemRef, RunId } from "./types.js";
import { setSummarizeVeto, trimmedSealVeto } from "./veto.js";

function retentionEnv(): RetentionEnv {
  return Object.fromEntries(RETENTION_SETTING_KEYS.map((key) => [key, getEnvVar(key)]));
}

/** Injection points for tests; production passes none. */
export interface RetentionOptions {
  readonly env?: RetentionEnv;
  readonly deps?: Partial<RetentionDeps>;
  readonly scheduler?: Scheduler;
}

/**
 * The only entry point upstream code calls (src/index.ts, one line after the search runtime is created).
 *
 * iii functions:
 *   mem::retention-sweep    { dryRun }            -> SweepResult
 *   mem::retention-restore  { runId } | { refs }  -> RestoreOutcome (refs: ItemRef[]; an observation needs its session)
 *   mem::retention-purge    { dryRun }            -> PurgeOutcome (dryRun defaults to true, as for the sweep)
 *   mem::retention-pin      { ref, who, reason } | { ref, who, unpin: true } -> PinOutcome
 *   mem::retention-report   { runId? }            -> ReportOutcome (the newest run without a runId)
 * REST (src/triggers/api.ts registers the paths and calls registerRetentionTriggers, rest.ts):
 *   POST /agentmemory/retention/sweep, POST /agentmemory/retention/restore, POST /agentmemory/retention/purge,
 *   POST /agentmemory/retention/pin, GET /agentmemory/retention/report. Fields whitelisted; auth fails closed.
 *   No MCP tool (D3: tool count unchanged).
 * Timers: the sweep every AM_RETENTION_INTERVAL_MS (weekly, D11; 0 = manual only) and the purge daily (timers.ts), none on
 * an off stack. Restore, pin and report work whether retention is on or off: the kill switch stops deleting, not undoing.
 * Also: setSummarizeVeto(trimmedSealVeto(kv)), always, whatever the mode: a session trimmed under an earlier
 * enforcing run keeps its summary when retention is switched off. A second registerRetention in one process throws.
 */
export function registerRetention(sdk: IIIClient, kv: StateKV, options: RetentionOptions = {}): { stop(): void } {
  const env = options.env ?? retentionEnv();
  const settings = parseRetentionSettings(env);
  if (settings.mode === "off") {
    const log = retentionEnforceRequested(env) ? logger.warn : logger.info;
    log(`retention off: ${settings.why}`);
  }
  const deps: RetentionDeps = {
    sdk,
    kv,
    search: getSearchRuntime,
    vectors: activeVectorReader(getSearchRuntime),
    now: () => new Date(),
    ...options.deps,
  };
  const harness = createRecallHarness(deps, settings.mode === "enforce" ? settings.recallCasesPath : null);

  setSummarizeVeto(trimmedSealVeto(kv));

  const sweep = (dryRun: boolean) => runSweep(deps, settings, harness, { dryRun });
  const purge = (dryRun: boolean) => runPurge(deps, settings, { dryRun });
  sdk.registerFunction("mem::retention-sweep", async (req?: { dryRun?: unknown }) => sweep(req?.dryRun !== false));
  sdk.registerFunction("mem::retention-purge", async (req?: { dryRun?: unknown }) => purge(req?.dryRun !== false));
  sdk.registerFunction("mem::retention-restore", async (req: { runId?: string; refs?: ItemRef[] }) =>
    restoreLeased(deps, req.refs ? { refs: req.refs } : { runId: req.runId as RunId }),
  );
  sdk.registerFunction("mem::retention-pin", async (req: { ref: ItemRef; who: string; reason?: string; unpin?: true }) =>
    req.unpin ? unpinItem(deps, req.ref, req.who) : pinItem(deps, { ref: req.ref, who: req.who, reason: req.reason ?? "" }),
  );
  sdk.registerFunction("mem::retention-report", async (req?: { runId?: string }) => readReport(deps, req?.runId as RunId | undefined));

  return startRetentionTimers(settings, { sweep: () => sweep(false), purge: () => purge(false) }, options.scheduler ?? realScheduler);
}

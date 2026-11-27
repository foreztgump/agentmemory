import { randomUUID } from "node:crypto";
import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";
import { getEnvVar } from "../../config.js";
import { logger } from "../../logger.js";
import { getSearchRuntime } from "../../state/search-ports.js";
import { readReport, restoreLeased } from "./admin.js";
import { readJob, tracked, type JobId, type JobRoute } from "./jobs.js";
import { pinItem, unpinItem } from "./pin.js";
import { invalid, parseJobId, parsePayload, parsePin, parseRestore, type Parsed } from "./requests.js";
import { runPurge } from "./purge.js";
import { createRecallHarness } from "./recall-check.js";
import type { RetentionDeps } from "./satellites.js";
import { activeVectorReader } from "./vectors.js";
import { parseRetentionSettings, RETENTION_SETTING_KEYS, retentionEnforceRequested, type RetentionEnv } from "./settings.js";
import { runSweep } from "./sweep.js";
import { realScheduler, startRetentionTimers, type Scheduler } from "./timers.js";
import type { RunId } from "./types.js";
import { setSummarizeVeto, trimmedSealVeto } from "./veto.js";

const parsed = <T>(raw: unknown, parse: (body: Record<string, unknown>) => Parsed<T>): Parsed<T> => {
  const body = parsePayload(raw);
  return body.ok ? parse(body.value) : body;
};

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
 *   mem::retention-job      { id }                -> { kind: "found", job } | { kind: "not-found" } (jobs.ts)
 * Sweep, purge and restore also take an optional jobId. The REST routes pass one, so a call that outlasts the engine's HTTP
 * timeout (the function keeps running) leaves its outcome in the job ledger for the job route to read.
 * Restore and pin parse their payload with the parsers the routes use (requests.ts) and answer { kind: "invalid", error }
 * to one the routes would refuse: other workers trigger them directly.
 * REST (src/triggers/api.ts registers the paths and calls registerRetentionTriggers, rest.ts):
 *   POST /agentmemory/retention/sweep, POST /agentmemory/retention/restore, POST /agentmemory/retention/purge,
 *   POST /agentmemory/retention/pin, GET /agentmemory/retention/report, GET /agentmemory/retention/job?id=. Fields whitelisted; auth fails closed.
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

  const bootId = randomUUID();
  const sweep = (dryRun: boolean) => runSweep(deps, settings, harness, { dryRun });
  const purge = (dryRun: boolean) => runPurge(deps, settings, { dryRun });
  const withJob = async (raw: unknown, route: JobRoute, work: (id: JobId | undefined) => Promise<unknown>) => {
    const body = parsePayload(raw);
    const jobId = body.ok && body.value["jobId"] !== undefined ? parseJobId(body.value["jobId"], "jobId") : undefined;
    if (jobId && !jobId.ok) return invalid(jobId);
    const id = jobId?.value;
    return tracked(kv, bootId, deps.now, id, route, () => work(id));
  };
  sdk.registerFunction("mem::retention-sweep", async (req?: { dryRun?: unknown; jobId?: unknown }) =>
    withJob(req, "sweep", () => sweep(req?.dryRun !== false)),
  );
  sdk.registerFunction("mem::retention-purge", async (req?: { dryRun?: unknown; jobId?: unknown }) =>
    withJob(req, "purge", () => purge(req?.dryRun !== false)),
  );
  sdk.registerFunction("mem::retention-restore", async (raw?: unknown) => {
    const req = parsed(raw, parseRestore);
    return req.ok ? withJob(raw, "restore", () => restoreLeased(deps, req.value)) : invalid(req);
  });
  sdk.registerFunction("mem::retention-pin", async (raw?: unknown) => {
    const req = parsed(raw, parsePin);
    if (!req.ok) return invalid(req);
    return "unpin" in req.value ? unpinItem(deps, req.value.ref, req.value.who) : pinItem(deps, req.value);
  });
  sdk.registerFunction("mem::retention-report", async (req?: { runId?: string }) => readReport(deps, req?.runId as RunId | undefined));
  sdk.registerFunction("mem::retention-job", async (raw?: unknown) => {
    const req = parsed(raw, (body) => parseJobId(body["id"], "id"));
    return req.ok ? readJob(kv, bootId, req.value) : invalid(req);
  });

  return startRetentionTimers(settings, { sweep: () => sweep(false), purge: () => purge(false) }, options.scheduler ?? realScheduler);
}

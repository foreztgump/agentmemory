import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";
import { getEnvVar } from "../../config.js";
import { logger } from "../../logger.js";
import { getSearchRuntime } from "../../state/search-ports.js";
import { runPurge } from "./purge.js";
import { createRecallHarness } from "./recall-check.js";
import type { RetentionDeps } from "./satellites.js";
import { activeVectorReader } from "./vectors.js";
import { parseRetentionSettings, RETENTION_SETTING_KEYS, retentionEnforceRequested, type RetentionEnv } from "./settings.js";
import { runSweep } from "./sweep.js";
import { setSummarizeVeto, trimmedSealVeto } from "./veto.js";

function retentionEnv(): RetentionEnv {
  return Object.fromEntries(RETENTION_SETTING_KEYS.map((key) => [key, getEnvVar(key)]));
}

/**
 * The only entry point upstream code calls (src/index.ts, one line after the search runtime is created).
 *
 * iii functions:
 *   mem::retention-sweep    { dryRun }            -> SweepResult
 *   mem::retention-restore  { runId } | { refs }  -> RestoreResult (refs: ItemRef[]; an observation needs its session)
 *   mem::retention-purge    { dryRun }            -> PurgeOutcome (dryRun defaults to true, as for the sweep)
 *   mem::retention-pin      { ref, who, reason } | { ref, unpin: true }
 *   mem::retention-report   { runId? }            -> RunReport
 * REST (src/triggers/api.ts calls registerRetentionTriggers; AGENTS.md endpoint counts and docs:sync):
 *   POST /agentmemory/retention/sweep, POST /agentmemory/retention/restore, POST /agentmemory/retention/purge,
 *   POST /agentmemory/retention/pin, GET /agentmemory/retention/report. Fields whitelisted; auth fails closed
 *   (see registerRetentionTriggers).
 *   No MCP tool (D3: tool count unchanged).
 * Timers (slice 10; none run before it): the sweep every AM_RETENTION_INTERVAL_MS (weekly, D11; 0 = manual
 * only) and the purge daily, both no-ops when off.
 * Also: setSummarizeVeto(trimmedSealVeto(kv)), always, whatever the mode: a session trimmed under an earlier
 * enforcing run keeps its summary when retention is switched off. A second registerRetention in one process throws.
 */
export function registerRetention(sdk: IIIClient, kv: StateKV): void {
  const env = retentionEnv();
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
  };
  const harness = createRecallHarness(deps, settings.mode === "enforce" ? settings.recallCasesPath : null);

  setSummarizeVeto(trimmedSealVeto(kv));

  sdk.registerFunction("mem::retention-sweep", async (req?: { dryRun?: unknown }) =>
    runSweep(deps, settings, harness, { dryRun: req?.dryRun !== false }),
  );
  sdk.registerFunction("mem::retention-purge", async (req?: { dryRun?: unknown }) =>
    runPurge(deps, settings, { dryRun: req?.dryRun !== false }),
  );
}

/**
 * REST registration. Fail closed: sweep, purge and restore delete data and pin changes what they may
 * delete, but `checkAuth` (src/triggers/api.ts) returns null, which allows the call, when `secret` is
 * undefined. So with `secret` undefined these endpoints are either not registered at all or every
 * handler first returns the 503 of `requireConfiguredSecret(secret, "retention")` (module-private in
 * api.ts today: slice 10 exports it or guards the call there). Never default to the permissive path.
 * With a secret set, each handler goes through `checkAuth` and whitelists its fields.
 */
export function registerRetentionTriggers(sdk: IIIClient, kv: StateKV, secret: string | undefined): void {
  void sdk;
  void kv;
  void secret;
  throw new Error("not implemented");
}

import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";
import { getEnvVar } from "../../config.js";
import { logger } from "../../logger.js";
import { getSearchRuntime } from "../../state/search-ports.js";
import type { RecallHarness } from "./recall-check.js";
import type { RetentionDeps } from "./satellites.js";
import { parseRetentionSettings, RETENTION_SETTING_KEYS, retentionEnforceRequested, type RetentionEnv } from "./settings.js";
import { runSweep } from "./sweep.js";

function retentionEnv(): RetentionEnv {
  return Object.fromEntries(RETENTION_SETTING_KEYS.map((key) => [key, getEnvVar(key)]));
}

/**
 * The only entry point upstream code calls (src/index.ts, one line after the search runtime is created).
 *
 * iii functions:
 *   mem::retention-sweep    { dryRun }            -> SweepResult
 *   mem::retention-restore  { runId } | { refs }  -> RestoreResult (refs: ItemRef[]; an observation needs its session)
 *   mem::retention-purge    {}                    -> PurgeResult
 *   mem::retention-pin      { ref, who, reason } | { ref, unpin: true }
 *   mem::retention-report   { runId? }            -> RunReport
 * REST (src/triggers/api.ts calls registerRetentionTriggers; AGENTS.md endpoint counts and docs:sync):
 *   POST /agentmemory/retention/sweep, POST /agentmemory/retention/restore, POST /agentmemory/retention/purge,
 *   POST /agentmemory/retention/pin, GET /agentmemory/retention/report. Fields whitelisted; auth fails closed
 *   (see registerRetentionTriggers).
 *   No MCP tool (D3: tool count unchanged).
 * Timers: the sweep every AM_RETENTION_INTERVAL_MS (weekly, D11) and the purge daily, both no-ops when off.
 * Also: setSummarizeVeto(seal.trimmed point read).
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
    vectors: { canRead: false, read: async () => new Map() },
    now: () => new Date(),
  };
  const harness: RecallHarness = {
    settle: async () => {},
    score: () => Promise.reject(new Error("not implemented")),
  };

  sdk.registerFunction("mem::retention-sweep", async (req?: { dryRun?: unknown }) =>
    runSweep(deps, settings, harness, { dryRun: req?.dryRun !== false }),
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

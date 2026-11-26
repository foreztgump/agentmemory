import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";
import { getEnvVar } from "../../config.js";
import { logger } from "../../logger.js";
import { getSearchRuntime } from "../../state/search-ports.js";
import type { RecallHarness } from "./recall-check.js";
import type { RetentionDeps } from "./satellites.js";
import { parseRetentionSettings } from "./settings.js";
import { runSweep } from "./sweep.js";

const SETTING_KEYS = [
  "AM_RETENTION",
  "AM_RETENTION_WINDOWS",
  "AM_RETENTION_GRACE_DAYS",
  "AM_RETENTION_RECALL_CASES",
  "AM_RETENTION_INTERVAL_MS",
] as const;

function retentionEnv(): Record<string, string | undefined> {
  return Object.fromEntries(SETTING_KEYS.map((key) => [key, getEnvVar(key)]));
}

/**
 * The only entry point upstream code calls (src/index.ts, one line after the search runtime is created).
 *
 * iii functions:
 *   mem::retention-sweep    { dryRun }            -> SweepResult
 *   mem::retention-restore  { runId } | { ids }   -> RestoreResult
 *   mem::retention-purge    {}                    -> PurgeResult
 *   mem::retention-pin      { id, kind, who, reason } | { id, unpin: true }
 *   mem::retention-report   { runId? }            -> RunReport
 * REST (src/triggers/api.ts calls registerRetentionTriggers; AGENTS.md endpoint counts and docs:sync):
 *   POST /agentmemory/retention/sweep, POST /agentmemory/retention/restore, POST /agentmemory/retention/purge,
 *   POST /agentmemory/retention/pin, GET /agentmemory/retention/report. Auth with checkAuth; fields whitelisted.
 *   No MCP tool (D3: tool count unchanged).
 * Timers: the sweep every AM_RETENTION_INTERVAL_MS (weekly, D11) and the purge daily, both no-ops when off.
 * Also: setSummarizeVeto(seal.trimmed point read).
 */
export function registerRetention(sdk: IIIClient, kv: StateKV): void {
  const settings = parseRetentionSettings(retentionEnv());
  if (settings.mode === "off") {
    const log = getEnvVar("AM_RETENTION")?.trim().toLowerCase() === "enforce" ? logger.warn : logger.info;
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

export function registerRetentionTriggers(sdk: IIIClient, kv: StateKV, secret: string | undefined): void {
  void sdk;
  void kv;
  void secret;
  throw new Error("not implemented");
}

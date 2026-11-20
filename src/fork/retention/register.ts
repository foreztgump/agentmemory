import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";

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
  void sdk;
  void kv;
  throw new Error("not implemented");
}

export function registerRetentionTriggers(sdk: IIIClient, kv: StateKV, secret: string | undefined): void {
  void sdk;
  void kv;
  void secret;
  throw new Error("not implemented");
}

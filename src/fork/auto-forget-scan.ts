import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation } from "../types.js";
import { logger } from "../logger.js";
import { observationStatsOf } from "./kv/observation-stats.js";

/**
 * The observations auto-forget examines for one session. With maintained stats, a session that
 * cannot hold a low-importance row older than `cutoffMs` (auto-forget's own age rule) is not read at all, and a session that is
 * read gets its stats recounted so a stale oldest-timestamp bound converges. Without stats this
 * is upstream's own list.
 */
export async function observationsToExamine(kv: StateKV, sessionId: string, cutoffMs: number): Promise<CompressedObservation[]> {
  const stats = observationStatsOf(kv);
  if (!stats) return kv.list<CompressedObservation>(KV.observations(sessionId));
  const low = await stats.lowImportance(sessionId);
  if (low && (low.rows === 0 || (low.oldestMs !== null && low.oldestMs >= cutoffMs))) return [];
  const rows = await kv.list<CompressedObservation>(KV.observations(sessionId));
  await stats.recount(sessionId).catch((error) => logger.warn("auto-forget: observation stats recount failed", { sessionId, error: String(error) }));
  return rows;
}

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation } from "../types.js";
import { observationStatsOf } from "./kv/observation-stats.js";

const LOW_VALUE_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The observations auto-forget examines for one session. With maintained stats, a session that
 * cannot hold a low-importance row older than 180 days is not read at all, and a session that is
 * read gets its stats recounted so a stale oldest-timestamp bound converges. Without stats this
 * is upstream's own list.
 */
export async function observationsToExamine(kv: StateKV, sessionId: string, now: number): Promise<CompressedObservation[]> {
  const stats = observationStatsOf(kv);
  if (!stats) return kv.list<CompressedObservation>(KV.observations(sessionId));
  const low = await stats.lowImportance(sessionId);
  if (low && (low.rows === 0 || (low.oldestMs !== null && low.oldestMs >= now - LOW_VALUE_AGE_MS))) return [];
  const rows = await kv.list<CompressedObservation>(KV.observations(sessionId));
  await stats.recount(sessionId).catch(() => undefined);
  return rows;
}

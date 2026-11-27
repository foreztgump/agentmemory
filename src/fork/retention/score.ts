import { normalizeAccessLog } from "../../functions/access-tracker.js";
import type { Memory } from "../../types.js";

/**
 * The episodic score of upstream `mem::retention-score` (functions/retention.ts) at its default decay, computed at plan
 * time so stage C never waits on a stored score nothing schedules (TEE-1158). Upstream's function is not imported:
 * that would drag the search runtime into the fork build. cold-score.test.ts pins the two to the same cold set.
 */
const LAMBDA = 0.01;
const SIGMA = 0.3;
const TYPE_WEIGHT: Record<Memory["type"], number> = { architecture: 0.9, bug: 0.7, pattern: 0.8, preference: 0.85, workflow: 0.6, fact: 0.5 };
const DAY_MS = 86_400_000;

export function retentionScore(memory: Memory, rawLog: unknown, now: Date): number {
  const log = normalizeAccessLog(rawLog);
  const salience = Math.min(1, (TYPE_WEIGHT[memory.type] || 0.5) + Math.min(0.2, log.count * 0.02));
  const decay = Math.exp(-LAMBDA * ((now.getTime() - Date.parse(memory.createdAt)) / DAY_MS));
  const boost = log.recent.reduce((sum, at) => {
    const days = (now.getTime() - at) / DAY_MS;
    return days > 0 ? sum + 1 / days : sum;
  }, 0);
  return Math.min(1, salience * decay + SIGMA * boost);
}

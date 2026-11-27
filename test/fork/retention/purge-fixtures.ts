import { displace } from "../../../src/fork/retention/move.js";
import type { Cleared } from "../../../src/fork/retention/protect.js";
import { runPurge, type PurgeOutcome } from "../../../src/fork/retention/purge.js";
import { newRunRow } from "../../../src/fork/retention/run-store.js";
import type { RetentionDeps } from "../../../src/fork/retention/satellites.js";
import { parseRetentionSettings, type RetentionSettings } from "../../../src/fork/retention/settings.js";
import type { RunId } from "../../../src/fork/retention/types.js";
import type { Rig } from "./move-fixtures.js";
import { NOW } from "./move-fixtures.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const at = (hours: number): Date => new Date(NOW.getTime() + hours * HOUR);

/** The rig's deps with a clock the test moves. */
export function clocked(r: Rig, start: Date = NOW): { clock: { now: Date }; deps: RetentionDeps } {
  const clock = { now: start };
  return { clock, deps: { ...r.deps, now: () => clock.now } };
}

/** Windows as main runs them, and the grace in days; the purge Protector is built from these (D1). */
export const purgeSettings = (graceDays = 1, windows = "trim:45,obs:180,sup:180,cold:365"): RetentionSettings =>
  parseRetentionSettings({ AM_RETENTION: "enforce", AM_RETENTION_WINDOWS: windows, AM_RETENTION_GRACE_DAYS: String(graceDays) });

export const purge = (deps: RetentionDeps, req: { dryRun?: boolean; spillIds?: number } = {}, settings: RetentionSettings = purgeSettings()): Promise<PurgeOutcome> =>
  runPurge(deps, settings, { dryRun: false, pauseMs: 0, ...req });

export function done(outcome: PurgeOutcome) {
  if (outcome.kind !== "done") throw new Error(`purge did not finish: ${outcome.kind}`);
  return outcome;
}

/**
 * A finished run that holds the given items in its vault, as a sweep leaves one: `held` counts the moves and the
 * run closed at `closedAt`. Moves happen through the real `displace`, so every satellite has been detached.
 */
export async function closedRun(r: Rig, runId: RunId, items: readonly Cleared[], opts: { closedAt?: Date; graceDays?: number } = {}): Promise<void> {
  const row = newRunRow({
    id: runId, dryRun: false, windows: { trimDays: 0, observationDays: 0, supersededDays: 0, coldDays: 0 },
    graceDays: opts.graceDays ?? 1, ranBy: "test", startedAt: NOW.toISOString(),
  });
  await r.runs.save(row);
  let held = 0;
  for (const item of items) {
    const result = await displace(r.deps, r.vault, runId, item);
    if (result.moved && item.stage !== "C") held++;
  }
  await r.runs.save({ ...row, held, phase: "done", outcome: "kept", closedAt: (opts.closedAt ?? NOW).toISOString() });
}

export const snapshot = (r: Rig): string =>
  JSON.stringify([...r.h.store].map(([scope, rows]) => [scope, [...rows]]).sort(([a], [b]) => String(a).localeCompare(String(b))));

const WRITE = /^state::(set|delete|update)/;
export const writeCount = (r: Rig): number => r.h.stateOps.filter((op) => WRITE.test(op)).length;

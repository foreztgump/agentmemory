import { logger } from "../../logger.js";
import type { PurgeOutcome } from "./purge.js";
import type { RetentionSettings } from "./settings.js";
import type { SweepResult } from "./sweep.js";

export const PURGE_INTERVAL_MS = 86_400_000;

/** The clock of every retention timer: a test hands in one it fires by hand, so nothing sleeps. */
export interface Scheduler {
  every(ms: number, tick: () => Promise<void> | void): { stop(): void };
}

export const realScheduler: Scheduler = {
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  },
};

export interface TimerRunners {
  sweep(): Promise<SweepResult>;
  purge(): Promise<PurgeOutcome>;
}

type Answer = SweepResult | PurgeOutcome;

function logAnswer(job: string, answer: Answer): void {
  if (answer.kind === "lease-lost") logger.warn(`retention ${job} tick: lease-lost, the next pass settles the rest`);
  else if (answer.kind === "busy") logger.info(`retention ${job} tick skipped: busy, held by ${answer.heldBy}`);
  else if (answer.kind === "off") logger.info(`retention ${job} tick skipped: off, ${answer.why}`);
  else logger.info(`retention ${job} tick: done`);
}

/** A tick that never throws and never overlaps itself: a second tick that finds the first running does nothing. */
function guarded(job: string, run: () => Promise<Answer>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      logAnswer(job, await run());
    } catch (err) {
      logger.warn(`retention ${job} tick failed: ${err instanceof Error ? err.message : String(err)}`, { job });
    } finally {
      running = false;
    }
  };
}

/**
 * The sweep every `intervalMs` (D11, weekly by default; 0 is manual only) and the purge daily, both enforcing.
 * An off stack schedules nothing. The first tick comes one interval after boot, so a restart loop never sweeps.
 */
export function startRetentionTimers(settings: RetentionSettings, runners: TimerRunners, scheduler: Scheduler = realScheduler): { stop(): void } {
  if (settings.mode === "off") return { stop() {} };
  const timers = [
    ...(settings.intervalMs > 0 ? [scheduler.every(settings.intervalMs, guarded("sweep", runners.sweep))] : []),
    scheduler.every(PURGE_INTERVAL_MS, guarded("purge", runners.purge)),
  ];
  return { stop: () => timers.forEach((timer) => timer.stop()) };
}

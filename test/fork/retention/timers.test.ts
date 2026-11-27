// Slice 10: the sweep runs on AM_RETENTION_INTERVAL_MS and the purge daily. A fake scheduler stands in for the clock, so nothing sleeps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { logger } from "../../../src/logger.js";
import { registerRetention } from "../../../src/fork/retention/register.js";
import { parseRetentionSettings } from "../../../src/fork/retention/settings.js";
import { PURGE_INTERVAL_MS, realScheduler, startRetentionTimers, type Scheduler, type TimerRunners } from "../../../src/fork/retention/timers.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import { KV } from "../../../src/state/schema.js";
import { anchor, ENFORCE, liveRoutes } from "./api-fixtures.js";
import { retentionHarness } from "./harness.js";
import { memory, rig, seedMemory } from "./move-fixtures.js";

const WEEK = 604_800_000;
const settings = (extra: Record<string, string> = {}) => parseRetentionSettings({ ...ENFORCE, ...extra });

interface Scheduled {
  readonly ms: number;
  readonly tick: () => Promise<void> | void;
  stopped: boolean;
}

function fakeScheduler(): { scheduler: Scheduler; scheduled: Scheduled[] } {
  const scheduled: Scheduled[] = [];
  const scheduler: Scheduler = {
    every: (ms, tick) => {
      const entry: Scheduled = { ms, tick, stopped: false };
      scheduled.push(entry);
      return { stop: () => { entry.stopped = true; } };
    },
  };
  return { scheduler, scheduled };
}

const runners = (): TimerRunners & { sweep: ReturnType<typeof vi.fn>; purge: ReturnType<typeof vi.fn> } => ({
  sweep: vi.fn(async () => ({ kind: "done", runId: "ret_1", outcome: "kept", report: {} })),
  purge: vi.fn(async () => ({ kind: "done", dryRun: false, purged: 2 })),
}) as never;

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  resetSummarizeVeto();
  vi.useRealTimers();
});

describe("startRetentionTimers", () => {
  it("schedules the sweep on the interval and the purge daily", () => {
    const { scheduler, scheduled } = fakeScheduler();
    startRetentionTimers(settings({ AM_RETENTION_INTERVAL_MS: "3600000" }), runners(), scheduler);
    expect(scheduled.map((s) => s.ms)).toEqual([3_600_000, PURGE_INTERVAL_MS]);
    expect(PURGE_INTERVAL_MS).toBe(86_400_000);
  });

  it("sweeps weekly when no interval is set", () => {
    const { scheduler, scheduled } = fakeScheduler();
    startRetentionTimers(settings(), runners(), scheduler);
    expect(scheduled.map((s) => s.ms)).toEqual([WEEK, PURGE_INTERVAL_MS]);
  });

  it("a 30-day interval never sweeps on a real clock (Node fires a delay past 2^31-1 ms every 1 ms)", async () => {
    const run = runners();
    const timers = startRetentionTimers(settings({ AM_RETENTION_INTERVAL_MS: String(30 * 86_400_000) }), run, realScheduler);
    await new Promise((resolve) => setTimeout(resolve, 50));
    timers.stop();
    expect(run.sweep).not.toHaveBeenCalled();
  });

  it("an interval of 0 means manual sweeps only, and the purge still runs daily", () => {
    const { scheduler, scheduled } = fakeScheduler();
    startRetentionTimers(settings({ AM_RETENTION_INTERVAL_MS: "0" }), runners(), scheduler);
    expect(scheduled.map((s) => s.ms)).toEqual([PURGE_INTERVAL_MS]);
  });

  it.each([
    ["retention off", parseRetentionSettings({})],
    ["a blank interval", settings({ AM_RETENTION_INTERVAL_MS: " " })],
    ["the kill switch", parseRetentionSettings({ ...ENFORCE, AM_RETENTION: "off" })],
  ])("schedules nothing for %s", (_name, off) => {
    const { scheduler, scheduled } = fakeScheduler();
    const timers = startRetentionTimers(off, runners(), scheduler);
    expect(off.mode).toBe("off");
    expect(scheduled).toEqual([]);
    expect(() => timers.stop()).not.toThrow();
  });

  it("a sweep tick enforces and a purge tick purges for real", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const run = runners();
    startRetentionTimers(settings(), run, scheduler);
    await scheduled[0]!.tick();
    expect(run.sweep).toHaveBeenCalledTimes(1);
    expect(run.purge).not.toHaveBeenCalled();
    await scheduled[1]!.tick();
    expect(run.purge).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it.each([
    ["busy", { kind: "busy", heldBy: "sweep-1" }, "info"],
    ["lease-lost", { kind: "lease-lost" }, "warn"],
    ["off", { kind: "off", why: "x" }, "info"],
  ] as const)("a tick that answers %s only logs, and the next tick still runs", async (_name, answer, level) => {
    const { scheduler, scheduled } = fakeScheduler();
    const run = runners();
    run.sweep.mockResolvedValueOnce(answer);
    run.purge.mockResolvedValueOnce(answer);
    startRetentionTimers(settings(), run, scheduler);
    for (const entry of scheduled) await expect(Promise.resolve(entry.tick())).resolves.toBeUndefined();
    expect(logger[level]).toHaveBeenCalledWith(expect.stringContaining(answer.kind));
    for (const entry of scheduled) await entry.tick();
    expect(run.sweep).toHaveBeenCalledTimes(2);
    expect(run.purge).toHaveBeenCalledTimes(2);
  });

  it("a tick that throws is logged and swallowed", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const run = runners();
    run.sweep.mockRejectedValueOnce(new Error("state store down"));
    startRetentionTimers(settings(), run, scheduler);
    await expect(Promise.resolve(scheduled[0]!.tick())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("state store down"), expect.anything());
  });

  it("skips a tick while the last one is still running", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const run = runners();
    let finish = () => {};
    run.sweep.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ kind: "done", runId: "r", outcome: "kept", report: {} }))));
    startRetentionTimers(settings(), run, scheduler);
    const first = scheduled[0]!.tick();
    await scheduled[0]!.tick();
    expect(run.sweep).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await scheduled[0]!.tick();
    expect(run.sweep).toHaveBeenCalledTimes(2);
  });

  it("stop cancels both timers", () => {
    const { scheduler, scheduled } = fakeScheduler();
    startRetentionTimers(settings(), runners(), scheduler).stop();
    expect(scheduled.map((s) => s.stopped)).toEqual([true, true]);
  });
});

describe("the default scheduler", () => {
  it("fires on the interval, stops when told, and does not hold the process open", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const timer = realScheduler.every(1000, tick);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    timer.stop();
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    const spy = vi.spyOn(globalThis, "setInterval");
    realScheduler.every(1000, tick).stop();
    const handle = spy.mock.results[0]!.value as { hasRef?: () => boolean };
    expect(handle.hasRef?.() ?? false).toBe(false);
  });
});

describe("registerRetention starts the timers", () => {
  it("schedules both on an enforcing stack and none on an off stack", () => {
    const { scheduler, scheduled } = fakeScheduler();
    registerRetention(retentionHarness().sdk as never, retentionHarness().kv, { env: { ...ENFORCE, AM_RETENTION_INTERVAL_MS: "7200000" }, scheduler });
    expect(scheduled.map((s) => s.ms)).toEqual([7_200_000, PURGE_INTERVAL_MS]);
    resetSummarizeVeto();
    const off = fakeScheduler();
    registerRetention(retentionHarness().sdk as never, retentionHarness().kv, { env: {}, scheduler: off.scheduler });
    expect(off.scheduled).toEqual([]);
  });

  it("the sweep tick runs a real enforcing sweep, and the purge tick runs a real purge, on the injected clock", async () => {
    const r = rig();
    const { scheduler, scheduled } = fakeScheduler();
    const cases = await anchor(r);
    await seedMemory(r, memory("m_expired"));
    const clock = { now: r.deps.now() };
    liveRoutes(r, clock, { env: { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases }, scheduler });

    await scheduled[0]!.tick();
    expect(await r.kv.get(KV.memories, "m_expired")).toBeNull();
    const [run] = await r.kv.list<{ id: string; held: number; outcome: string }>("mem:retention:runs");
    expect(run).toMatchObject({ outcome: "kept", held: 1 });

    clock.now = new Date(clock.now.getTime() + 2 * 86_400_000);
    await scheduled[1]!.tick();
    expect(await r.kv.listKeys("mem:retention:vault:" + run!.id)).toEqual([]);
    expect(await r.kv.get("mem:retention:runs", run!.id)).toMatchObject({ held: 0 });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { GuardedStateKV, ScopeReadInventory } from "../../../src/fork/scope-guard.js";
import { KV } from "../../../src/state/schema.js";
import type { StateKV } from "../../../src/state/kv.js";
import type { Session } from "../../../src/types.js";
import { activeDayCutoff, countActiveDaysAfter, loadActiveClock } from "../../../src/fork/retention/clock.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { retentionHarness } from "./harness.js";

const DAY = 86_400_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const TODAY = Math.floor(NOW.getTime() / DAY);
const startOf = (day: number) => new Date(day * DAY);
const at = (daysAgo: number, msIntoDay = 0) => new Date((TODAY - daysAgo) * DAY + msIntoDay);

describe("countActiveDaysAfter", () => {
  const days = [10, 12, 13, 20];
  it.each([
    ["the since day itself is not counted, active or not", 10, 20, 3],
    ["a since day before every active day counts them all", 9, 20, 4],
    ["a since day between active days", 11, 20, 3],
    ["days after today are not counted", 10, 19, 2],
    ["since is today", 20, 20, 0],
    ["since after today (clock skew)", 25, 20, 0],
    ["today before every active day", 1, 5, 0],
  ])("%s", (_name, since, today, expected) => {
    expect(countActiveDaysAfter(days, since, today)).toBe(expected);
  });

  it("is 0 for an empty list", () => {
    expect(countActiveDaysAfter([], 0, 100)).toBe(0);
  });
});

describe("activeDayCutoff", () => {
  const days = [10, 12, 13, 20];
  it.each([
    ["0 days is the day after today", 0, 20, 21],
    ["1 day is today when today is active", 1, 20, 20],
    ["the 2nd most recent active day", 2, 20, 13],
    ["all of them", 4, 20, 10],
    ["more days than exist", 5, 20, null],
    ["a day after today is skipped", 1, 19, 13],
    ["fewer than N once today moves back", 4, 19, null],
    ["0 days with idle today", 0, 14, 15],
  ])("%s", (_name, window, today, expected) => {
    expect(activeDayCutoff(days, window, today)).toBe(expected);
  });

  it("an empty project: the day after today for 0, null otherwise", () => {
    expect(activeDayCutoff([], 0, 20)).toBe(21);
    expect(activeDayCutoff([], 1, 20)).toBeNull();
  });
});

function session(id: string, project: string, startedAt: Date): Session {
  return { id, project, cwd: "/w", startedAt: startedAt.toISOString(), status: "completed", observationCount: 0 };
}

async function seedSessions(kv: StateKV, project: string, starts: Date[], prefix = project): Promise<void> {
  for (const [i, startedAt] of starts.entries()) await kv.set(KV.sessions, `${prefix}_${i}`, session(`${prefix}_${i}`, project, startedAt));
}

const MODES = ["plain", "AGENTMEMORY_SCOPE_GUARD=throw"] as const;

describe.each(MODES)("loadActiveClock (%s)", (mode) => {
  function setup() {
    const h = retentionHarness();
    const kv: StateKV = mode === "plain"
      ? h.kv
      : new GuardedStateKV(h.sdk as never, { backend: "redis" }, new ScopeReadInventory(), undefined, true);
    return { h, kv };
  }

  it("counts active days beyond the 50 the project session index keeps (120 sessions)", async () => {
    const { h, kv } = setup();
    await seedSessions(kv, "p", Array.from({ length: 120 }, (_, i) => at(i, 3_600_000)));
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("p", at(100))).toBe(100);
    expect(clock.activeDaysSince("p", at(119))).toBe(119);
    expect(clock.cutoffForActiveDays("p", 100)).toEqual(startOf(TODAY - 99));
    expect(clock.cutoffForActiveDays("p", 120)).toEqual(startOf(TODAY - 119));
    expect(clock.cutoffForActiveDays("p", 121)).toEqual(new Date(0));
    expect(h.stateOps.some((op) => op.includes("project-sessions"))).toBe(false);
  });

  it("makes one day per session day and keeps projects apart", async () => {
    const { kv } = setup();
    await seedSessions(kv, "a", [at(3, 1000), at(3, 50_000_000), at(1)]);
    await seedSessions(kv, "b", [at(5)]);
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("a", at(10))).toBe(2);
    expect(clock.activeDaysSince("b", at(10))).toBe(1);
    expect(clock.activeDaysSince("c", at(10))).toBe(0);
  });

  it("truncates to the UTC day: time of day never counts, and the since day itself is not counted", async () => {
    const { kv } = setup();
    await seedSessions(kv, "p", [at(4), at(2), at(0)]);
    const clock = await loadActiveClock(kv, () => NOW);

    const lateOnActiveDay = at(4, DAY - 1);
    const earlyOnActiveDay = at(4, 0);
    expect(clock.activeDaysSince("p", earlyOnActiveDay)).toBe(2);
    expect(clock.activeDaysSince("p", lateOnActiveDay)).toBe(2);
    expect(clock.activeDaysSince("p", at(3))).toBe(2);
    expect(clock.activeDaysSince("p", at(1))).toBe(1);
    expect(clock.activeDaysSince("p", at(0, 3_600_000))).toBe(0);
  });

  it("counts today when it is active and not when it is idle", async () => {
    const { kv } = setup();
    await seedSessions(kv, "active", [at(0), at(2)]);
    await seedSessions(kv, "idle", [at(2)]);
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("active", at(1))).toBe(1);
    expect(clock.cutoffForActiveDays("active", 1)).toEqual(startOf(TODAY));
    expect(clock.cutoffForActiveDays("idle", 1)).toEqual(startOf(TODAY - 2));
  });

  it("an idle project does not age: days without a session add nothing", async () => {
    const { kv } = setup();
    await seedSessions(kv, "p", [at(200), at(199)]);
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("p", at(250))).toBe(2);
    expect(clock.activeDaysSince("p", at(199))).toBe(0);
    expect(clock.activeDaysSince("p", at(150))).toBe(0);
  });

  it("the cutoff is the start of the Nth most recent active day: t is older exactly when t < cutoff", async () => {
    const { kv } = setup();
    await seedSessions(kv, "p", [at(0), at(1), at(4), at(9), at(10), at(40)]);
    const clock = await loadActiveClock(kv, () => NOW);

    const cutoff = clock.cutoffForActiveDays("p", 3);
    expect(cutoff).toEqual(startOf(TODAY - 4));
    expect(new Date(cutoff.getTime() - 1) < cutoff).toBe(true);
    expect(clock.activeDaysSince("p", new Date(cutoff.getTime() - 1))).toBeGreaterThanOrEqual(3);
    expect(clock.activeDaysSince("p", cutoff)).toBeLessThan(3);
  });

  it("agrees with the cutoff rule for every window and timestamp up to today", async () => {
    const { kv } = setup();
    await seedSessions(kv, "p", [at(0), at(2), at(3), at(7), at(30), at(31)]);
    const clock = await loadActiveClock(kv, () => NOW);

    for (let windowDays = 0; windowDays <= 8; windowDays++) {
      const cutoff = clock.cutoffForActiveDays("p", windowDays);
      for (let daysAgo = 0; daysAgo <= 40; daysAgo++) {
        for (const ms of [0, DAY - 1]) {
          const t = at(daysAgo, ms);
          expect(clock.activeDaysSince("p", t) >= windowDays, `window ${windowDays}, ${daysAgo} days ago +${ms}ms`).toBe(t < cutoff);
        }
      }
    }
  });

  it("N = 0: every timestamp up to the end of today is older, and the cutoff is the start of tomorrow", async () => {
    const { kv } = setup();
    await seedSessions(kv, "p", [at(5)]);
    const clock = await loadActiveClock(kv, () => NOW);

    const cutoff = clock.cutoffForActiveDays("p", 0);
    expect(cutoff).toEqual(startOf(TODAY + 1));
    expect(at(0, DAY - 1) < cutoff).toBe(true);
    expect(at(30) < cutoff).toBe(true);
    expect(clock.activeDaysSince("p", at(30))).toBeGreaterThanOrEqual(0);
  });

  it("an empty project has age 0, no cutoff beyond epoch, and a 0-day cutoff of tomorrow", async () => {
    const { kv } = setup();
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("none", at(500))).toBe(0);
    expect(clock.cutoffForActiveDays("none", 1)).toEqual(new Date(0));
    expect(clock.cutoffForActiveDays("none", 365)).toEqual(new Date(0));
    expect(clock.cutoffForActiveDays("none", 0)).toEqual(startOf(TODAY + 1));
  });

  it("clock skew: a session day after today is not counted and a timestamp after today is never older than a window", async () => {
    const { kv } = setup();
    await seedSessions(kv, "p", [at(3), at(-1), at(-4)]);
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("p", at(10))).toBe(1);
    expect(clock.cutoffForActiveDays("p", 1)).toEqual(startOf(TODAY - 3));
    expect(clock.cutoffForActiveDays("p", 2)).toEqual(new Date(0));
    expect(clock.activeDaysSince("p", at(-2))).toBe(0);
    for (const windowDays of [0, 1, 5]) {
      const cutoff = clock.cutoffForActiveDays("p", windowDays);
      expect(at(-2) < cutoff).toBe(false);
      expect(at(-1) < cutoff).toBe(false);
    }
  });

  it("an unreadable timestamp has age 0, and a session with no valid start day is skipped", async () => {
    const { kv } = setup();
    await kv.set(KV.sessions, "bad", { ...session("bad", "p", at(2)), startedAt: "not a date" });
    await seedSessions(kv, "p", [at(4)], "ok");
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("p", new Date("nope"))).toBe(0);
    expect(clock.activeDaysSince("p", at(10))).toBe(1);
  });

  it("keeps a day after its session is deleted, and writes the days only when they changed", async () => {
    const { h, kv } = setup();
    await seedSessions(kv, "p", [at(9), at(2)]);
    await loadActiveClock(kv, () => NOW);
    expect(h.store.get(RETENTION_KV.activeDays)?.get("p")).toEqual([TODAY - 9, TODAY - 2]);

    await kv.delete(KV.sessions, "p_0");
    const writes = vi.spyOn(kv, "set");
    const clock = await loadActiveClock(kv, () => NOW);

    expect(clock.activeDaysSince("p", at(20))).toBe(2);
    expect(writes).not.toHaveBeenCalled();
  });

  it("reads sessions in pages and never lists the whole sessions scope", async () => {
    const { h, kv } = setup();
    await seedSessions(kv, "p", Array.from({ length: 450 }, (_, i) => at(i % 60)));
    const list = vi.spyOn(kv, "list");
    await loadActiveClock(kv, () => NOW);

    expect(list).not.toHaveBeenCalled();
    expect(h.stateOps.filter((op) => op === `state::list ${KV.sessions}`)).toEqual([]);
  });
});

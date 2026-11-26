import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { logger } from "../../../src/logger.js";
import { registerRetention } from "../../../src/fork/retention/register.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import { runSweep } from "../../../src/fork/retention/sweep.js";
import { parseRetentionSettings } from "../../../src/fork/retention/settings.js";
import type { RetentionDeps } from "../../../src/fork/retention/satellites.js";
import type { RecallHarness } from "../../../src/fork/retention/recall-check.js";
import { retentionHarness } from "./harness.js";

const UNDECIDED: Array<[string, Record<string, string>]> = [
  ["settings unset", {}],
  ["only the mode set", { AM_RETENTION: "enforce" }],
  ["windows without grace", { AM_RETENTION: "enforce", AM_RETENTION_WINDOWS: "trim:45,obs:180,sup:180,cold:365" }],
  ["grace without windows", { AM_RETENTION: "enforce", AM_RETENTION_GRACE_DAYS: "30" }],
  ["a window missing", { AM_RETENTION: "enforce", AM_RETENTION_WINDOWS: "trim:45,obs:180,sup:180", AM_RETENTION_GRACE_DAYS: "30" }],
  ["windows decided, kill switch off", { AM_RETENTION: "off", AM_RETENTION_WINDOWS: "trim:45,obs:180,sup:180,cold:365", AM_RETENTION_GRACE_DAYS: "30" }],
];

const ENV_KEYS = ["AM_RETENTION", "AM_RETENTION_WINDOWS", "AM_RETENTION_GRACE_DAYS", "AM_RETENTION_RECALL_CASES", "AM_RETENTION_INTERVAL_MS"];

const refusingHarness: RecallHarness = {
  settle: async () => { throw new Error("recall harness touched"); },
  score: async () => { throw new Error("recall harness touched"); },
};

function refusingDeps(h: ReturnType<typeof retentionHarness>): RetentionDeps {
  const touched = (): never => { throw new Error("deps touched"); };
  return { sdk: h.sdk as never, kv: h.kv, search: touched, vectors: { canRead: true, read: touched }, now: touched };
}

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, "");
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSummarizeVeto();
});

describe.each(UNDECIDED)("a stack with %s (R15, off part)", (_name, env) => {
  it("runSweep returns off and touches no storage, index or harness, dry run or not", async () => {
    const h = retentionHarness();
    const settings = parseRetentionSettings(env);
    for (const dryRun of [true, false]) {
      const result = await runSweep(refusingDeps(h), settings, refusingHarness, { dryRun });
      expect(result).toMatchObject({ kind: "off" });
    }
    expect(h.calls).toEqual([]);
    expect(h.store.size).toBe(0);
  });

  it("mem::retention-sweep answers off with no state call and starts no timer", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const h = retentionHarness();
    const timers = vi.spyOn(globalThis, "setInterval");
    registerRetention(h.sdk as never, h.kv);
    const registered = [...h.functions.keys()];
    expect(registered).toContain("mem::retention-sweep");

    for (const payload of [{}, { dryRun: true }, { dryRun: false }]) {
      expect(await h.call("mem::retention-sweep", payload)).toMatchObject({ kind: "off" });
    }
    expect(h.calls.filter((id) => id.startsWith("state::"))).toEqual([]);
    expect(h.store.size).toBe(0);
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
  });
});

describe("registerRetention", () => {
  it("logs why an undecided stack is off, at warn level when the owner asked for enforce", () => {
    registerRetention(retentionHarness().sdk as never, retentionHarness().kv);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("AM_RETENTION"));
    expect(logger.warn).not.toHaveBeenCalled();

    resetSummarizeVeto();
    vi.stubEnv("AM_RETENTION", "enforce");
    registerRetention(retentionHarness().sdk as never, retentionHarness().kv);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("AM_RETENTION_WINDOWS"));
  });
});

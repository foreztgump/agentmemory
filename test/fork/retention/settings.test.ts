import { describe, expect, it } from "vitest";
import { parseRetentionSettings } from "../../../src/fork/retention/settings.js";

const WINDOWS = "trim:45,obs:180,sup:180,cold:365";
const decided = { AM_RETENTION: "enforce", AM_RETENTION_WINDOWS: WINDOWS, AM_RETENTION_GRACE_DAYS: "30" };

describe("parseRetentionSettings", () => {
  const off: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ["nothing set", {}, /AM_RETENTION/],
    ["kill switch off with everything decided", { ...decided, AM_RETENTION: "off" }, /AM_RETENTION/],
    ["mode is not enforce", { ...decided, AM_RETENTION: "dry" }, /AM_RETENTION/],
    ["windows and grace unset", { AM_RETENTION: "enforce" }, /AM_RETENTION_WINDOWS/],
    ["windows unset", { ...decided, AM_RETENTION_WINDOWS: undefined }, /AM_RETENTION_WINDOWS/],
    ["grace unset", { ...decided, AM_RETENTION_GRACE_DAYS: undefined }, /AM_RETENTION_GRACE_DAYS/],
    ["windows empty", { ...decided, AM_RETENTION_WINDOWS: "" }, /AM_RETENTION_WINDOWS/],
    ["one window missing", { ...decided, AM_RETENTION_WINDOWS: "trim:45,obs:180,sup:180" }, /cold/],
    ["every other window missing", { ...decided, AM_RETENTION_WINDOWS: "cold:365" }, /trim/],
    ["unknown window key", { ...decided, AM_RETENTION_WINDOWS: `${WINDOWS},keep:9` }, /keep/],
    ["duplicate window key", { ...decided, AM_RETENTION_WINDOWS: `${WINDOWS},obs:10` }, /obs/],
    ["window without a value", { ...decided, AM_RETENTION_WINDOWS: "trim:,obs:180,sup:180,cold:365" }, /trim/],
    ["window not a number", { ...decided, AM_RETENTION_WINDOWS: "trim:45d,obs:180,sup:180,cold:365" }, /trim/],
    ["negative window", { ...decided, AM_RETENTION_WINDOWS: "trim:-1,obs:180,sup:180,cold:365" }, /trim/],
    ["fractional window", { ...decided, AM_RETENTION_WINDOWS: "trim:4.5,obs:180,sup:180,cold:365" }, /trim/],
    ["zero window", { ...decided, AM_RETENTION_WINDOWS: "trim:0,obs:180,sup:180,cold:365" }, /trim/],
    ["window past a safe integer", { ...decided, AM_RETENTION_WINDOWS: "trim:99999999999999999999,obs:1,sup:1,cold:1" }, /trim/],
    ["grace not a number", { ...decided, AM_RETENTION_GRACE_DAYS: "thirty" }, /AM_RETENTION_GRACE_DAYS/],
    ["grace fractional", { ...decided, AM_RETENTION_GRACE_DAYS: "30.5" }, /AM_RETENTION_GRACE_DAYS/],
    ["grace negative", { ...decided, AM_RETENTION_GRACE_DAYS: "-30" }, /AM_RETENTION_GRACE_DAYS/],
    ["grace zero", { ...decided, AM_RETENTION_GRACE_DAYS: "0" }, /AM_RETENTION_GRACE_DAYS/],
    ["grace empty", { ...decided, AM_RETENTION_GRACE_DAYS: "" }, /AM_RETENTION_GRACE_DAYS/],
    ["interval malformed", { ...decided, AM_RETENTION_INTERVAL_MS: "weekly" }, /AM_RETENTION_INTERVAL_MS/],
    ["interval blank", { ...decided, AM_RETENTION_INTERVAL_MS: "  " }, /AM_RETENTION_INTERVAL_MS is blank/],
    ["interval past the timer limit, which Node would fire every 1 ms", { ...decided, AM_RETENTION_INTERVAL_MS: "2147483648" }, /AM_RETENTION_INTERVAL_MS must be at most 2147483647/],
    ["window with an extra colon", { ...decided, AM_RETENTION_WINDOWS: "trim:45:9,obs:180,sup:180,cold:365" }, /trim.*one colon/],
  ];

  it.each(off)("is off: %s", (_name, env, why) => {
    const settings = parseRetentionSettings(env);
    expect(settings.mode).toBe("off");
    if (settings.mode === "off") expect(settings.why).toMatch(why);
  });

  it("is enforcing once every window and the grace period are decided", () => {
    expect(parseRetentionSettings(decided)).toEqual({
      mode: "enforce",
      windows: { trimDays: 45, observationDays: 180, supersededDays: 180, coldDays: 365 },
      graceDays: 30,
      recallStopPoints: 2,
      firstRunObservationShare: 0.1,
      recallCasesPath: null,
      intervalMs: 604_800_000,
    });
  });

  it("reads the optional recall cases path and interval, and tolerates blanks around values", () => {
    const settings = parseRetentionSettings({
      AM_RETENTION: " enforce ",
      AM_RETENTION_WINDOWS: " trim:7 , obs:8,sup:9,cold:10 ",
      AM_RETENTION_GRACE_DAYS: " 14 ",
      AM_RETENTION_RECALL_CASES: " /data/cases.json ",
      AM_RETENTION_INTERVAL_MS: " 3600000 ",
    });
    expect(settings).toMatchObject({
      mode: "enforce",
      windows: { trimDays: 7, observationDays: 8, supersededDays: 9, coldDays: 10 },
      graceDays: 14,
      recallCasesPath: "/data/cases.json",
      intervalMs: 3_600_000,
    });
  });

  it("accepts an interval at the timer limit", () => {
    expect(parseRetentionSettings({ ...decided, AM_RETENTION_INTERVAL_MS: "2147483647" })).toMatchObject({ mode: "enforce", intervalMs: 2_147_483_647 });
  });

  it("reads an interval of 0 as manual only", () => {
    expect(parseRetentionSettings({ ...decided, AM_RETENTION_INTERVAL_MS: "0" })).toMatchObject({ mode: "enforce", intervalMs: 0 });
  });

  it("treats a blank recall cases path as none", () => {
    expect(parseRetentionSettings({ ...decided, AM_RETENTION_RECALL_CASES: "  " })).toMatchObject({ recallCasesPath: null });
  });
});

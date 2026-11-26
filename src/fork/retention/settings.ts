import type { Windows } from "./types.js";

/**
 * Parsed once at boot from env. A stack is `on` only when every window and the grace period are set:
 * an undecided stack has no windows to run with, so retention there does nothing (R15, buddy today).
 *
 *   AM_RETENTION=enforce|off                         (default off; the kill switch, design 7.8)
 *   AM_RETENTION_WINDOWS=trim:45,obs:180,sup:180,cold:365   project-active days (D1)
 *   AM_RETENTION_GRACE_DAYS=30                       (D2)
 *   AM_RETENTION_RECALL_CASES=/path/cases.json       golden recall cases (D5); none means report-only
 *   AM_RETENTION_INTERVAL_MS=604800000               weekly (D11); 0 = manual only
 */
export type RetentionSettings =
  | { readonly mode: "off"; readonly why: string }
  | {
      readonly mode: "enforce";
      readonly windows: Windows;
      readonly graceDays: number;
      /** recall@10 points a run may lose before it restores itself (D5: 2). */
      readonly recallStopPoints: number;
      /** First enforcing run moves at most this share of observations (design 7.5). */
      readonly firstRunObservationShare: number;
      readonly recallCasesPath: string | null;
      readonly intervalMs: number;
    };

/** Fixed, not configurable: rows per paged read (the sweep's memory bound, R12) and the pause between pages. */
export const RETENTION_PAGE_SIZE = 200;
export const RETENTION_PAGE_PAUSE_MS = 25;

export const RETENTION_SETTING_KEYS = [
  "AM_RETENTION",
  "AM_RETENTION_WINDOWS",
  "AM_RETENTION_GRACE_DAYS",
  "AM_RETENTION_RECALL_CASES",
  "AM_RETENTION_INTERVAL_MS",
] as const;

export type RetentionEnv = Partial<Record<(typeof RETENTION_SETTING_KEYS)[number], string>>;

const WEEK_MS = 604_800_000;
const WINDOW_KEYS = { trim: "trimDays", obs: "observationDays", sup: "supersededDays", cold: "coldDays" } as const;

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

function wholeNumber(raw: string, min: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min ? value : null;
}

function parseWindows(raw: string | undefined): Parsed<Windows> {
  if (raw === undefined || raw.trim() === "") return { ok: false, why: "AM_RETENTION_WINDOWS is not set" };
  const found = new Map<string, number>();
  for (const part of raw.split(",")) {
    const [key = "", value = "", ...rest] = part.split(":").map((piece) => piece.trim());
    if (!Object.hasOwn(WINDOW_KEYS, key)) return { ok: false, why: `AM_RETENTION_WINDOWS has an unknown key "${key}"` };
    if (found.has(key)) return { ok: false, why: `AM_RETENTION_WINDOWS repeats "${key}"` };
    const days = rest.length === 0 ? wholeNumber(value, 1) : null;
    if (days === null) return { ok: false, why: `AM_RETENTION_WINDOWS "${key}" must be a whole number of days, at least 1` };
    found.set(key, days);
  }
  const missing = Object.keys(WINDOW_KEYS).find((key) => !found.has(key));
  if (missing) return { ok: false, why: `AM_RETENTION_WINDOWS has no "${missing}" window` };
  return {
    ok: true,
    value: {
      trimDays: found.get("trim")!,
      observationDays: found.get("obs")!,
      supersededDays: found.get("sup")!,
      coldDays: found.get("cold")!,
    },
  };
}

export function retentionEnforceRequested(env: RetentionEnv): boolean {
  return env["AM_RETENTION"]?.trim().toLowerCase() === "enforce";
}

export function parseRetentionSettings(env: RetentionEnv): RetentionSettings {
  const off = (why: string): RetentionSettings => ({ mode: "off", why });
  if (!retentionEnforceRequested(env)) return off("AM_RETENTION is not enforce");

  const windows = parseWindows(env["AM_RETENTION_WINDOWS"]);
  if (!windows.ok) return off(windows.why);

  const graceRaw = env["AM_RETENTION_GRACE_DAYS"]?.trim();
  if (graceRaw === undefined) return off("AM_RETENTION_GRACE_DAYS is not set");
  const graceDays = wholeNumber(graceRaw, 1);
  if (graceDays === null) return off("AM_RETENTION_GRACE_DAYS must be a whole number of days, at least 1");

  const intervalRaw = env["AM_RETENTION_INTERVAL_MS"];
  const intervalMs = intervalRaw === undefined ? WEEK_MS : wholeNumber(intervalRaw.trim(), 1);
  if (intervalMs === null) return off("AM_RETENTION_INTERVAL_MS must be a whole number of milliseconds, at least 1");

  return {
    mode: "enforce",
    windows: windows.value,
    graceDays,
    recallStopPoints: 2,
    firstRunObservationShare: 0.1,
    recallCasesPath: env["AM_RETENTION_RECALL_CASES"]?.trim() || null,
    intervalMs,
  };
}

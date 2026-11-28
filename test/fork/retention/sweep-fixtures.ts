import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecallHarness, type RecallCase, type RecallHarness } from "../../../src/fork/retention/recall-check.js";
import type { RetentionDeps } from "../../../src/fork/retention/satellites.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { parseRetentionSettings, type RetentionSettings } from "../../../src/fork/retention/settings.js";
import { runSweep, type SweepRequest, type SweepResult } from "../../../src/fork/retention/sweep.js";
import type { RunId, Windows } from "../../../src/fork/retention/types.js";
import type { AuditEntry } from "../../../src/types.js";
import { KV } from "../../../src/state/schema.js";
import type { Rig } from "./move-fixtures.js";
import { ZERO } from "./plan-fixtures.js";

export const ENFORCE_ENV = { AM_RETENTION: "enforce", AM_RETENTION_WINDOWS: "trim:45,obs:180,sup:180,cold:365", AM_RETENTION_GRACE_DAYS: "30" };

export function writeCases(cases: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "retention-cases-")), "cases.json");
  writeFileSync(file, JSON.stringify(cases));
  return file;
}

export const settingsFor = (casesPath?: string): RetentionSettings =>
  parseRetentionSettings({ ...ENFORCE_ENV, ...(casesPath ? { AM_RETENTION_RECALL_CASES: casesPath } : {}) });

export interface IndexHarness extends RecallHarness {
  readonly saves: () => number;
}

/** The real recall harness over the rig's keyword index: what `mem::smart-search` would return, minus the access write. */
export function indexHarness(r: Rig, casesPath?: string): IndexHarness {
  let saves = 0;
  const runtime = Object.assign(r.runtime, { openPersistence: () => ({ scheduleSave: () => {}, save: async () => { saves++; } }) });
  const sdk = {
    trigger: async (req: { payload: { query: string } }) => ({
      results: (await runtime.keyword.search(req.payload.query, 10)).map((hit) => ({ obsId: hit.obsId })),
    }),
  };
  const real = createRecallHarness({ sdk: sdk as never, search: () => runtime as never }, casesPath ?? null);
  return { ...real, saves: () => saves };
}

export const sweep = (r: Rig, harness: RecallHarness, req: Partial<SweepRequest> & { dryRun: boolean }, deps: RetentionDeps = r.deps, settings: RetentionSettings = settingsFor("unused")): Promise<SweepResult> =>
  runSweep(deps, settings, harness, { windowsOverride: ZERO as Windows, graceDaysOverride: 30, pauseMs: 0, ...req });

export function done(result: SweepResult) {
  if (result.kind !== "done") throw new Error(`sweep did not finish: ${result.kind}`);
  return result;
}

export function auditEntries(r: Rig): AuditEntry[] {
  return [...r.h.store]
    .filter(([scope]) => scope.startsWith("mem:audit:") && scope !== "mem:audit:months")
    .flatMap(([, rows]) => [...rows.values()] as AuditEntry[]);
}

const OWN_SCOPE = /^mem:(retention:|audit:)/;

/**
 * Every user collection, whole: counts and content. Retention's own bookkeeping and the audit log are not user data,
 * and the observation stats and important-observation index are derived (they carry an update time). A scope emptied by a round trip equals one never made.
 */
export function userData(r: Rig): Record<string, unknown[]> {
  return Object.fromEntries(
    [...r.h.store]
      .filter(([scope, rows]) => !OWN_SCOPE.test(scope) && scope !== KV.obsStats && scope !== KV.obsImportant && rows.size > 0)
      .map(([scope, rows]) => [scope, [...rows].sort(([a], [b]) => a.localeCompare(b))] as const),
  );
}

export const indexSizes = (r: Rig) => ({ keyword: r.runtime.keyword.size, vector: r.runtime.vector.size });

export const vaultKeys = async (r: Rig, runId: RunId): Promise<string[]> => r.kv.listKeys(RETENTION_KV.vault(runId));

export const goldenCase = (id: string, query: string, evidence: string[], golden = true): RecallCase => ({ id, query, evidence, golden });

/** A stack whose first enforcing run is behind it, so the 10% cap does not apply (tiny fixtures would round to zero). */
export const uncapped = (r: Rig) => r.kv.set(RETENTION_KV.control, "enforced-runs", 1);

import type { RunReport } from "../../../src/fork/retention/report.js";

const STAGES = ["T", "O", "S", "X", "C"] as const;
const SIGNALS = ["pin", "importance", "deliberate-save", "cited-by-memory", "cited-by-insight", "cited-by-graph", "retrieved", "lesson", "memory-type"] as const;
const SEAL_REFUSALS = ["active", "recent-capture", "no-summary", "summary-out-of-date", "compression-pending", "no-session"] as const;

/** R1: the names of every report field that is absent or the wrong shape. Empty means the report is complete. */
export function missingReportFields(report: Partial<RunReport> | null | undefined): string[] {
  if (!report) return ["report"];
  const missing: string[] = [];
  const scalar = ["runId", "dryRun", "outcome", "resumed", "sealed", "injectedContext", "injectedContextScanned", "vectorUnreadable"] as const;
  for (const key of scalar) if (report[key] === undefined) missing.push(key);
  if (report.observationCap === undefined) missing.push("observationCap");
  for (const key of ["perStage", "samples"] as const) {
    const table = report[key] as Record<string, unknown> | undefined;
    for (const stage of STAGES) if (!table || table[stage] === undefined) missing.push(`${key}.${stage}`);
  }
  for (const stage of STAGES) {
    const row = report.perStage?.[stage] as Record<string, unknown> | undefined;
    for (const field of ["count", "bytes", "moved"]) if (typeof row?.[field] !== "number") missing.push(`perStage.${stage}.${field}`);
  }
  for (const key of ["protectionHits", "protectedSamples"] as const) {
    const table = report[key] as Record<string, unknown> | undefined;
    for (const signal of SIGNALS) if (!table || table[signal] === undefined) missing.push(`${key}.${signal}`);
  }
  for (const why of SEAL_REFUSALS) if (typeof report.undigested?.[why] !== "number") missing.push(`undigested.${why}`);
  if (report.perProject === undefined) missing.push("perProject");
  return missing;
}

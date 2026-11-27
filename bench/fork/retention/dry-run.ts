// R1 at full size: record the KV scope counts and the Qdrant point counts, run a dry sweep through the REST route,
// record them again, and compare. Prints JSON; exits 1 when a user scope or an index count changed (or could not be read), or the report lacks a field.
//   stage.sh run bench/fork/retention/dry-run.ts [--out /private/dry-run.json]
import { writeFileSync } from "node:fs";
import { am, arg, isBookkeeping, qdrantCounts, runSweepRoute, scopeCounts } from "./lib.js";
import { missingReportFields } from "./report-check.js";

const before = { kv: await scopeCounts(), search: await qdrantCounts() };
const sweep = await runSweepRoute(true);
const fetched = sweep.runId ? (await am("GET", `/agentmemory/retention/report?runId=${sweep.runId}`)).body : null;
const after = { kv: await scopeCounts(), search: await qdrantCounts() };

const changedUser: Record<string, [number, number]> = {};
const changedBookkeeping: Record<string, [number, number]> = {};
for (const family of new Set([...Object.keys(before.kv.records), ...Object.keys(after.kv.records)])) {
  const was = before.kv.records[family] ?? 0;
  const now = after.kv.records[family] ?? 0;
  if (was !== now) (isBookkeeping(family) ? changedBookkeeping : changedUser)[family] = [was, now];
}
const changedIndex = Object.keys({ ...before.search, ...after.search }).filter(
  (name) => JSON.stringify(before.search[name]) !== JSON.stringify(after.search[name]),
);
const countErrors = Object.entries({ ...before.search, ...after.search }).filter(([, c]) => c.denseError !== undefined).map(([name, c]) => `${name}: ${c.denseError}`);
const report = sweep.body?.report ?? fetched?.report;
const missing = missingReportFields(report);
const userRecords = Object.entries(before.kv.records).filter(([family]) => !isBookkeeping(family));
const result = {
  httpStatus: sweep.status,
  wallMs: sweep.ms,
  runId: sweep.runId,
  outcome: fetched?.run?.outcome ?? sweep.body?.outcome,
  httpNote: sweep.status === 504 ? "the route answered 504 at 180 s; the sweep went on and wallMs runs to the run's closedAt" : undefined,
  userScopeFamilies: userRecords.length,
  userRecordsTotal: userRecords.reduce((sum, [, n]) => sum + n, 0),
  userScopesChanged: changedUser,
  bookkeepingChanged: changedBookkeeping,
  indexBefore: before.search,
  indexAfter: after.search,
  indexChanged: changedIndex,
  indexCountErrors: countErrors,
  missingReportFields: missing,
  reportSummary: report && {
    perStage: report.perStage, sealed: report.sealed, undigested: report.undigested, protectionHits: report.protectionHits,
    observationCap: report.observationCap, injectedContext: report.injectedContext, injectedContextScanned: report.injectedContextScanned,
    projects: Object.keys(report.perProject ?? {}).length,
  },
  pass: (sweep.status === 200 || sweep.status === 504) && (fetched?.run?.outcome ?? sweep.body?.outcome) === "dry-run" && Object.keys(changedUser).length === 0 && changedIndex.length === 0 && countErrors.length === 0 && missing.length === 0,
  beforeKv: before.kv,
  afterKv: after.kv,
};
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify({ ...result, report }, null, 1));
console.log(JSON.stringify(result, null, 1));
process.exit(result.pass ? 0 : 1);

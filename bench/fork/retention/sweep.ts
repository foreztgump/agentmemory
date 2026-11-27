// One sweep through the REST route, timed. Prints a JSON summary (not the 20-sample lists).
//   stage.sh run bench/fork/retention/sweep.ts --dry|--enforce|--latest [--no-poll] [--out /private/<name>.json]
// When the HTTP call fails (a proxy timeout, a killed container), the script polls the report until the newest run is done.
import { writeFileSync } from "node:fs";
import { am, arg, flag, runSweepRoute } from "./lib.js";

const dryRun = !flag("enforce");
// --latest: do not call the route, summarise the newest run (a sweep that was triggered another way, as run-enforce.sh does with S12_DIRECT=1).
const res = flag("latest") ? { status: 200, ms: 0, body: {}, runId: undefined } : await runSweepRoute(dryRun, !flag("no-poll"));
const runId = res.runId;
if (res.status !== 200) console.error(`sweep call answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
const reportCall = await am("GET", runId ? `/agentmemory/retention/report?runId=${runId}` : "/agentmemory/retention/report", undefined, 120_000).catch(() => null);
const report = reportCall?.body;
const out = arg("out");
const full = report?.report;
const summary = {
  httpStatus: res.status,
  wallMs: res.ms,
  kind: res.body?.kind,
  runId: report?.run?.id ?? runId,
  outcome: report?.run?.outcome,
  phase: report?.run?.phase,
  startedAt: report?.run?.startedAt,
  closedAt: report?.run?.closedAt,
  held: report?.run?.held,
  graceEndsAt: report?.run?.graceEndsAt,
  restoredBecause: report?.run?.restoredBecause,
  perStage: full?.perStage,
  sealed: full?.sealed,
  undigested: full?.undigested,
  protectionHits: full?.protectionHits,
  observationCap: full?.observationCap,
  vectorUnreadable: full?.vectorUnreadable,
  recall: full?.recall,
  restored: full?.restored,
  why: full?.why,
  resumed: full?.resumed,
};
if (out) writeFileSync(out, JSON.stringify({ summary, report }, null, 1));
console.log(JSON.stringify(summary, null, 1));

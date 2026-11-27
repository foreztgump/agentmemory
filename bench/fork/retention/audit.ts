// The retention audit entries of one run (R13), one line each: operation, stage, planned, moved, outcome, restored.
//   stage.sh run bench/fork/retention/audit.ts --run ret_...
import { am, requireArg } from "./lib.js";

const runId = requireArg("run", "stage.sh run bench/fork/retention/audit.ts --run ret_...");
const PAGE = 1000;
const rows = [];
const truncated: string[] = [];
for (const operation of ["retention_seal", "retention_soft_delete", "retention_demote", "retention_restore", "retention_purge", "retention_pin"]) {
  const res = await am("GET", `/agentmemory/audit?operation=${operation}&limit=${PAGE}`);
  const page = res.body?.entries ?? [];
  // The route takes a limit and no cursor: a full page may have cut this run's entries off.
  if (res.status !== 200 || page.length >= PAGE) truncated.push(`${operation}: ${res.status === 200 ? `full page of ${PAGE}` : `status ${res.status}`}`);
  for (const entry of page) {
    const details = entry.details ?? {};
    if (details.runId === runId || (entry.targetIds ?? []).includes(runId)) {
      rows.push({ at: entry.timestamp, operation: entry.operation, stage: details.stage, planned: details.planned, moved: details.moved, outcome: details.outcome, restored: details.restored, reason: details.reason ?? details.why, count: details.count ?? details.restoredCount });
    }
  }
}
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
console.log(JSON.stringify({ runId, entries: rows.length, incomplete: truncated, rows }, null, 1));

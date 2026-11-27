// The retention audit entries of one run (R13), one line each: operation, stage, planned, moved, outcome, restored.
//   stage.sh run bench/fork/retention/audit.ts --run ret_...
import { am, arg } from "./lib.js";

const runId = arg("run")!;
const rows = [];
for (const operation of ["retention_seal", "retention_soft_delete", "retention_demote", "retention_restore", "retention_purge", "retention_pin"]) {
  const res = await am("GET", `/agentmemory/audit?operation=${operation}&limit=1000`);
  for (const entry of res.body?.entries ?? []) {
    const details = entry.details ?? {};
    if (details.runId === runId || (entry.targetIds ?? []).includes(runId)) {
      rows.push({ at: entry.timestamp, operation: entry.operation, stage: details.stage, planned: details.planned, moved: details.moved, outcome: details.outcome, restored: details.restored, reason: details.reason ?? details.why, count: details.count ?? details.restoredCount });
    }
  }
}
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
console.log(JSON.stringify({ runId, entries: rows.length, rows }, null, 1));

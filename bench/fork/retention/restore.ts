// Restore of a whole run by runId through the REST route, timed, while the lease is watched (docs/fork/retention-architecture.md,
// slice 4: "a restore of a full run under the lease, and whether the renewal interval holds").
//   stage.sh run bench/fork/retention/restore.ts --run ret_... [--out /private/restore.json]
// Every 2 s it reads the lease from Kvrocks (owner and heartbeatAt), and every 20 s it makes the calls that must be refused
// while the restore holds the lease: a sweep, a purge and a second restore. The purge is a real one (dryRun false), which is safe
// only while no run's grace has ended, and which must answer busy if the lease works. It reports the owners seen, the longest gap
// between two heartbeats (the stale limit is 300 s, the renewal timer fires every 100 s and the restore beats per batch),
// and the statuses of the competing calls.
import { writeFileSync } from "node:fs";
import { am, arg, redis, requireArg, sleep, text, type AmResponse } from "./lib.js";

const runId = requireArg("run", "stage.sh run bench/fork/retention/restore.ts --run ret_... [--out /private/restore.json]");
const r = await redis();
const owners = new Set<string>();
const beats: number[] = [];
let lastBeat = "";
let maxAgeMs = 0;
const competing: Array<{ at: number; call: string; status: number; body: string }> = [];
let done = false;
const started = Date.now();

async function watch(): Promise<void> {
  while (!done) {
    const raw = await r.call("HGET", "state:mem:retention:control", "lease");
    if (raw) {
      const lease = JSON.parse(text(raw)) as { owner: string; heartbeatAt: string };
      owners.add(lease.owner);
      maxAgeMs = Math.max(maxAgeMs, Date.now() - Date.parse(lease.heartbeatAt));
      if (lease.heartbeatAt !== lastBeat) {
        lastBeat = lease.heartbeatAt;
        beats.push(Date.parse(lease.heartbeatAt));
      }
    }
    await sleep(2000);
  }
}
async function compete(): Promise<void> {
  await sleep(10_000);
  while (!done) {
    for (const [call, path, body] of [
      ["sweep dry run", "/agentmemory/retention/sweep", { dryRun: true }],
      ["purge (enforcing)", "/agentmemory/retention/purge", { dryRun: false }],
      ["second restore", "/agentmemory/retention/restore", { runId }],
    ] as const) {
      const res = await am("POST", path, body, 60_000).catch((err) => ({ status: 0, body: String(err), ms: 0 }));
      competing.push({ at: Math.round((Date.now() - started) / 1000), call, status: res.status, body: JSON.stringify(res.body).slice(0, 160) });
    }
    await sleep(20_000);
  }
}
const watcher = watch();
const competitor = compete();
const res = await am("POST", "/agentmemory/retention/restore", { runId }).catch((err): AmResponse => ({ status: 0, body: { error: String(err) }, ms: Date.now() - started }));
// The route answers 504 at 180 s (the worker's invocation timeout) while the restore goes on holding the lease, so the wall time
// runs to the moment the lease is gone and the run's held count is zero. The audit entry the restore writes at its end dates it.
const httpMs = res.ms;
// A dead restore worker leaves `held` above 0 for good, so the wait stops after S12_POLL_MAX_MS and the result says `settled: false`.
let settled = true;
if (res.status === 504 || res.status === 0) {
  const settleDeadline = started + Number(process.env.S12_POLL_MAX_MS ?? 3 * 3600_000);
  for (;;) {
    const row = (await am("GET", `/agentmemory/retention/report?runId=${runId}`, undefined, 120_000).catch(() => null))?.body?.run;
    const lease = await r.call("HGET", "state:mem:retention:control", "lease");
    if (!lease && row && row.held === 0) break;
    if (Date.now() > settleDeadline) {
      settled = false;
      console.error(`restore of ${runId} never settled (lease gone: ${!lease}, held: ${row?.held})`);
      break;
    }
    await sleep(2000);
  }
}
const wallMs = Date.now() - started;
done = true;
await Promise.all([watcher, competitor]);
const lease = await r.call("HGET", "state:mem:retention:control", "lease");
const report = (await am("GET", `/agentmemory/retention/report?runId=${runId}`)).body;
const audit = (await am("GET", "/agentmemory/audit?operation=retention_restore&limit=20")).body?.entries?.find((e: any) => e.details?.runId === runId || (e.targetIds ?? []).includes(runId));
r.close();
const gaps = beats.slice(1).map((t, i) => t - beats[i]!);
const result = {
  httpStatus: res.status,
  httpMs,
  settled,
  wallMs,
  restore: res.body,
  restoreAudit: audit && { at: audit.timestamp, ...audit.details },
  startedAt: new Date(started).toISOString(),
  runAfter: { phase: report?.run?.phase, outcome: report?.run?.outcome, held: report?.run?.held, restoredBecause: report?.run?.restoredBecause },
  leaseOwnersSeen: [...owners],
  leaseOwnerPrefixes: [...owners].map((o) => o.split("-")[0]),
  heartbeatChanges: beats.length,
  longestGapBetweenHeartbeatsMs: gaps.length ? Math.max(...gaps) : null,
  oldestHeartbeatSeenMs: maxAgeMs,
  staleLimitMs: 300_000,
  leaseAfter: lease ? text(lease) : null,
  competingCalls: competing,
  competingStatusSummary: Object.fromEntries([...new Set(competing.map((c) => `${c.call} ${c.status}`))].map((k) => [k, competing.filter((c) => `${c.call} ${c.status}` === k).length])),
};
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));

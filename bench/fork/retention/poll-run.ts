// Prints the newest retention run row from Kvrocks as one JSON line: id, phase, outcome, held, moved per stage, cursor.
//   stage.sh run bench/fork/retention/poll-run.ts [--after <ISO time>]   (only runs started at or after the time; prints nothing when there is none)
import { arg, redis, text } from "./lib.js";

const r = await redis();
const flat = (await r.call("HGETALL", "state:mem:retention:runs")) as Buffer[];
const rows = [];
for (let i = 1; i < flat.length; i += 2) rows.push(JSON.parse(text(flat[i]!)));
const after = arg("after");
rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
if (after) rows.splice(0, rows.length, ...rows.filter((row) => row.startedAt >= after));
const lease = await r.call("HGET", "state:mem:retention:control", "lease");
r.close();
const run = rows[0];
console.log(JSON.stringify(run && {
  id: run.id, dryRun: run.dryRun, phase: run.phase, outcome: run.outcome, held: run.held, startedAt: run.startedAt, closedAt: run.closedAt ?? null,
  moved: Object.fromEntries(Object.entries(run.counters as Record<string, { moved: number }>).map(([k, v]) => [k, v.moved])),
  cap: run.observationCap, cursor: run.cursor, ranBy: run.ranBy, lease: lease ? JSON.parse(text(lease as Buffer)) : null, runs: rows.length,
}));

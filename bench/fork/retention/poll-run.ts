// Prints the newest retention run row from Kvrocks as one JSON line: id, phase, outcome, held, moved per stage, cursor.
//   stage.sh run bench/fork/retention/poll-run.ts
import { redis, text } from "./lib.js";

const r = await redis();
const flat = (await r.call("HGETALL", "state:mem:retention:runs")) as Buffer[];
const rows = [];
for (let i = 1; i < flat.length; i += 2) rows.push(JSON.parse(text(flat[i]!)));
rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
const lease = await r.call("HGET", "state:mem:retention:control", "lease");
r.close();
const run = rows[0];
console.log(JSON.stringify(run && {
  id: run.id, dryRun: run.dryRun, phase: run.phase, outcome: run.outcome, held: run.held, startedAt: run.startedAt, closedAt: run.closedAt ?? null,
  moved: Object.fromEntries(Object.entries(run.counters as Record<string, { moved: number }>).map(([k, v]) => [k, v.moved])),
  cap: run.observationCap, cursor: run.cursor, ranBy: run.ranBy, lease: lease ? JSON.parse(text(lease as Buffer)) : null, runs: rows.length,
}));

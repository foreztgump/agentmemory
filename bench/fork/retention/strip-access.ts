// R9 forced loss. The recall check records an access for every hit (smart-search records the top 10), and the sweep's `retrieved`
// signal protects whatever was accessed since the cold window, so an evidence row the check just found is never moved. The design
// says R9 then fires on collateral loss only. To make the sweep move the evidence anyway, this script waits for the
// run's before-score (the draft report's recall verdict is "pending"), then deletes the access logs of the cases' evidence ids from
// mem:access, as if they had never been retrieved. Everything after that is the sweep's own work: it plans, clears and moves the
// evidence, and the after-check finds the golden cases lost.
//   stage.sh run bench/fork/retention/strip-access.ts --cases /private/cases.json [--after <ISO time>]
// Run it beside `sweep.ts --enforce`. Polls Kvrocks every 100 ms. Prints when it saw the verdict and which fields it deleted.
import { readFileSync } from "node:fs";
import { arg, redis, requireArg, sleep, text } from "./lib.js";

const cases = (JSON.parse(readFileSync(requireArg("cases", "stage.sh run bench/fork/retention/strip-access.ts --cases /private/cases.json [--after <ISO time>]"), "utf8")) as { cases: Array<{ id: string; evidence: string[] }> }).cases;
const ids = [...new Set(cases.flatMap((c) => c.evidence))];
const after = arg("after") ?? new Date().toISOString();
const r = await redis();
const deadline = Date.now() + 20 * 60_000;
let seen = "";
while (Date.now() < deadline) {
  const flat = (await r.call("HGETALL", "state:mem:retention:runs")) as Buffer[];
  const runs = [];
  for (let i = 1; i < flat.length; i += 2) runs.push(JSON.parse(text(flat[i]!)));
  const run = runs.filter((x) => !x.dryRun && x.startedAt >= after).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (run) {
    const raw = await r.call("HGET", "state:mem:retention:reports", run.id);
    const verdict = raw ? JSON.parse(text(raw as Buffer))?.recall?.verdict : undefined;
    if (verdict === "pending") {
      const at = new Date().toISOString();
      const before = await Promise.all(ids.map(async (id) => ((await r.call("HEXISTS", "state:mem:access", id)) as number) === 1));
      const deleted = (await r.call("HDEL", "state:mem:access", ...ids)) as number;
      const phase = JSON.parse(text((await r.call("HGET", "state:mem:retention:runs", run.id)) as Buffer)).phase;
      console.log(JSON.stringify({ runId: run.id, sawPendingAt: at, phaseAtStrip: phase, evidenceIds: ids.length, hadAccessLog: before.filter(Boolean).length, deleted }));
      r.close();
      process.exit(0);
    }
    seen = `${run.id} phase=${run.phase}`;
  }
  await sleep(100);
}
console.error(`no pending recall verdict seen; last ${seen}`);
r.close();
process.exit(1);

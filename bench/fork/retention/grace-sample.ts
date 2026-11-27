// Picks the refs that part 2 follows from a closed, kept run: 10 stage O observations spread over the run's vault, 5 in group A
// (restored at 23 h) and 5 in group B (purged at 25 h), and writes the grace file refs-check.ts reads.
//   stage.sh run bench/fork/retention/grace-sample.ts --run ret_... --out /private/grace.json
import { writeFileSync } from "node:fs";
import type { VaultEntry } from "../../../src/fork/retention/types.js";
import { am, arg, redis, text } from "./lib.js";

const runId = arg("run")!;
const r = await redis();
const total = (await r.call("HLEN", `state:mem:retention:vault:${runId}`)) as number;
const picked: VaultEntry[] = [];
let cursor = "0";
let seen = 0;
const stride = Math.max(1, Math.floor(total / 10));
do {
  const reply = (await r.call("HSCAN", `state:mem:retention:vault:${runId}`, cursor, "COUNT", "200")) as Array<any>;
  cursor = text(reply[0]);
  const flat = reply[1] as Buffer[];
  for (let i = 0; i < flat.length && picked.length < 10; i += 2) {
    const entry = JSON.parse(text(flat[i + 1]!)) as VaultEntry;
    if (entry.stage === "O" && seen++ % stride === 0) picked.push(entry);
  }
} while (cursor !== "0" && picked.length < 10);
r.close();
const run = (await am("GET", `/agentmemory/retention/report?runId=${runId}`)).body?.run;
const refs = picked.map((entry, i) => ({ group: i % 2 === 0 ? "A" : "B", ref: entry.ref, title: entry.stage === "O" ? (entry.row.title ?? null) : null }));
const file = { runId, closedAt: run?.closedAt, graceEndsAt: run?.graceEndsAt, graceDays: run?.graceDays, held: run?.held, vaultEntries: total, refs };
writeFileSync(arg("out")!, JSON.stringify(file, null, 1));
console.log(JSON.stringify(file, null, 1));

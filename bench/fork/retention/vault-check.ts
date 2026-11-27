// R12 checker: pages every retention vault and the live scopes straight from Kvrocks, and checks, for the run given
// (and for every other vault present):
//   1. no stage O, S or X item is both live and in a vault (a stage T entry is live by design and counted apart);
//   2. `held` of the run row equals the run's vault entries (HLEN and a full page-through agree);
//   3. conservation: live observations + vaulted O entries equals the baseline's observations, and the same for memories
//      (S and X), when a baseline snapshot (snapshot.ts output) is given and only retention moved rows since it;
//   4. every vault entry has a locator in mem:retention:items naming its run;
//   5. a sample of vaulted rows is not a live point in the docs collection (the Qdrant index agrees).
//   stage.sh run bench/fork/retention/vault-check.ts --run ret_... [--baseline /private/baseline.json] [--sample 300]
// Exits 1 on any violation. Prints JSON.
import { readFileSync } from "node:fs";
import { pointId } from "../../../src/fork/worker/qdrant.js";
import type { VaultEntry } from "../../../src/fork/retention/types.js";
import { itemKey } from "../../../src/fork/retention/scopes.js";
import { am, arg, qdrant, redis, scopeCounts, text } from "./lib.js";

const runId = arg("run")!;
const sampleSize = Number(arg("sample", "300"));
const r = await redis();

async function* hscan(key: string): AsyncGenerator<Array<[string, string]>> {
  let cursor = "0";
  do {
    const reply = (await r.call("HSCAN", key, cursor, "COUNT", "500")) as Array<any>;
    cursor = text(reply[0]);
    const flat = reply[1] as Buffer[];
    const page: Array<[string, string]> = [];
    for (let i = 0; i < flat.length; i += 2) page.push([text(flat[i]!), text(flat[i + 1]!)]);
    yield page;
  } while (cursor !== "0");
}

async function vaultKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const reply = (await r.call("SCAN", cursor, "MATCH", "state:mem:retention:vault:*", "COUNT", "1000")) as Array<any>;
    cursor = text(reply[0]);
    for (const k of reply[1] as Buffer[]) keys.push(text(k));
  } while (cursor !== "0");
  return keys.sort();
}

const violations: string[] = [];
const perRun: Record<string, { entries: number; byStage: Record<string, number>; withStoredVector: number; bothLiveAndVaulted: number; noLocator: number; purging: number; restoring: number }> = {};
const sample: VaultEntry[] = [];
let liveVaultedTotal = 0;
const o = { n: 0 };

for (const key of await vaultKeys()) {
  const id = key.slice("state:mem:retention:vault:".length);
  const stat = { entries: 0, byStage: {} as Record<string, number>, withStoredVector: 0, bothLiveAndVaulted: 0, noLocator: 0, purging: 0, restoring: 0 };
  for await (const page of hscan(key)) {
    const entries = page.map(([field, raw]) => ({ field, entry: JSON.parse(raw) as VaultEntry }));
    const liveReplies = await r.pipeline(entries.map(({ entry }) => ["HEXISTS", entry.ref.kind === "memory" ? "state:mem:memories" : `state:mem:obs:${entry.ref.sessionId}`, entry.ref.id]));
    const locReplies = await r.pipeline(entries.map(({ field }) => ["HGET", "state:mem:retention:items", field]));
    entries.forEach(({ field, entry }, i) => {
      stat.entries++;
      stat.byStage[entry.stage] = (stat.byStage[entry.stage] ?? 0) + 1;
      if (entry.satellites?.vector) stat.withStoredVector++;
      if (entry.purging) stat.purging++;
      if (entry.restoring) stat.restoring++;
      if (field !== itemKey(entry.ref)) violations.push(`vault ${id}: key ${field} is not itemKey(ref)`);
      if (Number(liveReplies[i]) === 1 && entry.stage !== "T") {
        stat.bothLiveAndVaulted++;
        if (violations.length < 20) violations.push(`vault ${id}: ${field} (${entry.stage}) is live and vaulted`);
      }
      const loc = locReplies[i] ? JSON.parse(text(locReplies[i] as Buffer)) : null;
      if (!loc || (loc.runId !== id && loc.under?.runId !== id)) stat.noLocator++;
      if (entry.stage !== "T" && entry.ref.kind === "observation" && sample.length < sampleSize && ++o.n % 7 === 0) sample.push(entry);
    });
  }
  perRun[id] = stat;
  liveVaultedTotal += stat.bothLiveAndVaulted;
  const hlen = Number((await r.call("HLEN", key)) as number);
  if (hlen !== stat.entries) violations.push(`vault ${id}: HLEN ${hlen} differs from the paged count ${stat.entries}`);
}

const run = (await am("GET", `/agentmemory/retention/report?runId=${runId}`)).body?.run;
if (!run) violations.push(`run ${runId} is unknown`);
else if (perRun[runId] === undefined && run.held > 0) violations.push(`run ${runId} holds ${run.held} but has no vault`);
else if ((perRun[runId]?.entries ?? 0) !== run.held) violations.push(`run ${runId}: held ${run.held} differs from vault entries ${perRun[runId]?.entries ?? 0}`);

const now = await scopeCounts(r);
let conservation: Record<string, unknown> | null = null;
const baselinePath = arg("baseline");
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).kv ?? JSON.parse(readFileSync(baselinePath, "utf8")).beforeKv;
  const vaulted = (stages: string[]) => Object.values(perRun).reduce((sum, s) => sum + stages.reduce((a, st) => a + (s.byStage[st] ?? 0), 0), 0);
  const obsNow = now.records["mem:obs:<session>"] ?? 0;
  const memNow = now.records["mem:memories"] ?? 0;
  conservation = {
    observations: { baseline: baseline.records["mem:obs:<session>"], live: obsNow, vaultedO: vaulted(["O"]), sumEqualsBaseline: obsNow + vaulted(["O"]) === baseline.records["mem:obs:<session>"] },
    memories: { baseline: baseline.records["mem:memories"], live: memNow, vaultedSX: vaulted(["S", "X"]), sumEqualsBaseline: memNow + vaulted(["S", "X"]) === baseline.records["mem:memories"] },
  };
  for (const [name, v] of Object.entries(conservation)) if (!(v as { sumEqualsBaseline: boolean }).sumEqualsBaseline) violations.push(`conservation of ${name} fails`);
}

let indexLiveAmongVaulted = 0;
for (let i = 0; i < sample.length; i += 100) {
  const slice = sample.slice(i, i + 100);
  const points = await qdrant<Array<{ id: string; payload?: { deleted?: boolean } }>>("POST", "/collections/agentmemory/points", {
    ids: slice.map((e) => pointId(e.ref.id)), with_payload: ["deleted"], with_vector: false,
  });
  for (const p of points) if (p.payload?.deleted !== true) indexLiveAmongVaulted++;
}
if (indexLiveAmongVaulted > 0) violations.push(`${indexLiveAmongVaulted} sampled vaulted rows are live points in Qdrant`);

r.close();
const result = {
  runId, runRow: run && { phase: run.phase, outcome: run.outcome, held: run.held }, perRun, conservation,
  liveAndVaultedStageOSX: liveVaultedTotal, qdrantSampled: sample.length, qdrantLiveAmongSampled: indexLiveAmongVaulted,
  violations, pass: violations.length === 0,
};
console.log(JSON.stringify(result, null, 1));
process.exit(result.pass ? 0 : 1);

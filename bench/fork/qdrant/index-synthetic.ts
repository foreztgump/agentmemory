// Writes the synthetic corpus of generate.ts (same seed, same order) straight into
// the am-search collection, for the recall eval on AM_SEARCH_BACKEND=disk. Disk
// mode has no boot rebuild, and the backfill from KV is TEE-1169's.
//
//   node --import tsx bench/fork/qdrant/index-synthetic.ts --count 50000 --profile bench/fork/profiles/buddy-2026-11-16.json \
//     [--qdrant http://127.0.0.1:16335] [--qdrant-key stack-dummy-qdrant-key] [--dimensions 384]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { contentRev, type DocOp } from "../../../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { termSourceOf } from "../../../src/state/term-extraction.js";
import type { CompressedObservation } from "../../../src/types.js";
import { Generator, plant, type Observation, type Profile } from "../lib/synthetic.js";

const { values: args } = parseArgs({
  options: {
    count: { type: "string" },
    seed: { type: "string", default: "1155" },
    profile: { type: "string" },
    qdrant: { type: "string", default: "http://127.0.0.1:16335" },
    "qdrant-key": { type: "string", default: "stack-dummy-qdrant-key" },
    collection: { type: "string", default: "agentmemory" },
    dimensions: { type: "string", default: "384" },
  },
});
const count = Number(args.count);
if (!args.profile || !Number.isInteger(count) || count <= 0) throw new Error("--count N and --profile are required");
const profile = JSON.parse(readFileSync(args.profile, "utf8")) as Profile;
const seed = Number(args.seed);

const qdrant = new Qdrant({
  url: args.qdrant, apiKey: args["qdrant-key"], collection: args.collection,
  dimensions: Number(args.dimensions), oversampling: 6, timeoutMs: 60_000,
});
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);

let batch: DocOp[] = [];
let written = 0;
async function add(obs: Observation): Promise<void> {
  const fields = termSourceOf(obs as unknown as CompressedObservation);
  batch.push({ k: "doc", id: obs.id, sessionId: obs.sessionId, layer: "observation", ts: Date.parse(obs.timestamp), rev: contentRev(fields), fields });
  if (batch.length >= 512) await flush();
}
async function flush(): Promise<void> {
  if (batch.length === 0) return;
  const result = await engine.apply(batch);
  if (result.failed.length > 0 || result.applied !== batch.length) throw new Error(`apply: ${JSON.stringify(result)}`);
  written += batch.length;
  batch = [];
}

const started = performance.now();
const planted = plant(new Generator(profile, profile.indexable, seed));
if (count < planted.observations.length) throw new Error(`--count ${count} is below the ${planted.observations.length} planted observations the eval cases need`);
for (const obs of planted.observations) await add(obs);
const gen = new Generator(profile, count, seed + 1);
let generated = planted.observations.length;
for (let s = 0; generated < count; s++) {
  const session = gen.session(s);
  const size = Math.min(gen.sessionSize(), count - generated);
  for (let i = 0; i < size; i++) await add(gen.observation(session, i * 30_000));
  generated += size;
}
await flush();
console.log(JSON.stringify({ written, seconds: Math.round((performance.now() - started) / 1000), stats: await engine.stats() }));

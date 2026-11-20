// Qdrant's memory while the disk search index is filled from empty, from
// synthetic documents, then held until the optimizer settles. --path load (the
// default) writes each document with a 1024-float vector the way search-migrate
// fill does (SearchEngine.load, one page per upsert, the corpus mean preset,
// waiting for the optimizer every OPTIMIZER_GATE_DOCS).
// --path apply writes documents with no vector the way reconcile does
// (SearchEngine.apply in outbox batches of 256, from the default mean, so the
// worker's reweighting passes run as on a live stack). The container's cgroup is sampled from the host every 200 ms.
// The collection is the worker's own (Qdrant.create); --during and --after
// PATCH it before and after the load, to try another optimizer setting.
//
// The guard (docs/fork/search-migration.md, "Qdrant memory during a fill"), on a
// fresh Qdrant 1.20.2 with a 1g limit and swap off:
//   docker run -d --name fill-qdrant -m 1g --memory-swap 1g -p 127.0.0.1:16401:6333 qdrant/qdrant:v1.20.2
//   node --import tsx bench/fork/qdrant/fill-memory.ts --count 200000 --container fill-qdrant --ceiling-mib 610
//   node --import tsx bench/fork/qdrant/fill-memory.ts --path apply --count 200000 --container fill-qdrant --ceiling-mib 620
// (a fresh container for each run).
//
// Prints one JSON line. Exits 1 when Qdrant was OOM-killed, died, or its anon
// peak passed --ceiling-mib. The ceiling is on anon memory, sampled, because
// memory.peak also counts page cache, which the cgroup reclaims at its limit
// and which reaches the limit on every fill.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { OPTIMIZER_GATE_DOCS, waitForOptimizer } from "../../../scripts/fork/search-migrate.js";
import { contentRev, type DocOp } from "../../../src/fork/search/protocol.js";
import { DEFAULT_OUTBOX_LIMITS } from "../../../src/fork/search/outbox.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { termSourceOf } from "../../../src/state/term-extraction.js";
import type { CompressedObservation } from "../../../src/types.js";
import { Generator, type Profile } from "../lib/synthetic.js";
import { mulberry32 } from "../lib/stats.js";

const { values: args } = parseArgs({
  options: {
    count: { type: "string" },
    container: { type: "string" },
    profile: { type: "string", default: "bench/fork/profiles/buddy-2026-11-16.json" },
    qdrant: { type: "string", default: "http://127.0.0.1:16401" },
    "qdrant-key": { type: "string" },
    collection: { type: "string", default: "agentmemory" },
    dimensions: { type: "string", default: "1024" },
    path: { type: "string", default: "load" },
    page: { type: "string" },
    seed: { type: "string", default: "1201" },
    "ceiling-mib": { type: "string" },
    "settle-timeout-s": { type: "string", default: "1800" },
    during: { type: "string" },
    after: { type: "string" },
  },
});
const count = Number(args.count);
if (args.path !== "load" && args.path !== "apply") throw new Error("--path must be load or apply");
const viaApply = args.path === "apply";
const page = Number(args.page ?? (viaApply ? DEFAULT_OUTBOX_LIMITS.batch : 200));
const dimensions = Number(args.dimensions);
const ceiling = args["ceiling-mib"] === undefined ? null : Number(args["ceiling-mib"]);
if (!Number.isInteger(count) || count <= 0) throw new Error("--count N is required");
if (!args.container) throw new Error("--container is required: the Qdrant container whose cgroup is sampled");
if (!Number.isInteger(page) || page <= 0) throw new Error("--page must be a positive integer");
if (ceiling !== null && !(ceiling > 0)) throw new Error("--ceiling-mib must be a positive number");
const settleTimeoutS = Number(args["settle-timeout-s"]);
if (!(settleTimeoutS > 0)) throw new Error("--settle-timeout-s must be a positive number");
/** Buddy's mean term count, which search-migrate fill weights its documents with. */
const AVGDL = 35.8;

const cgroupDir = (() => {
  const id = execFileSync("docker", ["inspect", "-f", "{{.Id}}", args.container!], { encoding: "utf8" }).trim();
  const found = execFileSync("find", ["/sys/fs/cgroup", "-maxdepth", "8", "-type", "d", "-name", `*${id}*`], { encoding: "utf8" }).trim().split("\n")[0];
  if (!found) throw new Error(`no cgroup found for container ${args.container}`);
  return found;
})();

const MiB = 1024 * 1024;
const limitMiB = (() => {
  const max = readFileSync(`${cgroupDir}/memory.max`, "utf8").trim();
  return max === "max" ? null : Math.round(Number(max) / MiB);
})();
interface Sample { current: number; anon: number; oomKills: number }
function sample(): Sample | null {
  try {
    const stat = readFileSync(`${cgroupDir}/memory.stat`, "utf8");
    const field = (text: string, name: string) => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(text)?.[1] ?? 0);
    return {
      current: Number(readFileSync(`${cgroupDir}/memory.current`, "utf8")),
      anon: field(stat, "anon"),
      oomKills: field(readFileSync(`${cgroupDir}/memory.events`, "utf8"), "oom_kill"),
    };
  } catch {
    return null;
  }
}

const peaks = { current: 0, anon: 0, anonDuringLoad: 0, oomKills: 0 };
let loading = true;
let gone = false;
let missed = 0;
const timer = setInterval(() => {
  const s = sample();
  if (!s) {
    gone = ++missed >= 2;
    return;
  }
  missed = 0;
  peaks.current = Math.max(peaks.current, s.current);
  peaks.anon = Math.max(peaks.anon, s.anon);
  if (loading) peaks.anonDuringLoad = Math.max(peaks.anonDuringLoad, s.anon);
  peaks.oomKills = s.oomKills;
}, 200);

const qdrant = new Qdrant({ url: args.qdrant!, apiKey: args["qdrant-key"], collection: args.collection!, dimensions, oversampling: 6, timeoutMs: 120_000 });
await qdrant.drop();
const engine = new SearchEngine(qdrant, viaApply ? DEFAULT_AVGDL : AVGDL);
const patch = async (body: string | undefined) => { if (body) await qdrant.call("PATCH", qdrant.path, JSON.parse(body)); };
await qdrant.ensure();
await patch(args.during);

const profile = JSON.parse(readFileSync(args.profile!, "utf8")) as Profile;
const gen = new Generator(profile, count, Number(args.seed));
const random = mulberry32(Number(args.seed));
function vector(): string {
  const v = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) v[i] = random() - 0.5;
  return Buffer.from(v.buffer).toString("base64");
}

const started = performance.now();
let written = 0;
let sinceGate = 0;
let batch: Array<{ doc: DocOp; f32b64?: string }> = [];
async function flush(): Promise<void> {
  if (batch.length === 0) return;
  const result = viaApply ? await engine.apply(batch.map((b) => b.doc)) : await engine.load(batch, 1, AVGDL);
  if (result.failed.length > 0) throw new Error(`${args.path} failed: ${JSON.stringify(result.failed[0])}`);
  written += batch.length;
  sinceGate += batch.length;
  if (!viaApply && sinceGate >= OPTIMIZER_GATE_DOCS) {
    sinceGate = 0;
    await waitForOptimizer(qdrant);
  }
  batch = [];
}
let failure: string | null = null;
try {
  for (let s = 0; written + batch.length < count; s++) {
    const session = gen.session(s);
    const size = Math.min(gen.sessionSize(), count - written - batch.length);
    for (let i = 0; i < size; i++) {
      const obs = gen.observation(session, i * 30_000);
      const fields = termSourceOf(obs as unknown as CompressedObservation);
      batch.push({ doc: { k: "doc", id: obs.id, sessionId: obs.sessionId, layer: "observation", ts: Date.parse(obs.timestamp), rev: contentRev(fields), fields }, f32b64: viaApply ? undefined : vector() });
      if (batch.length >= page) await flush();
    }
  }
  await flush();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
if (!failure) await engine.settled();
const loadSeconds = (performance.now() - started) / 1000;
loading = false;
if (!failure && !gone) await patch(args.after).catch((error) => { failure = `after: ${error instanceof Error ? error.message : String(error)}`; });

let info: { status?: string; segments_count?: number; points_count?: number; indexed_vectors_count?: number } = {};
const settleBy = Date.now() + settleTimeoutS * 1000;
while (!failure && !gone) {
  try {
    info = await qdrant.call("GET", qdrant.path);
  } catch (error) {
    failure = `collection info: ${error instanceof Error ? error.message : String(error)}`;
    break;
  }
  if (info.status === "green") break;
  if (Date.now() > settleBy) {
    failure = `optimizer still ${info.status} after the settle timeout`;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const totalSeconds = (performance.now() - started) / 1000;
await new Promise((r) => setTimeout(r, 400));
clearInterval(timer);

let cgroupPeak: number | null = null;
try { cgroupPeak = Number(readFileSync(`${cgroupDir}/memory.peak`, "utf8")); } catch { /* the container is gone */ }
const mib = (n: number | null) => (n === null ? null : Math.round(n / MiB));
const report = {
  path: args.path, count, written, page, limitMiB, loadSeconds: Math.round(loadSeconds), totalSeconds: Math.round(totalSeconds),
  qdrant: { status: info.status, segments: info.segments_count, points: info.points_count, indexedVectors: info.indexed_vectors_count },
  memMiB: { cgroupPeak: mib(cgroupPeak), currentMax: mib(peaks.current), anonMax: mib(peaks.anon), anonMaxDuringLoad: mib(peaks.anonDuringLoad) },
  oomKills: peaks.oomKills, containerGone: gone, failure, ceilingMiB: ceiling,
};
console.log(JSON.stringify(report));
const over = ceiling !== null && peaks.anon / MiB > ceiling;
if (over) console.error(`FAIL Qdrant anon peak ${mib(peaks.anon)} MiB above the ceiling ${ceiling} MiB`);
process.exit(failure || gone || peaks.oomKills > 0 || over ? 1 : 0);

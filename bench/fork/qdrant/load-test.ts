// Steady query load against a loaded collection: dense, sparse (BM25) and hybrid
// (RRF over both), each half the time with a layer filter. Samples the Qdrant
// container's cgroup memory every second and counts block reads from io.stat.
// Prints one JSON line: latency per kind (all queries, and the first --cold-queries
// on their own), throughput, errors, peak memory and reads per query.
//
//   QDRANT_URL=http://127.0.0.1:16333 node --import tsx bench/fork/qdrant/load-test.ts \
//     --vectors /home/cownose/am-staging/qdrant-spike/buddy --collection s1_1m --duration 60
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { mulberry32, quantiles } from "../lib/stats.js";
import { Generator, type Profile } from "../lib/synthetic.js";
import { DIMS, noisyCopy, qdrant, querySparse, readVectors, wireVector } from "./lib.js";

const { values: args } = parseArgs({
  options: {
    vectors: { type: "string" },
    collection: { type: "string" },
    count: { type: "string", default: "1000000" },
    duration: { type: "string", default: "60" },
    concurrency: { type: "string", default: "4" },
    oversampling: { type: "string", default: "2" },
    "cold-queries": { type: "string", default: "100" },
    container: { type: "string", default: process.env.QDRANT_CONTAINER ?? "tee1161-qdrant" },
    profile: { type: "string", default: "bench/fork/profiles/buddy-2026-11-16.json" },
    kinds: { type: "string", default: "dense,sparse,hybrid" },
    label: { type: "string", default: "" },
  },
});
if (!args.vectors || !args.collection) throw new Error("--vectors and --collection are required");
const set = readVectors(args.vectors);
const profile = JSON.parse(readFileSync(args.profile!, "utf8")) as Profile;
const words = new Generator(profile, Number(args.count), 4242);
const rand = mulberry32(4242);
const oversampling = Number(args.oversampling);
const LAYERS = ["observation", "memory", "lesson"];

function cgroup(): Record<string, number> {
  const out = execFileSync("docker", ["exec", args.container!, "sh", "-c", "cd /sys/fs/cgroup; echo current $(cat memory.current); echo peak $(cat memory.peak); grep -E '^(anon|file) ' memory.stat; grep -E '^oom_kill ' memory.events; sed -n 's/.*rios=\\([0-9]*\\).*/rios \\1/p' io.stat | head -1"], { encoding: "utf8" });
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split(" ")).map(([k, v]) => [k!, Number(v)]));
}

function denseQuery(): number[] {
  const src = Math.floor(rand() * set.size);
  return wireVector(noisyCopy(set.data.subarray(src * DIMS, (src + 1) * DIMS), 0.0151, rand));
}

function body(kind: string, filtered: boolean): unknown {
  const filter = filtered ? { must: [{ key: "layer", match: { value: LAYERS[Math.floor(rand() * LAYERS.length)] } }] } : undefined;
  const params = { quantization: { rescore: true, oversampling } };
  const dense = { query: denseQuery(), using: "dense", params, filter };
  const terms = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => words.word()).join(" ");
  const sparse = { query: querySparse(terms), using: "bm25", filter };
  if (kind === "dense") return { ...dense, limit: 10 };
  if (kind === "sparse") return { ...sparse, limit: 10 };
  return { prefetch: [{ ...dense, limit: 40 }, { ...sparse, limit: 40 }], query: { fusion: "rrf" }, filter, limit: 10 };
}

const kinds = args.kinds!.split(",");
const before = cgroup();
let peakCurrent = before.current ?? 0;
let maxAnon = before.anon ?? 0;
const sampler = setInterval(() => {
  try {
    const s = cgroup();
    peakCurrent = Math.max(peakCurrent, s.current ?? 0);
    maxAnon = Math.max(maxAnon, s.anon ?? 0);
  } catch {
    // the container may be gone after an OOM kill; the final read reports it
  }
}, 1000);

const results: Array<{ kind: string; ms: number; seq: number }> = [];
let errors = 0;
let firstError = "";
let seq = 0;
const deadline = Date.now() + Number(args.duration) * 1000;
const started = Date.now();
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    while (Date.now() < deadline) {
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      const filtered = rand() < 0.5;
      const label = `${kind}${filtered ? "+filter" : ""}`;
      const payload = body(kind, filtered);
      const n = seq++;
      const t = performance.now();
      try {
        await qdrant("POST", `/collections/${args.collection}/points/query`, payload);
        results.push({ kind: label, ms: performance.now() - t, seq: n });
      } catch (error) {
        errors++;
        firstError ||= (error as Error).message.slice(0, 200);
      }
    }
  }),
);
const elapsed = (Date.now() - started) / 1000;
clearInterval(sampler);
let after: Record<string, number> = {};
try {
  after = cgroup();
} catch (error) {
  after = { gone: 1 };
}

const summary = (ms: number[]) => {
  if (!ms.length) return null;
  const q = quantiles(ms);
  return { n: ms.length, p50: +q[50]!.toFixed(1), p95: +q[95]!.toFixed(1), p99: +q[99]!.toFixed(1) };
};
const cold = Number(args["cold-queries"]);
const byKind = Object.fromEntries(
  [...new Set(results.map((r) => r.kind))].sort().map((k) => [k, summary(results.filter((r) => r.kind === k).map((r) => r.ms))]),
);
const mib = (b: number | undefined) => (b === undefined ? null : Math.round(b / 1048576));
console.log(JSON.stringify({
  label: args.label,
  collection: args.collection,
  oversampling,
  concurrency: Number(args.concurrency),
  seconds: Math.round(elapsed),
  qps: +(results.length / elapsed).toFixed(1),
  errors,
  firstError: firstError || undefined,
  all: summary(results.map((r) => r.ms)),
  firstQueries: summary(results.filter((r) => r.seq < cold).map((r) => r.ms)),
  byKind,
  memMiB: { before: mib(before.current), peakSampled: mib(peakCurrent), cgroupPeak: mib(after.peak), after: mib(after.current), anonMax: mib(maxAnon), anonAfter: mib(after.anon), fileAfter: mib(after.file) },
  oomKills: (after.oom_kill ?? 0) - (before.oom_kill ?? 0),
  readsPerQuery: after.rios !== undefined && before.rios !== undefined ? +((after.rios - before.rios) / Math.max(1, results.length)).toFixed(1) : null,
}));

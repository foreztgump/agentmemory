// TEE-1167 AC2: image search through the am-search worker against today's
// whole-scope cosine scan. Stores a seeded synthetic set of 512-dim image
// embeddings through the real mem::vision-embed and runs a fixed set of
// queries through the real mem::vision-search, once on the memory backend and
// once on the disk backend (the worker's router and ImageEngine on a live
// Qdrant). Both runs read KV through the real scope guard (GuardedStateKV), so
// the report shows which run read mem:image-embeddings whole.
//
//   node --import tsx bench/fork/images/compare.ts [--images 2000] [--queries 40] [--qdrant http://127.0.0.1:16341]
import { parseArgs } from "node:util";
import { ScopeReadInventory, GuardedStateKV } from "../../../src/fork/scope-guard.js";
import { collectionName } from "../../../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { ImageEngine } from "../../../src/fork/worker/image-engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { incrementImageRef } from "../../../src/functions/image-refs.js";
import { registerVisionSearchFunctions } from "../../../src/functions/vision-search.js";
import "../../../src/fork/search/runtime.js";
import { createSearchRuntime } from "../../../src/state/search-ports.js";
import type { EmbeddingProvider } from "../../../src/types.js";
import { IMAGES_DIR } from "../../../src/utils/image-store.js";
import { mulberry32 } from "../lib/stats.js";
import { stateSdk, workerSdk } from "../lib/state-sdk.js";

const { values: args } = parseArgs({
  options: {
    images: { type: "string", default: "2000" },
    queries: { type: "string", default: "40" },
    qdrant: { type: "string", default: "http://127.0.0.1:16341" },
    "qdrant-key": { type: "string" },
  },
});
const DIMS = 512;
const imageCount = Number(args.images);
const queryCount = Number(args.queries);

const rand = mulberry32(1167);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const unit = (v: Float32Array) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const randomVector = () => unit(Float32Array.from({ length: DIMS }, gauss));
const refs = Array.from({ length: imageCount }, (_, i) => `${IMAGES_DIR}/tee1167_bench_${String(i).padStart(5, "0")}.png`);
const vectors = new Map(refs.map((ref) => [ref, randomVector()]));
const sessionOf = (i: number) => (i % 7 === 0 ? undefined : `ses_${i % 5}`);
const queries = Array.from({ length: queryCount }, (_, i) => {
  const near = vectors.get(refs[Math.floor(rand() * imageCount)]!)!;
  const sigma = 0.3 + rand() * 1.2;
  return { text: `q${i}`, vector: unit(Float32Array.from(near, (x) => x + (sigma * gauss()) / Math.sqrt(DIMS))), sessionId: i % 3 === 0 ? `ses_${i % 5}` : undefined };
});
const queryVectors = new Map(queries.map((q) => [q.text, q.vector]));

const provider = {
  name: "bench-clip",
  dimensions: DIMS,
  embed: async (text: string) => queryVectors.get(text)!,
  embedBatch: async (texts: string[]) => texts.map((t) => queryVectors.get(t)!),
  embedImage: async (ref: string) => vectors.get(ref)!,
} as unknown as EmbeddingProvider;

const base = `tee1167_bench_${process.pid}`;
const qdrantOf = (id: "docs" | "lessons" | "images") =>
  new Qdrant({ url: args.qdrant!, apiKey: args["qdrant-key"], collection: collectionName(base, id), dimensions: id === "images" ? DIMS : 16, oversampling: 6, timeoutMs: 60_000, ...(id === "images" ? { layout: "image" as const } : id === "lessons" ? { layout: "lessons" as const } : {}) });
const qdrants = { docs: qdrantOf("docs"), lessons: qdrantOf("lessons"), images: qdrantOf("images") };

type Result = { success: boolean; error?: string; results: Array<{ imageRef: string; score: number; sessionId?: string; observationId?: string }>; total: number };

async function run(backend: "memory" | "disk") {
  const sdk = stateSdk();
  const inventory = new ScopeReadInventory();
  const kv = new GuardedStateKV(sdk as never, { backend: "file" }, inventory);
  const runtime = createSearchRuntime(
    { kv, embeddingProvider: null, ...(backend === "disk" ? { sdk: workerSdk({ docs: new SearchEngine(qdrants.docs, DEFAULT_AVGDL), lessons: new SearchEngine(qdrants.lessons, DEFAULT_AVGDL), images: new ImageEngine(qdrants.images) }) as never } : {}) },
    backend,
  );
  registerVisionSearchFunctions(sdk as never, kv, provider);
  for (const [i, ref] of refs.entries()) {
    await incrementImageRef(kv, ref);
    const r = (await sdk.trigger({ function_id: "mem::vision-embed", payload: { imageRef: ref, sessionId: sessionOf(i), observationId: `obs_${i}` } })) as { success: boolean; error?: string };
    if (!r.success) throw new Error(`vision-embed ${ref}: ${r.error}`);
  }
  await Promise.all((runtime as unknown as { outboxes?: Array<{ drainFor(ms: number): Promise<void> }> }).outboxes?.map((o) => o.drainFor(120_000)) ?? []);
  const results: Result[] = [];
  const ms: number[] = [];
  for (const q of queries) {
    const started = performance.now();
    results.push((await sdk.trigger({ function_id: "mem::vision-search", payload: { queryText: q.text, topK: 10, sessionId: q.sessionId } })) as Result);
    ms.push(performance.now() - started);
  }
  (runtime as unknown as { stats?: { stop(): void } }).stats?.stop();
  const reads = inventory.snapshot().reads.filter((r) => r.collection === "mem:image-embeddings");
  return { results, ms, reads };
}

try {
  const memory = await run("memory");
  const disk = await run("disk");
  let identical = 0;
  let totals = 0;
  let maxScoreDelta = 0;
  for (const [i, want] of memory.results.entries()) {
    const got = disk.results[i]!;
    if (!got.success) throw new Error(`disk query ${i}: ${got.error}`);
    if (got.results.map((r) => `${r.imageRef}|${r.sessionId}|${r.observationId}`).join() === want.results.map((r) => `${r.imageRef}|${r.sessionId}|${r.observationId}`).join()) identical++;
    if (got.total === want.total) totals++;
    got.results.forEach((r, j) => (maxScoreDelta = Math.max(maxScoreDelta, Math.abs(r.score - (want.results[j]?.score ?? 0)))));
  }
  const p50 = (xs: number[]) => +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!.toFixed(1);
  const guard = (reads: typeof memory.reads) => ({ wholeReads: reads.reduce((n, r) => n + r.calls, 0), itemsRead: reads.reduce((n, r) => n + r.items, 0), ops: [...new Set(reads.map((r) => r.op))] });
  console.log(JSON.stringify({
    images: imageCount,
    queries: queryCount,
    sessionFilteredQueries: queries.filter((q) => q.sessionId).length,
    identicalTop10: `${identical}/${queryCount}`,
    totalsEqual: `${totals}/${queryCount}`,
    maxScoreDelta: +maxScoreDelta.toExponential(2),
    p50ms: { memory: p50(memory.ms), disk: p50(disk.ms) },
    scopeGuard: { "mem:image-embeddings": { memory: guard(memory.reads), disk: guard(disk.reads) } },
  }, null, 1));
} finally {
  await Promise.all(Object.values(qdrants).map((q) => q.drop()));
}

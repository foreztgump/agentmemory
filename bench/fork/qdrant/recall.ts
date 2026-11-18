// S2 quality: recall@10 of 1-bit codes with full-precision rescoring against exact
// brute force, on buddy's real vectors, overall and filtered by layer.
// Holds out --queries stored vectors as queries and loads the rest. Buddy has no
// lesson or image vectors; --lessons relabels that many observations as "lesson"
// (buddy's real lesson count is 88) so a very selective filter is measured too.
//
//   QDRANT_URL=http://127.0.0.1:16333 node --import tsx bench/fork/qdrant/recall.ts \
//     --vectors /home/cownose/am-staging/qdrant-spike/buddy [--skip-load] [--oversampling 1,1.5,2,3,4]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { mulberry32, quantiles } from "../lib/stats.js";
import { assertOutsideRepo, createCollection, DEFAULT_SHAPE, DIMS, type CollectionShape, qdrant, readVectors, uuidOf, waitGreen, wireVector, type Layer } from "./lib.js";

const { values: args } = parseArgs({
  options: {
    vectors: { type: "string" },
    collection: { type: "string", default: "s2_buddy" },
    queries: { type: "string", default: "1000" },
    lessons: { type: "string", default: "88" },
    oversampling: { type: "string", default: "1,1.5,2,3,4" },
    "hnsw-ef": { type: "string", default: "default,128,256" },
    "skip-load": { type: "boolean", default: false },
    datatype: { type: "string", default: "float16" },
    encoding: { type: "string", default: "one_bit" },
    "query-encoding": { type: "string", default: "default" },
  },
});
if (!args.vectors) throw new Error("--vectors <dir> is required");
const K = 10;
const set = readVectors(args.vectors);
const rand = mulberry32(1161);

const order = Array.from({ length: set.size }, (_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j]!, order[i]!];
}
const queryCount = Number(args.queries);
const queries = order.slice(0, queryCount);
const corpus = order.slice(queryCount);
const layers: Layer[] = [...set.layers];
let relabeled = 0;
for (const i of corpus) {
  if (relabeled >= Number(args.lessons)) break;
  if (layers[i] === "observation") {
    layers[i] = "lesson";
    relabeled++;
  }
}
const vec = (i: number) => set.data.subarray(i * DIMS, (i + 1) * DIMS);

if (!args["skip-load"]) {
  await createCollection(args.collection, {
    ...DEFAULT_SHAPE,
    datatype: args.datatype as CollectionShape["datatype"],
    encoding: args.encoding as CollectionShape["encoding"],
    queryEncoding: args["query-encoding"] as CollectionShape["queryEncoding"],
  });
  const started = Date.now();
  const BATCH = 256;
  const batches: number[][] = [];
  for (let i = 0; i < corpus.length; i += BATCH) batches.push(corpus.slice(i, i + BATCH));
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        await qdrant("PUT", `/collections/${args.collection}/points?wait=true`, {
          points: batch.map((i) => ({ id: uuidOf(i), vector: { dense: wireVector(vec(i)) }, payload: { doc_id: set.ids[i], layer: layers[i], dense: true } })),
        });
      }
    }),
  );
  const info = await waitGreen(args.collection);
  console.error(`loaded ${info.points_count} points in ${((Date.now() - started) / 1000).toFixed(0)} s, segments ${info.segments_count}`);
}

const FILTERS: Array<Layer | "all"> = ["all", "observation", "memory", "lesson"];
// Buddy holds many identical and near-identical vectors, so the exact top 10 is
// often a tie. Recall counts a returned point as a hit when its exact cosine is
// within EPSILON of the 10th exact cosine, as ann-benchmarks' k-nn recall does
// (distance threshold d_10 + 1e-3); strictRecallAt10 uses TIE instead.
// `queriesTiedAt10th` counts queries whose 11th exact score equals the 10th.
const TIE = 1e-6;
const EPSILON = 1e-3;
interface Truth {
  kth: number;
  matches: number;
  tied: boolean;
}
const truthFile = `${assertOutsideRepo(args.vectors)}/truth-v2-${set.size}-${queryCount}-${args.lessons}.json`;
const truth = new Map<string, Truth[]>(existsSync(truthFile) ? JSON.parse(readFileSync(truthFile, "utf8")) : bruteForce());
writeFileSync(truthFile, JSON.stringify([...truth]), { mode: 0o600 });

function bruteForce(): Map<string, Truth[]> {
  const out = new Map<string, Truth[]>(FILTERS.map((f) => [f, []]));
  const started = Date.now();
  const d = set.data;
  for (const q of queries) {
    const qo = q * DIMS;
    const top = new Map<string, Array<[number, number]>>(FILTERS.map((f) => [f, []]));
    for (const i of corpus) {
      const io = i * DIMS;
      let s = 0;
      for (let k = 0; k < DIMS; k++) s += d[qo + k]! * d[io + k]!;
      for (const f of ["all", layers[i]!] as const) {
        const list = top.get(f)!;
        if (list.length <= K || s > list[list.length - 1]![0]) {
          list.push([s, i]);
          list.sort((a, b) => b[0] - a[0]);
          if (list.length > K + 1) list.pop();
        }
      }
    }
    for (const f of FILTERS) {
      const list = top.get(f)!;
      const matches = Math.min(K, list.length);
      if (matches === 0) throw new Error(`no corpus vector has layer ${f}; pass --lessons above 0`);
      out.get(f)!.push({ kth: list[matches - 1]![0], matches, tied: list.length > K && list[K]![0] >= list[K - 1]![0] - TIE });
    }
  }
  console.error(`brute force ground truth for ${queries.length} queries in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return out;
}

type Params = Record<string, unknown>;
async function measure(params: Params, filter: Layer | "all") {
  const recalls: number[] = [];
  const strict: number[] = [];
  const ms: number[] = [];
  for (let n = 0; n < queries.length; n++) {
    const body = {
      query: wireVector(vec(queries[n]!)),
      using: "dense",
      limit: K,
      params,
      ...(filter === "all" ? {} : { filter: { must: [{ key: "layer", match: { value: filter } }] } }),
    };
    const t = performance.now();
    const res = await qdrant<{ points: Array<{ id: string }> }>("POST", `/collections/${args.collection}/points/query`, body);
    ms.push(performance.now() - t);
    const { kth, matches } = truth.get(filter)![n]!;
    const qo = queries[n]! * DIMS;
    const scores = res.points.map((p) => {
      const io = parseInt(p.id.slice(-12), 16) * DIMS;
      let score = 0;
      for (let k = 0; k < DIMS; k++) score += set.data[qo + k]! * set.data[io + k]!;
      return score;
    });
    recalls.push(Math.min(scores.filter((x) => x >= kth - EPSILON).length, matches) / matches);
    strict.push(Math.min(scores.filter((x) => x >= kth - TIE).length, matches) / matches);
  }
  const q = quantiles(ms);
  const mean = (xs: number[]) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4);
  return { recallAt10: mean(recalls), strictRecallAt10: mean(strict), minRecall: Math.min(...recalls), p50: +q[50]!.toFixed(2), p95: +q[95]!.toFixed(2), p99: +q[99]!.toFixed(2) };
}

const efs = (args["hnsw-ef"] ?? "default").split(",");
const settings: Array<[string, Params]> = [
  ["exact float (sanity)", { exact: true, quantization: { ignore: true } }],
  ...efs.flatMap((ef) => {
    const hnsw = ef === "default" ? {} : { hnsw_ef: Number(ef) };
    return [
      [`ef ${ef}, codes, no rescore`, { ...hnsw, quantization: { rescore: false } }],
      ...args.oversampling!.split(",").map((o) => [`ef ${ef}, codes, rescore x${o}`, { ...hnsw, quantization: { rescore: true, oversampling: Number(o) } }]),
    ] as Array<[string, Params]>;
  }),
];
const counts = Object.fromEntries(FILTERS.map((f) => [f, f === "all" ? corpus.length : corpus.filter((i) => layers[i] === f).length]));
const tied = Object.fromEntries(FILTERS.map((f) => [f, truth.get(f)!.filter((t) => t.tied).length]));
console.log(JSON.stringify({ collection: args.collection, corpus: corpus.length, queries: queries.length, counts, queriesTiedAt10th: tied }));
for (const [label, params] of settings) {
  for (const filter of FILTERS) console.log(JSON.stringify({ setting: label, filter, ...(await measure(params, filter)) }));
}


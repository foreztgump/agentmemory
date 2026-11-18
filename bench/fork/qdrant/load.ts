// S1/S2 corpus: loads --count synthetic documents in the planned point shape.
// Dense: buddy's real vectors first, then copies of random real vectors with
// Gaussian noise (--sigma per dimension, renormalized). Sparse: BM25 weights over
// the app's own term extraction of observations from TEE-1155's profile-driven
// generator. Payload: the source's layer (buddy's mix), plus "lesson" on buddy's
// lesson share, a session id and a timestamp.
//
//   QDRANT_URL=http://127.0.0.1:16333 node --import tsx bench/fork/qdrant/load.ts \
//     --vectors /home/cownose/am-staging/qdrant-spike/buddy --count 1000000 --collection s1_1m
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { extractTerms } from "../../../src/state/term-extraction.js";
import type { CompressedObservation } from "../../../src/types.js";
import { mulberry32 } from "../lib/stats.js";
import { Generator, type Profile } from "../lib/synthetic.js";
import { createCollection, DEFAULT_SHAPE, DIMS, docSparse, dot, noisyCopy, qdrant, readVectors, uuidOf, waitGreen, wireVector } from "./lib.js";

const { values: args } = parseArgs({
  options: {
    vectors: { type: "string" },
    collection: { type: "string" },
    count: { type: "string" },
    sigma: { type: "string", default: "0.0151" },
    segments: { type: "string", default: String(DEFAULT_SHAPE.segments) },
    profile: { type: "string", default: "bench/fork/profiles/buddy-2026-11-16.json" },
    "lesson-share": { type: "string", default: String(88 / 249_289) },
  },
});
const count = Number(args.count);
if (!args.vectors || !args.collection || !Number.isInteger(count) || count <= 0) throw new Error("--vectors, --collection and --count are required");
const set = readVectors(args.vectors);
const profile = JSON.parse(readFileSync(args.profile!, "utf8")) as Profile;
const sigma = Number(args.sigma);
const lessonShare = Number(args["lesson-share"]);
const rand = mulberry32(1161);

const asObs = (o: ReturnType<Generator["observation"]>) => o as unknown as CompressedObservation;
const sample = new Generator(profile, count, 7);
let totalTerms = 0;
const sampleSession = sample.session(0);
for (let i = 0; i < 5000; i++) totalTerms += extractTerms(asObs(sample.observation(sampleSession, i))).length;
const avgdl = totalTerms / 5000;

await createCollection(args.collection, { ...DEFAULT_SHAPE, segments: Number(args.segments) });
const gen = new Generator(profile, count, 1161);
let session = gen.session(0);
let left = gen.sessionSize();
let sessions = 1;
const nnz: number[] = [];
let cosSum = 0;
let cosN = 0;

function point(i: number) {
  const real = i < set.size;
  const src = real ? i : Math.floor(rand() * set.size);
  const source = set.data.subarray(src * DIMS, (src + 1) * DIMS);
  const v = real ? source : noisyCopy(source, sigma, rand);
  if (!real && i % 1000 === 0) {
    cosSum += dot(source, v);
    cosN++;
  }
  if (left-- <= 0) {
    session = gen.session(sessions++);
    left = gen.sessionSize() - 1;
  }
  const obs = gen.observation(session, left * 60_000);
  const sparse = docSparse(extractTerms(asObs(obs)), avgdl);
  if (i % 1000 === 0) nnz.push(sparse.indices.length);
  const layer = rand() < lessonShare ? "lesson" : set.layers[src];
  return {
    id: uuidOf(i),
    vector: { dense: wireVector(v), ...(sparse.indices.length ? { bm25: sparse } : {}) },
    payload: { doc_id: obs.id, session_id: session.id, layer, ts: Date.parse(obs.timestamp), dense: true },
  };
}

const started = Date.now();
const BATCH = 256;
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < count) {
      const from = next;
      const to = Math.min(count, from + BATCH);
      next = to;
      const points = Array.from({ length: to - from }, (_, k) => point(from + k));
      await qdrant("PUT", `/collections/${args.collection}/points?wait=true`, { points });
      if (Math.floor(to / 100_000) > Math.floor(from / 100_000)) console.error(`${to} points, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  }),
);
const uploadedS = (Date.now() - started) / 1000;
const info = await waitGreen(args.collection);
nnz.sort((a, b) => a - b);
console.log(JSON.stringify({
  collection: args.collection,
  points: info.points_count,
  segments: info.segments_count,
  uploadSeconds: Math.round(uploadedS),
  readySeconds: Math.round((Date.now() - started) / 1000),
  avgdl: +avgdl.toFixed(1),
  sparseNnz: { p50: nnz[nnz.length >> 1], p95: nnz[Math.floor(nnz.length * 0.95)], max: nnz.at(-1) },
  copyCosineToSource: cosN ? +(cosSum / cosN).toFixed(3) : null,
  sessions,
}));

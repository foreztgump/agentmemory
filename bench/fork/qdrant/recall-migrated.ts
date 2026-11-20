// Vector recall@10 of the migrated disk index against brute force, with no
// embedding calls: the queries are stored vectors, and the truth is exact
// cosine over every decoded stored vector the index holds. A Qdrant hit counts
// when its exact cosine is within 1e-3 of the 10th exact score (ties), and the
// query's own document is left out of both lists. A hit outside that corpus
// (a point written after the migration) is reported and left out of the score.
//
//   MIGRATE_STORE_URL=redis://... AM_QDRANT_URL=http://qdrant:6333 AM_QDRANT_API_KEY=... \
//     node --import tsx bench/fork/qdrant/recall-migrated.ts [--queries 200] [--oversampling 6]
import { parseArgs } from "node:util";
import { bucketKey, hashPages, planVectors, readVectors } from "../../../scripts/fork/search-migrate.js";
import { connectRedis } from "../../../scripts/fork/lib/resp.js";
import { parseBucketRow, parsePendingRow, PENDING_SCOPE, STATE_PREFIX, STORED_VECTOR_MODEL } from "../../../src/fork/search/persisted-vectors.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { mulberry32 } from "../lib/stats.js";

const { values: args } = parseArgs({ options: { queries: { type: "string", default: "200" }, oversampling: { type: "string", default: "6" } } });
const K = 10;
const EPSILON = 1e-3;
const DIMS = STORED_VECTOR_MODEL.dimensions;
const storeUrl = process.env.MIGRATE_STORE_URL;
const qdrantUrl = process.env.AM_QDRANT_URL;
if (!storeUrl || !qdrantUrl) throw new Error("MIGRATE_STORE_URL and AM_QDRANT_URL are required");
const oversampling = Number(args.oversampling);
const queryCount = Number(args.queries);
if (!Number.isInteger(oversampling) || oversampling < 1) throw new Error(`--oversampling ${args.oversampling} must be a positive integer`);
if (!Number.isInteger(queryCount) || queryCount < 1) throw new Error(`--queries ${args.queries} must be a positive integer`);
const SEED = 1168;
const SCAN_PAGE = 500;
const qdrant = new Qdrant({
  url: qdrantUrl, apiKey: process.env.AM_QDRANT_API_KEY, collection: process.env.AM_QDRANT_COLLECTION || "agentmemory",
  dimensions: DIMS, oversampling, timeoutMs: 120_000,
});
if (!(await qdrant.exists())) throw new Error(`collection ${qdrant.config.collection} is missing on ${qdrantUrl}; run the migration fill first`);
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
const store = await connectRedis(storeUrl);

function unit(id: string, bytes: Buffer): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = bytes.readFloatLE(i * 4);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (!(n > 0)) throw new Error(`the stored vector of ${id} has zero length`);
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

const started = Date.now();
try {
  const plan = await planVectors(store, DIMS, SCAN_PAGE);
  // The brute-force corpus is what the index holds: live points with a dense vector.
  const indexed = new Set<string>();
  let offset: string | undefined;
  do {
    const page = await qdrant.call<{ points: Array<{ payload?: { doc_id?: string } }>; next_page_offset?: string | null }>("POST", `${qdrant.path}/points/scroll`, {
      filter: { must: [{ key: "dense", match: { value: true } }], must_not: [{ key: "deleted", match: { value: true } }] },
      limit: 2000, ...(offset ? { offset } : {}), with_payload: ["doc_id"], with_vector: false,
    });
    for (const p of page.points) if (p.payload?.doc_id) indexed.add(p.payload.doc_id);
    offset = page.next_page_offset ?? undefined;
  } while (offset);

  const ids = [...indexed].filter((id) => plan.winners.has(id)).sort();
  const rand = mulberry32(SEED);
  const queryIds = new Set<string>();
  while (queryIds.size < Math.min(queryCount, ids.length)) queryIds.add(ids[Math.floor(rand() * ids.length)]!);
  const queryBytes = await readVectors(store, plan, [...queryIds], DIMS);
  const queries: Array<{ id: string; v: Float32Array; hits: string[]; hitScores: Map<string, number>; top: Array<{ id: string; score: number }> }> = [];
  for (const id of queryIds) {
    const bytes = queryBytes.get(id)!;
    const hits = (await engine.vector(bytes.toString("base64"), K + 1, "all", oversampling)).filter((h) => h.id !== id).slice(0, K).map((h) => h.id);
    queries.push({ id, v: unit(id, bytes), hits, hitScores: new Map<string, number>(), top: [] as Array<{ id: string; score: number }> });
  }

  const KEEP = 2 * K + 1;
  function consider(id: string, bytes: Buffer): void {
    const v = unit(id, bytes);
    for (const q of queries) {
      if (q.id === id) continue;
      let dot = 0;
      for (let i = 0; i < DIMS; i++) dot += q.v[i]! * v[i]!;
      if (q.hits.includes(id)) q.hitScores.set(id, dot);
      if (q.top.length < KEEP || dot > q.top[q.top.length - 1]!.score) {
        q.top.push({ id, score: dot });
        q.top.sort((a, b) => b.score - a.score);
        if (q.top.length > KEEP) q.top.pop();
      }
    }
  }
  let corpus = 0;
  const buckets = new Map<string, number>();
  for (const [id, w] of plan.winners) if (indexed.has(id)) buckets.set(String(w.source), (buckets.get(String(w.source)) ?? 0) + 1);
  for (const source of buckets.keys()) {
    const key = source === "pending" ? STATE_PREFIX + PENDING_SCOPE : bucketKey(Number(source));
    for await (const pairs of hashPages(store, key, SCAN_PAGE)) {
      for (const [field, value] of pairs) {
        if (!indexed.has(field) || String(plan.winners.get(field)?.source) !== source) continue;
        const row = source === "pending" ? parsePendingRow(field, value, DIMS) : parseBucketRow(field, value, DIMS);
        if (!("bytes" in row) || !row.bytes) continue;
        consider(field, row.bytes);
        corpus++;
      }
    }
  }

  if (queries.length === 0 || corpus <= K) throw new Error(`need more than ${K} indexed stored vectors, found ${corpus}`);
  let found = 0;
  let outside = 0;
  let exactTop1 = 0;
  for (const q of queries) {
    const tenth = q.top[K - 1]!.score;
    for (const id of q.hits) {
      const score = q.hitScores.get(id);
      if (score === undefined) outside++;
      else if (score >= tenth - EPSILON) found++;
    }
    if (q.hits[0] === q.top[0]!.id) exactTop1++;
  }
  const scored = queries.length * K - outside;
  if (scored <= 0) throw new Error(`no hit to score: all ${outside} fell outside the stored-vector corpus`);
  console.log(JSON.stringify({
    queries: queries.length, corpus, indexedDense: indexed.size, k: K, oversampling, hitsOutsideCorpus: outside,
    recallAt10: Number((found / scored).toFixed(4)), top1Agreement: Number((exactTop1 / queries.length).toFixed(4)),
    seconds: Math.round((Date.now() - started) / 1000),
  }));
} finally {
  store.close();
}

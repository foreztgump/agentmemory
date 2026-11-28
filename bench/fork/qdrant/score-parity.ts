// Keyword score parity between SearchIndex (memory mode) and the disk engine on
// one synthetic corpus: top-k ids, order and scores per query, and Qdrant's
// effective idf per query term against the exact one. Ids and numbers only.
//
//   node --max-old-space-size=6000 --import tsx bench/fork/qdrant/score-parity.ts --docs 200000 \
//     [--qdrant http://127.0.0.1:16344] [--collection parity_200k] [--reuse] [--queries 300] [--k 10] [--prefix-share 0.5]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { contentRev, type DocOp } from "../../../src/fork/search/protocol.js";
import { termId } from "../../../src/fork/worker/bm25-sparse.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { SearchIndex } from "../../../src/state/search-index.js";
import { queryTerms, termSourceOf } from "../../../src/state/term-extraction.js";
import type { CompressedObservation } from "../../../src/types.js";
import { Generator, type Profile } from "../lib/synthetic.js";
import { mulberry32 } from "../lib/stats.js";

const { values: args } = parseArgs({
  options: {
    docs: { type: "string", default: "20000" },
    queries: { type: "string", default: "300" },
    qdrant: { type: "string", default: "http://127.0.0.1:16344" },
    collection: { type: "string" },
    profile: { type: "string", default: "bench/fork/profiles/buddy-2026-11-16.json" },
    reuse: { type: "boolean", default: false },
    k: { type: "string", default: "10" },
    // Share of queries whose every word is cut to 60% of its length (at least 3 characters), so they match only through prefixes.
    "prefix-share": { type: "string", default: "0" },
  },
});
const DOCS = Number(args.docs);
const K = Number(args.k);
const PREFIX_SHARE = Number(args["prefix-share"]);
if (!(PREFIX_SHARE >= 0 && PREFIX_SHARE <= 1)) throw new Error("--prefix-share must be a number from 0 to 1");
const cutRand = mulberry32(13);
const cut = (w: string) => w.slice(0, Math.max(3, Math.ceil(w.length * 0.6)));
const profile = JSON.parse(readFileSync(args.profile!, "utf8")) as Profile;
const qdrant = new Qdrant({ url: args.qdrant!, collection: args.collection ?? `parity_${DOCS}`, dimensions: 16, oversampling: 6, timeoutMs: 120_000 });
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
async function apply(batch: Parameters<typeof engine.apply>[0]): Promise<void> {
  const r = await engine.apply(batch);
  if (r.failed.length > 0 || r.applied !== batch.length) throw new Error(`apply: ${JSON.stringify(r).slice(0, 300)}`);
}
const memory = new SearchIndex();
const seen = new Set<string>();
const queries: string[] = [];
const rand = mulberry32(7);

if (!args.reuse) await qdrant.drop();
const gen = new Generator(profile, DOCS, 1195);
let batch: DocOp[] = [];
const started = performance.now();
for (let s = 0; memory.size < DOCS; s++) {
  const session = gen.session(s);
  for (let i = 0; i < gen.sessionSize() && memory.size < DOCS; i++) {
    const o = gen.observation(session, i * 30_000) as unknown as CompressedObservation;
    if (!o.title || !o.narrative || seen.has(o.id)) continue;
    memory.add(o);
    seen.add(o.id);
    if (queries.length < Number(args.queries) && rand() < 0.02) {
      const words = `${o.title} ${o.narrative}`.split(/\s+/).filter((w) => w.length > 3);
      const n = 1 + Math.floor(rand() * 3);
      const picked = Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]!);
      queries.push((cutRand() < PREFIX_SHARE ? picked.map(cut) : picked).join(" "));
    }
    if (args.reuse) continue;
    const fields = termSourceOf(o);
    batch.push({ k: "doc", id: o.id, sessionId: o.sessionId, layer: "observation", ts: Date.parse(o.timestamp), rev: contentRev(fields), fields });
    if (batch.length >= 512) {
      await apply(batch);
      batch = [];
    }
  }
}
if (batch.length > 0) await apply(batch);
// A first search starts the vocabulary fill; every compared search runs after it.
await engine.keyword(queries[0] ?? "warmup", K, "all");
await engine.settled();
if (!engine.prefixes?.isReady) throw new Error("the prefix vocabulary did not fill; the engine would rank in Qdrant's raw order");
console.error(`loaded ${memory.size} docs in ${((performance.now() - started) / 1000).toFixed(0)} s; ${queries.length} queries`);

const internals = memory as unknown as { invertedIndex: Map<string, Set<string>>; totalDocLength: number };
const N = memory.size;
const avgdl = internals.totalDocLength / N;
const exactIdf = (term: string) => {
  const df = internals.invertedIndex.get(term)?.size ?? 0;
  return Math.log((N - df + 0.5) / (df + 0.5) + 1);
};

interface StoredPoint { id: string; payload: { doc_id: string; ad: number; dl: number }; vector: { bm25: { indices: number[]; values: number[] } } }
async function stored(docIds: string[]): Promise<Map<string, StoredPoint>> {
  const res = await qdrant.call<{ points: StoredPoint[] }>("POST", `${qdrant.path}/points/scroll`, {
    filter: { must: [{ key: "doc_id", match: { any: docIds } }] }, limit: docIds.length, with_payload: ["doc_id", "ad", "dl"], with_vector: ["bm25"],
  });
  return new Map(res.points.map((p) => [p.payload.doc_id, p]));
}

const info = await qdrant.call<{ points_count: number; segments_count: number; status: string }>("GET", qdrant.path);
const idfRatios: number[] = [];
const adSeen = new Set<number>();
let sameList = 0, sameTop1 = 0, overlap = 0, sameSet = 0;
const divergent: unknown[] = [];
for (const q of queries) {
  const want = memory.search(q, K);
  const got = await engine.keyword(q, K, "all");
  const wantIds = want.map((h) => h.obsId);
  const gotIds = got.map((h) => h.id);
  if (wantIds.join() === gotIds.join()) sameList++;
  if (wantIds[0] === gotIds[0]) sameTop1++;
  if ([...wantIds].sort().join() === [...gotIds].sort().join()) sameSet++;
  overlap += wantIds.length ? gotIds.filter((id) => wantIds.includes(id)).length / wantIds.length : 1;

  // Effective idf: score of a one-term query divided by the stored weight of that term.
  const points = await stored([...new Set([...wantIds, ...gotIds])]);
  for (const p of points.values()) adSeen.add(Math.round(p.payload.ad * 1000) / 1000);
  for (const { term } of queryTerms(q)) {
    const id = termId(term);
    const res = await qdrant.call<{ points: Array<{ payload: { doc_id: string }; score: number }> }>("POST", `${qdrant.path}/points/query`, {
      query: { indices: [id], values: [1] }, using: "bm25", limit: 1, with_payload: ["doc_id"],
    });
    const top = res.points[0];
    if (!top) continue;
    const p = points.get(top.payload.doc_id) ?? (await stored([top.payload.doc_id])).get(top.payload.doc_id);
    const w = p?.vector.bm25.values[p.vector.bm25.indices.indexOf(id)];
    if (w && exactIdf(term) > 0) idfRatios.push(top.score / w / exactIdf(term));
  }
  if (wantIds.join() !== gotIds.join() && divergent.length < 15) {
    const memAll = new Map(memory.search(q, 100_000).map((h) => [h.obsId, h.score]));
    divergent.push({
      terms: queryTerms(q).length,
      memory: want.map((h) => [h.obsId.slice(-8), +h.score.toFixed(4)]),
      disk: got.map((h) => [h.id.slice(-8), +h.score.toFixed(4), +(memAll.get(h.id) ?? 0).toFixed(4)]),
    });
  }
}
idfRatios.sort((a, b) => a - b);
const q = (p: number) => +(idfRatios[Math.floor(p * (idfRatios.length - 1))] ?? NaN).toFixed(5);
console.log(JSON.stringify({
  docs: N, avgdl: +avgdl.toFixed(3), qdrant: info, adValues: [...adSeen].slice(0, 10), queries: queries.length,
  sameList: sameList / queries.length, sameSet: sameSet / queries.length, sameTop1: sameTop1 / queries.length, overlap: overlap / queries.length,
  qdrantIdfOverExact: { n: idfRatios.length, min: q(0), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: q(1) },
  divergent,
}, null, 1));


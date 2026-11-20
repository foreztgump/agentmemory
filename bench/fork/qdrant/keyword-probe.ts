// The keyword leg alone, per eval case: SearchIndex's exact BM25 computed from
// the terms stored in the docs collection, against the disk engine's ranking.
// Prints hashed ids, ranks and scores, never text. Runs on the replica network
// after the migration (replica.sh client), or on any Qdrant with a docs collection.
//
//   node --import tsx bench/fork/qdrant/keyword-probe.ts --cases <cases.json> [--qdrant http://qdrant:6333] [--repeat 2]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { querySparse } from "../../../src/fork/worker/bm25-sparse.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { expandLexicalTerms, lexicalBm25, type LexicalDocument } from "../../../src/fork/worker/lexical-bm25.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { queryTerms } from "../../../src/state/term-extraction.js";

const { values: args } = parseArgs({
  options: {
    cases: { type: "string" },
    qdrant: { type: "string", default: process.env.AM_QDRANT_URL ?? "http://qdrant:6333" },
    key: { type: "string", default: process.env.AM_QDRANT_API_KEY ?? "replica-dummy-qdrant-key" },
    collection: { type: "string", default: "agentmemory" },
    depth: { type: "string", default: "50" },
    repeat: { type: "string", default: "2" },
  },
});
if (!args.cases) throw new Error("--cases is required");
const cases = (JSON.parse(readFileSync(args.cases, "utf8")) as { cases: Array<{ id: string; kind: string; query: string; expected: string[] }> }).cases;
const DEPTH = Number(args.depth);
const qdrant = new Qdrant({ url: args.qdrant!, apiKey: args.key, collection: args.collection!, dimensions: 1024, oversampling: 6, timeoutMs: 120_000 });
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
const hash = (id: string) => createHash("sha1").update(id).digest("hex").slice(0, 8);

interface Point { payload?: { doc_id?: string; session_id?: string; terms?: unknown; dl?: number; deleted?: boolean } }
async function* scroll(): AsyncGenerator<Point[]> {
  let offset: string | undefined;
  do {
    const page = await qdrant.call<{ points: Point[]; next_page_offset?: string | null }>("POST", `${qdrant.path}/points/scroll`, {
      filter: { must_not: [{ key: "deleted", match: { value: true } }] }, limit: 1000, ...(offset ? { offset } : {}),
      with_payload: ["doc_id", "session_id", "terms", "dl"], with_vector: false,
    });
    yield page.points;
    offset = page.next_page_offset ?? undefined;
  } while (offset);
}

const started = performance.now();
const df = new Map<string, number>();
let N = 0;
let totalLength = 0;
for await (const points of scroll()) {
  for (const { payload } of points) {
    if (!payload?.doc_id || !Array.isArray(payload.terms)) continue;
    N++;
    totalLength += payload.terms.length;
    for (const t of new Set(payload.terms as string[])) df.set(t, (df.get(t) ?? 0) + 1);
  }
}
const avgdl = totalLength / N;
const expanded = new Map(cases.map((c) => [c.id, expandLexicalTerms(queryTerms(c.query), df)]));
const relevant = new Set([...expanded.values()].flatMap((q) => q.flatMap(({ term, prefixes }) => [term, ...prefixes])));
const documents: LexicalDocument[] = [];
let storedLengthMismatch = 0;
for await (const points of scroll()) {
  for (const { payload } of points) {
    if (!payload?.doc_id || !Array.isArray(payload.terms)) continue;
    if (payload.dl !== payload.terms.length) storedLengthMismatch++;
    const terms = (payload.terms as string[]).filter((t) => relevant.has(t));
    if (terms.length > 0) documents.push({ id: payload.doc_id, sessionId: payload.session_id ?? "", terms, dl: payload.terms.length });
  }
}
const loadSeconds = (performance.now() - started) / 1000;
engine.prefixes?.fillInBackground();
await engine.settled();
if (!engine.prefixes?.isReady) throw new Error("the prefix vocabulary did not fill; the engine would rank in Qdrant's raw order");

const exactOf = new Map<string, ReturnType<typeof lexicalBm25>>();
for (const c of cases) exactOf.set(c.id, lexicalBm25(documents, expanded.get(c.id)!, df, N, avgdl, 100_000));

// Qdrant's own order for the engine's sparse query, before any re-scoring in the worker.
async function rawQdrant(query: string, depth = DEPTH): Promise<string[]> {
  const prefixes = engine.prefixes;
  const sparse = querySparse(query, prefixes ? (terms) => prefixes.expand(terms) : undefined);
  if (sparse.indices.length === 0) return [];
  const res = await qdrant.call<{ points: Array<{ payload?: { doc_id?: string } }> }>("POST", `${qdrant.path}/points/query`, {
    query: sparse, using: "bm25", limit: depth, filter: { must_not: [{ key: "deleted", match: { value: true } }] }, with_payload: ["doc_id"],
  });
  return res.points.flatMap((p) => (p.payload?.doc_id ? [p.payload.doc_id] : []));
}

const firstRank = (ids: string[], expected: string[]) => {
  const i = ids.slice(0, 10).findIndex((id) => expected.includes(id));
  return i < 0 ? null : i + 1;
};
const runs: Array<Record<string, number | null>> = [];
const perCase: unknown[] = [];
let rawMrr = 0, rawRecall = 0;
// How deep in Qdrant's own order the exact top k sit: the candidate depth a re-score needs.
const RAW_DEPTH = 1000;
const NEEDED_TOP = [10, 40];
const needed = Object.fromEntries(NEEDED_TOP.map((k) => [k, [] as number[]]));
let exactMrr = 0, exactRecall = 0, diskMrr = 0, diskRecall = 0, sameTop10 = 0, sameTop10Set = 0, tiedTop10 = 0;
for (let r = 0; r < Number(args.repeat); r++) {
  const ranks: Record<string, number | null> = {};
  for (const c of cases) {
    const disk = await engine.keyword(c.query, DEPTH, "all");
    ranks[c.id] = firstRank(disk.map((h) => h.id), c.expected);
    if (r > 0) continue;
    const raw = await rawQdrant(c.query, RAW_DEPTH);
    const rawPos = new Map(raw.map((id, i) => [id, i + 1]));
    for (const k of NEEDED_TOP) needed[k]!.push(Math.max(0, ...exactOf.get(c.id)!.slice(0, k).map((h) => rawPos.get(h.id) ?? RAW_DEPTH + 1)));
    const rr = firstRank(raw.slice(0, DEPTH), c.expected);
    rawMrr += rr ? 1 / rr : 0; rawRecall += rr ? 1 : 0;
    const exactAll = exactOf.get(c.id)!;
    const exactScore = new Map(exactAll.map((h) => [h.id, h.score]));
    const exact = exactAll.slice(0, DEPTH);
    const er = firstRank(exact.map((h) => h.id), c.expected);
    const dr = ranks[c.id]!;
    exactMrr += er ? 1 / er : 0; exactRecall += er ? 1 : 0;
    diskMrr += dr ? 1 / dr : 0; diskRecall += dr ? 1 : 0;
    const e10 = exact.slice(0, 10).map((h) => h.id), d10 = disk.slice(0, 10).map((h) => h.id);
    if (e10.join() === d10.join()) sameTop10++;
    if ([...e10].sort().join() === [...d10].sort().join()) sameTop10Set++;
    const tied = exact.slice(0, 11).some((h, i, a) => i > 0 && Math.abs(h.score - a[i - 1]!.score) < 1e-9);
    if (tied) tiedTop10++;
    // Where the exact top 10 sit in the disk candidates: how deep a re-score would need to read.
    const diskPos = new Map(disk.map((h, i) => [h.id, i + 1]));
    const deepest = Math.max(...e10.map((id) => diskPos.get(id) ?? Infinity));
    if (er !== dr) {
      const expectedExact = exactAll.findIndex((h) => c.expected.includes(h.id));
      perCase.push({
        id: c.id, exactRank: er, diskRank: dr, tiedTop10: tied, exactTop10DeepestInDisk: Number.isFinite(deepest) ? deepest : null,
        expectedExactPos: expectedExact < 0 ? null : expectedExact + 1,
        expectedScore: expectedExact < 0 ? null : +exactAll[expectedExact]!.score.toFixed(4),
        exact: exact.slice(0, 10).map((h) => [hash(h.id), +h.score.toFixed(4), c.expected.includes(h.id) ? 1 : 0]),
        disk: disk.slice(0, 10).map((h) => [hash(h.id), +h.score.toFixed(4), +(exactScore.get(h.id) ?? 0).toFixed(4), c.expected.includes(h.id) ? 1 : 0]),
      });
    }
  }
  runs.push(ranks);
}
const n = cases.length;
const unstable = cases.filter((c) => runs.some((r) => r[c.id] !== runs[0]![c.id])).map((c) => c.id);
const info = await qdrant.call<{ points_count: number; segments_count: number; status: string; optimizer_status: unknown }>("GET", qdrant.path);
console.log(JSON.stringify({
  docs: N, avgdl: +avgdl.toFixed(3), terms: df.size, candidates: documents.length, storedLengthMismatch, loadSeconds: +loadSeconds.toFixed(1),
  qdrant: { points: info.points_count, segments: info.segments_count, status: info.status, optimizer: info.optimizer_status },
  keywordLeg: {
    exact: { recallAt10: +(exactRecall / n).toFixed(4), mrr: +(exactMrr / n).toFixed(4) },
    disk: { recallAt10: +(diskRecall / n).toFixed(4), mrr: +(diskMrr / n).toFixed(4) },
    rawQdrant: { recallAt10: +(rawRecall / n).toFixed(4), mrr: +(rawMrr / n).toFixed(4) },
    sameTop10: sameTop10 / n, sameTop10Set: sameTop10Set / n, casesWithTiesInExactTop10: tiedTop10,
  },
  candidateDepthNeeded: Object.fromEntries(Object.entries(needed).map(([k, v]) => {
    const sorted = [...v].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return [`top${k}`, { p50: at(0.5), p90: at(0.9), p95: at(0.95), max: sorted[sorted.length - 1] }];
  })),
  unstableAcrossRepeats: unstable,
  diskRanks: runs[0],
  differing: perCase,
}, null, 1));

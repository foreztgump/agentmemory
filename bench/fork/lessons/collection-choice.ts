// Decides whether lessons need their own Qdrant collection (TEE-1167). Reads a
// replica's lessons, observations and memories, builds a fixed set of lesson
// queries (written to --cases, outside the repo: they hold private words), and
// ranks each query three ways with lesson recall's own reranking:
//   memory: SearchIndex over lessons only (today's lesson index);
//   own:    a Qdrant collection holding only lessons;
//   shared: one Qdrant collection holding observations, memories and lessons, filtered to layer lesson.
// Prints top-10 agreement with memory for both Qdrant layouts; prints no content.
//
//   node --import tsx bench/fork/lessons/collection-choice.ts --container <valkey> \
//     --cases /home/cownose/am-staging/eval-private/lessons-buddy.json [--qdrant http://127.0.0.1:16341]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { contentRev, type DocOp } from "../../../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { querySparse } from "../../../src/fork/worker/bm25-sparse.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { lessonToObservation, memoryToObservation } from "../../../src/state/memory-utils.js";
import { SearchIndex } from "../../../src/state/search-index.js";
import { termSourceOf } from "../../../src/state/term-extraction.js";
import type { CompressedObservation, Lesson, Memory } from "../../../src/types.js";
import { mulberry32 } from "../lib/stats.js";
import { ALL_OBSERVATIONS, jsonValues } from "../lib/valkey.js";
import { buildLessonCases, rankLessons, type LessonCase } from "./lib.js";

const { values: args } = parseArgs({
  options: {
    container: { type: "string" },
    cases: { type: "string" },
    qdrant: { type: "string", default: "http://127.0.0.1:16341" },
    "qdrant-key": { type: "string" },
    seed: { type: "string", default: "1167" },
    count: { type: "string", default: "60" },
  },
});
if (!args.container || !args.cases) throw new Error("--container and --cases are required");
if (resolve(args.cases).startsWith(resolve(import.meta.dirname, "../../..") + sep)) throw new Error("--cases must be outside the repository");

const lessons: Lesson[] = [];
for await (const l of jsonValues(args.container, "valkey-cli --raw hvals state:mem:lessons")) {
  if (!(l as unknown as Lesson).deleted) lessons.push(l as unknown as Lesson);
}
if (lessons.length === 0) throw new Error(`no lessons in ${args.container}`);

const cases: LessonCase[] = existsSync(args.cases)
  ? (JSON.parse(readFileSync(args.cases, "utf8")) as { cases: LessonCase[] }).cases
  : buildLessonCases(lessons, Number(args.count), mulberry32(Number(args.seed)));
if (!existsSync(args.cases)) writeFileSync(args.cases, JSON.stringify({ seed: Number(args.seed), source: "lessons", cases }, null, 1), { mode: 0o600 });

const byId = new Map(lessons.map((l) => [l.id, l]));
const now = Date.now();

const memory = new SearchIndex();
for (const l of lessons) memory.add(lessonToObservation(l), "lesson");

function docOp(obs: CompressedObservation, layer: DocOp["layer"]): DocOp {
  const fields = termSourceOf(obs);
  return { k: "doc", id: obs.id, sessionId: obs.sessionId, layer, ts: Date.parse(obs.timestamp ?? "") || 0, rev: contentRev(fields), fields };
}

async function load(collection: string, docs: AsyncIterable<DocOp> | Iterable<DocOp>): Promise<SearchEngine> {
  const qdrant = new Qdrant({ url: args.qdrant!, apiKey: args["qdrant-key"], collection, dimensions: 16, oversampling: 6, timeoutMs: 60_000 });
  await qdrant.drop();
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  let batch: DocOp[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const r = await engine.apply(batch);
    if (r.failed.length > 0) throw new Error(`apply failed for ${r.failed.length} ops`);
    batch = [];
  };
  for await (const op of docs) {
    batch.push(op);
    if (batch.length >= 512) await flush();
  }
  await flush();
  await engine.settled();
  return engine;
}

async function* sharedDocs(): AsyncIterable<DocOp> {
  for await (const o of jsonValues(args.container!, ALL_OBSERVATIONS)) {
    if (typeof o.narrative !== "string" || !o.narrative) continue;
    yield docOp(o as unknown as CompressedObservation, "observation");
  }
  for await (const m of jsonValues(args.container!, "valkey-cli --raw hvals state:mem:memories")) {
    if ((m as unknown as Memory).isLatest === false) continue;
    yield docOp(memoryToObservation(m as unknown as Memory), "memory");
  }
  for (const l of lessons) yield docOp(lessonToObservation(l), "lesson");
}

const own = await load("tee1167_lessons_own", lessons.map((l) => docOp(lessonToObservation(l), "lesson")));
const sharedStarted = performance.now();
const shared = await load("tee1167_lessons_shared", sharedDocs());
const sharedSeconds = Math.round((performance.now() - sharedStarted) / 1000);
const sharedQdrant = new Qdrant({ url: args.qdrant!, apiKey: args["qdrant-key"], collection: "tee1167_lessons_shared", dimensions: 16, oversampling: 6, timeoutMs: 60_000 });

async function sharedLessonHits(query: string, limit: number) {
  const sparse = querySparse(query);
  if (sparse.indices.length === 0) return [];
  const res = await sharedQdrant.call<{ points: Array<{ score: number; payload?: { doc_id?: string } }> }>("POST", `${sharedQdrant.path}/points/query`, {
    query: sparse, using: "bm25", limit,
    filter: { must: [{ key: "layer", match: { value: "lesson" } }], must_not: [{ key: "deleted", match: { value: true } }] },
    with_payload: ["doc_id"],
  });
  return res.points.flatMap((p) => (p.payload?.doc_id ? [{ obsId: p.payload.doc_id, score: p.score }] : []));
}

interface Agreement { sameTop10: number; sameTop1: number; overlap10: number }
const tally = { own: { sameTop10: 0, sameTop1: 0, overlap10: 0 } as Agreement, shared: { sameTop10: 0, sameTop1: 0, overlap10: 0 } as Agreement };
const kinds: Record<string, { cases: number; own: number; shared: number }> = {};
for (const c of cases) {
  const fetch = Math.max(10 * 5, 50);
  const base = rankLessons(memory.search(c.query, fetch), byId, now).slice(0, 10);
  const viaOwn = rankLessons((await own.keyword(c.query, fetch, "all")).map((h) => ({ obsId: h.id, score: h.score })), byId, now).slice(0, 10);
  const viaShared = rankLessons(await sharedLessonHits(c.query, fetch), byId, now).slice(0, 10);
  const k = (kinds[c.kind] ??= { cases: 0, own: 0, shared: 0 });
  k.cases++;
  for (const [name, got] of [["own", viaOwn], ["shared", viaShared]] as const) {
    const t = tally[name];
    const same = got.length === base.length && got.every((id, i) => id === base[i]);
    if (same) { t.sameTop10++; k[name]++; }
    if (got[0] === base[0]) t.sameTop1++;
    t.overlap10 += base.length === 0 ? Number(got.length === 0) : got.filter((id) => base.includes(id)).length / base.length;
  }
}
const n = cases.length;
const summary = (t: Agreement) => ({ identicalTop10: `${t.sameTop10}/${n}`, top1Agreement: +(t.sameTop1 / n).toFixed(3), meanOverlap10: +(t.overlap10 / n).toFixed(3) });
console.log(JSON.stringify({
  lessons: lessons.length,
  sharedDocs: (await shared.stats()).docs,
  sharedLoadSeconds: sharedSeconds,
  cases: n,
  own: summary(tally.own),
  shared: summary(tally.shared),
  identicalByKind: kinds,
}, null, 1));

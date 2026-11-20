// Disk keyword search ranks exactly as SearchIndex does: the same top-k ids,
// in the same order, with the same BM25 scores, on one corpus written to both.
// The corpus is written in batches whose mean length differs from the final
// mean, holds exact copies (ties), prefix-only query words, rewrites and deletes.
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-score-parity.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentRev, type DocOp, type Op } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { SearchIndex } from "../src/state/search-index.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import type { CompressedObservation } from "../src/types.js";
import { Generator, type Profile } from "../bench/fork/lib/synthetic.js";
import { mulberry32 } from "../bench/fork/lib/stats.js";
import profile from "../bench/fork/profiles/buddy-2026-11-16.json" with { type: "json" };
import { QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const DOCS = 3000;
const K = 10;
const SCORE_TOLERANCE = 1e-6;

function docOp(o: CompressedObservation): DocOp {
  const fields = termSourceOf(o);
  return { k: "doc", id: o.id, sessionId: o.sessionId, layer: "observation", ts: Date.parse(o.timestamp), rev: contentRev(fields), fields };
}

describe.skipIf(!QDRANT_URL)("disk keyword scores match SearchIndex", () => {
  const qdrant = qdrantFor(`score_parity_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  const memory = new SearchIndex();
  const queries: string[] = [];

  beforeAll(async () => {
    const gen = new Generator(profile as unknown as Profile, DOCS, 1195);
    const rand = mulberry32(11);
    const written: CompressedObservation[] = [];
    let pending: Op[] = [];
    // Batch sizes vary, and the first batch holds only short documents, so the
    // mean length a write is weighted with drifts from the corpus mean.
    const flush = async () => {
      if (pending.length === 0) return;
      const result = await engine.apply(pending);
      expect(result.failed).toEqual([]);
      pending = [];
    };
    const write = async (o: CompressedObservation) => {
      memory.add(o);
      pending.push(docOp(o));
      if (pending.length >= 1 + Math.floor(rand() * 400)) await flush();
    };
    const all: CompressedObservation[] = [];
    for (let s = 0; all.length < DOCS; s++) {
      const session = gen.session(s);
      for (let i = 0; i < 20 && all.length < DOCS; i++) {
        const o = gen.observation(session, i * 1000) as unknown as CompressedObservation;
        if (o.title && o.narrative) all.push(o);
      }
    }
    all.sort((a, b) => (a.narrative.length < 200 ? 0 : 1) - (b.narrative.length < 200 ? 0 : 1));
    for (const o of all) {
      await write(o);
      written.push(o);
      // Exact copies under new ids tie with their original on every query.
      if (rand() < 0.05) {
        const copy = { ...o, id: `${o.id}_copy` };
        await write(copy);
        written.push(copy);
      }
    }
    await flush();
    // Rewrites move a document to the end of the write order; deletes remove it.
    for (const o of written.filter(() => rand() < 0.02)) {
      await write({ ...o, narrative: `${o.narrative} ${written[Math.floor(rand() * written.length)]!.title}` });
    }
    await flush();
    for (const o of written.filter(() => rand() < 0.02)) {
      memory.remove(o.id);
      pending.push({ k: "del", id: o.id });
    }
    await flush();

    const qrand = mulberry32(5);
    while (queries.length < 300) {
      const o = written[Math.floor(qrand() * written.length)]!;
      const words = `${o.title} ${o.narrative}`.split(/\s+/).filter((w) => w.length > 3);
      const n = 1 + Math.floor(qrand() * 3);
      const picked = Array.from({ length: n }, () => words[Math.floor(qrand() * words.length)]!);
      // A third of the queries cut every word, so it matches only through prefixes.
      queries.push((queries.length % 3 === 2 ? picked.map((w) => w.slice(0, Math.max(3, Math.ceil(w.length * 0.6)))) : picked).join(" "));
    }
    await engine.keyword(queries[0]!, K, "all");
    await engine.settled();
  }, 300_000);

  afterAll(async () => {
    await qdrant.drop();
  }, 60_000);

  it("returns SearchIndex's top-k ids in its order, with its scores", async () => {
    const mismatches: Array<{ query: number; sameIds: boolean; memory: Array<[string, number]>; disk: Array<[string, number]> }> = [];
    for (const [i, q] of queries.entries()) {
      const want = memory.search(q, K, "all");
      const got = await engine.keyword(q, K, "all");
      const sameIds = want.map((h) => h.obsId).join() === got.map((h) => h.id).join();
      const sameScores = sameIds && want.every((h, j) => Math.abs(h.score - got[j]!.score) <= SCORE_TOLERANCE * Math.max(1, h.score));
      if (!sameScores) {
        mismatches.push({ query: i, sameIds, memory: want.map((h) => [h.obsId, h.score]), disk: got.map((h) => [h.id, h.score]) });
      }
    }
    if (mismatches.length > 0) console.log(`${mismatches.length} of ${queries.length} queries differ, ${mismatches.filter((m) => !m.sameIds).length} in ids or order; first: ${JSON.stringify(mismatches[0])}`);
    expect(mismatches.length).toBe(0);
  }, 300_000);
});

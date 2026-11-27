// A short prefix query whose exact top document sits past the deep read's depth in Qdrant's order.
// Qdrant sums a query term's prefix matches; SearchIndex takes the best one. 700 documents each hold
// twelve "bes*" terms, so each one's summed score passes the one document with a rare "bes*" term,
// which still ranks first by the best single prefix.
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-prefix-depth.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentRev, type DocOp } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { querySparse } from "../src/fork/worker/bm25-sparse.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { SearchIndex } from "../src/state/search-index.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import type { CompressedObservation } from "../src/types.js";
import { QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const CROWDERS = 700;
const FILLERS = 2300;
const DEEP_READ_DEPTH = 510;

const observation = (id: string, title: string): CompressedObservation => ({
  id, sessionId: "ses_depth", title, narrative: "", facts: [], concepts: [], files: [],
  type: "discovery", importance: 5, timestamp: "2026-11-01T00:00:00.000Z",
});

function docOp(o: CompressedObservation): DocOp {
  const fields = termSourceOf(o);
  return { k: "doc", id: o.id, sessionId: o.sessionId, layer: "observation", ts: 1, fields, rev: contentRev(fields) };
}

describe.skipIf(!QDRANT_URL)("a prefix match past the deep read's depth", () => {
  const qdrant = qdrantFor(`prefix_depth_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  const memory = new SearchIndex();

  beforeAll(async () => {
    const crowd = "besa besb besc besd bese besf besg besh besi besj besk besl";
    const docs = [
      ...Array.from({ length: CROWDERS }, (_, i) => observation(`crowd_${String(i).padStart(4, "0")}`, crowd)),
      observation("rare", "besrare zzfill zzfill zzfill zzfill"),
      ...Array.from({ length: FILLERS }, (_, i) => observation(`fill_${String(i).padStart(4, "0")}`, "filler common")),
    ];
    for (let i = 0; i < docs.length; i += 500) {
      const batch = docs.slice(i, i + 500);
      expect((await engine.apply(batch.map(docOp))).failed).toEqual([]);
      for (const o of batch) memory.add(o);
    }
    await engine.keyword("bes", 10, "all");
    await engine.settled();
  }, 120_000);

  afterAll(async () => {
    await engine.settled();
    await qdrant.drop();
  }, 60_000);

  it("sits past the depth in Qdrant's summed order", async () => {
    const res = await qdrant.call<{ points: Array<{ payload?: { doc_id?: string } }> }>("POST", `${qdrant.path}/points/query`, {
      query: querySparse("bes", (terms) => engine.prefixes!.expand(terms, true)), using: "bm25", limit: DEEP_READ_DEPTH, with_payload: ["doc_id"],
    });
    expect(res.points).toHaveLength(DEEP_READ_DEPTH);
    expect(res.points.map((p) => p.payload?.doc_id)).not.toContain("rare");
  });

  it("still ranks it as SearchIndex does", async () => {
    for (const k of [1, 10]) {
      const want = memory.search("bes", k).map(({ obsId, score }) => [obsId, score] as const);
      const got = (await engine.keyword("bes", k, "all")).map(({ id, score }) => [id, score] as const);
      expect(got.map(([id]) => id), `k=${k}`).toEqual(want.map(([id]) => id));
      for (const [j, [, score]] of got.entries()) expect(score).toBeCloseTo(want[j]![1], 6);
    }
  });
});

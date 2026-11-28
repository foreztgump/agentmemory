import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { termId, termsSparse } from "../src/fork/worker/bm25-sparse.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { expandLexicalTerms, lexicalBm25 } from "../src/fork/worker/lexical-bm25.js";
import { queryTerms } from "../src/state/term-extraction.js";
import { Qdrant } from "../src/fork/worker/qdrant.js";

const point = (id: string, order: number, terms = ["redi"]) => ({
  id, score: 1, payload: { doc_id: id, session_id: "s", terms, dl: terms.length, lexical_order: [1, order] },
});

async function rig() {
  const qdrant = new Qdrant({ url: "http://qdrant.test", collection: "keyword_payload", dimensions: 16, oversampling: 6, timeoutMs: 1000 });
  vi.spyOn(qdrant, "ensure").mockResolvedValue();
  const call = vi.spyOn(qdrant, "call").mockResolvedValue({ points: [], next_page_offset: null });
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  engine.prefixes!.fillInBackground();
  await engine.settled();
  engine.prefixes!.observe(["redi"]);
  engine.prefixes!.noteIndexedAverageLength(1);
  Object.assign(engine, { avgdl: 1 });
  call.mockClear();
  return { call, engine };
}

describe("keyword payload pruning", () => {
  it("keeps the original single request while re-scoring is off", async () => {
    const { call, engine } = await rig();
    engine.prefixes!.clear();
    vi.spyOn(engine.prefixes!, "fillInBackground").mockImplementation(() => {});
    call.mockResolvedValue({ points: [point("raw", 0)] });
    expect(await engine.keyword("redis", 1, "all")).toEqual([{ id: "raw", sessionId: "s", score: 1 }]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toMatchObject({ limit: 1, with_payload: ["doc_id", "session_id"] });
  });

  it("re-scores each chunk, avoids shallow duplicates, and stops when the cutoff rises", async () => {
    const { call, engine } = await rig();
    const shallow = Array.from({ length: 17 }, (_, i) => point(`shallow_${i}`, i));
    const tail = Array.from({ length: 40 }, (_, i) => point(`tail_${i}`, 17 + i));
    vi.spyOn(engine.prefixes!, "scoreUpperBound").mockReturnValue(2);
    call.mockImplementation(async (_method, path, raw) => {
      const body = raw as { limit?: number; ids?: string[] };
      if (path.endsWith("/points/query")) return { points: body.limit === 17 ? shallow : [...shallow, ...tail].map(({ id }) => ({ id, score: 0.2 })) };
      return tail.filter(({ id }) => body.ids!.includes(id)).map((p) => ({ ...p, payload: { ...p.payload, dl: 0 } }));
    });
    const hits = await engine.keyword("redis", 1, "all");
    expect(hits[0]!.id).toBe("tail_0");
    const requests = call.mock.calls;
    expect(requests).toHaveLength(3);
    expect(requests[1]![2]).toMatchObject({ with_payload: false, with_vector: false });
    expect(requests[2]![2]).toMatchObject({ ids: tail.slice(0, 16).map(({ id }) => id), with_vector: false });
  });

  it("fetches equal-bound candidates and preserves posting order regardless of retrieval order", async () => {
    const { call, engine } = await rig();
    const exact = lexicalBm25([{ id: "x", sessionId: "s", terms: ["redi"], dl: 1 }], [{ term: "redi", weight: 1, prefixes: [] }], engine.prefixes!.frequencies, 1, 1, 1)[0]!.score;
    const shallow = Array.from({ length: 17 }, (_, i) => ({ ...point(`shallow_${i}`, 100 + i), score: exact }));
    const tail = [point("earliest", 0), point("earlier", 1)];
    vi.spyOn(engine.prefixes!, "scoreUpperBound").mockReturnValue(1);
    call.mockImplementation(async (_method, path, raw) => {
      const body = raw as { limit?: number };
      if (path.endsWith("/points/query")) return { points: body.limit === 17 ? shallow : [...shallow, ...tail.map(({ id }) => ({ id, score: exact }))] };
      return [...tail].reverse();
    });
    expect((await engine.keyword("redis", 1, "all"))[0]!.id).toBe("earliest");
    expect(call.mock.calls[2]![2]).toMatchObject({ ids: ["earliest", "earlier"] });
  });

  it("uses sparse-vector bounds for wide queries and falls back when a vector is missing", async () => {
    const { call, engine } = await rig();
    for (let i = 0; i < 1100; i++) engine.prefixes!.observe([`red${i}`]);
    vi.spyOn(engine.prefixes!, "scoreUpperBound").mockReturnValue(100);
    const shallow = Array.from({ length: 17 }, (_, i) => point(`shallow_${i}`, i));
    call.mockImplementation(async (_method, path, raw) => {
      const body = raw as { limit?: number };
      if (path.endsWith("/points/query")) return { points: body.limit === 17 ? shallow : [
        ...shallow.map(({ id }) => ({ id, score: 100 })),
        { id: "pruned", score: 100, vector: { bm25: termsSparse(["other"], 1) } },
        { id: "missing", score: 100 },
      ] };
      return [point("missing", 100)];
    });
    await engine.keyword("red", 1, "all");
    expect(call.mock.calls[1]![2]).toMatchObject({ with_payload: false, with_vector: ["bm25"] });
    expect(call.mock.calls[2]![2]).toMatchObject({ ids: ["missing"] });
  });

  it("doubles each payload chunk while the cutoff holds", async () => {
    const { call, engine } = await rig();
    const exact = lexicalBm25([{ id: "x", sessionId: "s", terms: ["redi"], dl: 1 }], [{ term: "redi", weight: 1, prefixes: [] }], engine.prefixes!.frequencies, 1, 1, 1)[0]!.score;
    const docs = Array.from({ length: 117 }, (_, i) => ({ ...point(`doc_${i}`, i), score: exact }));
    vi.spyOn(engine.prefixes!, "scoreUpperBound").mockReturnValue(1);
    call.mockImplementation(async (_method, path, raw) => {
      const body = raw as { limit?: number; ids?: string[] };
      if (path.endsWith("/points/query")) return { points: body.limit === 17 ? docs.slice(0, 17) : docs.map(({ id }) => ({ id, score: exact })) };
      return docs.filter(({ id }) => body.ids!.includes(id));
    });
    expect((await engine.keyword("redis", 1, "all"))[0]!.id).toBe("doc_0");
    expect(call.mock.calls.slice(2).map(([, , body]) => (body as { ids: string[] }).ids.length)).toEqual([16, 32, 52]);
  });
});

describe("keyword search past the deep read's depth", () => {
  const CROWD = 700;
  const DEPTH = 501;
  const crowd = Array.from({ length: CROWD }, (_, i) => point(`crowd_${String(i).padStart(3, "0")}`, i));
  const rare = point("rare", CROWD, ["redicache"]);

  /** A Qdrant whose summed order puts the first 700 documents first, so the rest sit past the deep read. */
  async function pastDepthRig(docs: typeof crowd, { shallowFirst = docs[0]!, probeVectors = true } = {}) {
    const crowd = docs.slice(0, CROWD);
    const { call, engine } = await rig();
    for (const { payload } of docs.slice(1)) engine.prefixes!.observe(payload.terms);
    vi.spyOn(engine.prefixes!, "scoreUpperBound").mockReturnValue(1000);
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    const qdrantIdf = 2;
    const list = (id: number) => docs.flatMap((doc) => {
      const bm25 = termsSparse(doc.payload.terms, 1);
      const at = bm25.indices.indexOf(id);
      return at < 0 ? [] : [{ id: doc.id, score: qdrantIdf * bm25.values[at]!, vector: { bm25 } }];
    }).sort((a, b) => b.score - a.score);
    const shallow = [shallowFirst, ...crowd.filter((doc) => doc !== shallowFirst).slice(0, 16)];
    call.mockImplementation(async (_method, path, raw) => {
      const body = raw as { limit?: number; ids?: string[]; searches?: Array<{ query: { indices: number[] }; limit: number; with_vector: unknown }> };
      if (path.endsWith("/points/query/batch")) {
        return body.searches!.map(({ query, limit, with_vector }) => ({
          points: list(query.indices[0]!).slice(0, limit).map(({ vector, ...rest }) => (with_vector && probeVectors ? { ...rest, vector } : rest)),
        }));
      }
      if (path.endsWith("/points/query")) {
        return { points: body.limit === 17 ? shallow : [...shallow, ...crowd.filter((doc) => !shallow.includes(doc))].slice(0, DEPTH).map(({ id }) => ({ id, score: 1 })) };
      }
      return body.ids!.map((id) => byId.get(id)!);
    });
    const vocabulary = engine.prefixes!;
    const expected = lexicalBm25(docs.map(({ id, payload }) => ({ id, sessionId: "s", terms: payload.terms, dl: payload.dl })),
      expandLexicalTerms(queryTerms("redis"), vocabulary.frequencies), vocabulary.frequencies, vocabulary.documentCount, vocabulary.averageLength, 1);
    const lists = () => call.mock.calls.filter(([, path]) => path.endsWith("/points/query/batch"))
      .map(([, , body]) => (body as { searches: Array<{ query: { indices: number[] }; limit: number }> }).searches.map(({ query, limit }) => [query.indices[0], limit]));
    return { engine, expected, lists };
  }

  const redi = termId("redi");
  const cache = termId("redicache");

  it.each([true, false])("finds the document, deepening each list by 4 until it is exhausted (probe vectors: %s)", async (probeVectors) => {
    const { engine, expected, lists } = await pastDepthRig([...crowd, rare], { probeVectors });
    expect(expected[0]!.id).toBe("rare");
    expect(await engine.keyword("redis", 1, "all")).toEqual(expected);
    expect(lists()).toEqual([
      [[redi, 68], [redi, 1], [cache, 68], [cache, 1]],
      [[redi, 272], [redi, 1]],
      [[redi, 1088], [redi, 1]],
    ]);
  });

  it("stops without deepening once no unread document can reach the k-th score", async () => {
    const { engine, expected, lists } = await pastDepthRig([...crowd, rare], { shallowFirst: rare });
    expect(await engine.keyword("redis", 1, "all")).toEqual(expected);
    expect(lists()).toHaveLength(1);
  });

  it("deepens only the lists whose floor could still reach the k-th score", async () => {
    const both = crowd.map(({ id }, i) => point(id, i, ["redi", "redicache"]));
    const common = Array.from({ length: 300 }, (_, i) => point(`common_${String(i).padStart(3, "0")}`, CROWD + i, ["redicache"]));
    const { engine, expected, lists } = await pastDepthRig([...both, ...common]);
    expect(expected[0]!.id).toBe("crowd_000");
    expect(await engine.keyword("redis", 1, "all")).toEqual(expected);
    expect(lists()).toEqual([
      [[redi, 68], [redi, 1], [cache, 68], [cache, 1]],
      [[redi, 272], [redi, 1]],
      [[redi, 1088], [redi, 1]],
    ]);
  });
});

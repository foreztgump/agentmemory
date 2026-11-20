import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { termsSparse } from "../src/fork/worker/bm25-sparse.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { lexicalBm25 } from "../src/fork/worker/lexical-bm25.js";
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
});

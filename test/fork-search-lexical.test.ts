import { afterAll, describe, expect, it, vi } from "vitest";
import { contentRev, type DocOp } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { pointId, Qdrant } from "../src/fork/worker/qdrant.js";
import { TOMBSTONE } from "../src/fork/worker/versioned.js";
import { SearchIndex } from "../src/state/search-index.js";
import { queryTerms, termSourceOf } from "../src/state/term-extraction.js";
import type { CompressedObservation } from "../src/types.js";
import { DIMS, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

function document(id: string, title: string): CompressedObservation {
  return { id, sessionId: "lesson", title, narrative: "", facts: [], concepts: [], files: [], type: "discovery", importance: 5, timestamp: "2026-11-01T00:00:00.000Z" };
}

function docOp(obs: CompressedObservation): DocOp {
  const fields = termSourceOf(obs);
  return { k: "doc", id: obs.id, sessionId: obs.sessionId, layer: "lesson", ts: 1, fields, rev: contentRev(fields) };
}

describe("lessons lexical Qdrant requests", () => {
  it.each([true, false])("ensures the terms index for an existing=%s lessons collection only", async (exists) => {
    for (const layout of ["text", "lessons", "image"] as const) {
      const qdrant = new Qdrant({ url: "http://qdrant.test", collection: "t1167fix_indexes", dimensions: DIMS, timeoutMs: 1000, oversampling: 6, layout });
      vi.spyOn(qdrant, "exists").mockResolvedValue(exists);
      const call = vi.spyOn(qdrant, "call").mockResolvedValue(undefined);
      await qdrant.ensure();
      const indexes = call.mock.calls.filter(([, path]) => path.endsWith("/index?wait=true")).map(([, , body]) => body);
      expect(indexes.some((body) => (body as { field_name: string }).field_name === "terms")).toBe(layout === "lessons");
      if (layout === "lessons") expect(indexes).toContainEqual({ field_name: "terms", field_schema: "keyword" });
    }
  });

  it.each([true, false])("indexes the tombstone field of an existing=%s collection in every layout", async (exists) => {
    for (const layout of ["text", "lessons", "image"] as const) {
      const qdrant = new Qdrant({ url: "http://qdrant.test", collection: "t1222_indexes", dimensions: DIMS, timeoutMs: 1000, oversampling: 6, layout });
      vi.spyOn(qdrant, "exists").mockResolvedValue(exists);
      const call = vi.spyOn(qdrant, "call").mockResolvedValue(undefined);
      await qdrant.ensure();
      const indexes = call.mock.calls.filter(([, path]) => path.endsWith("/index?wait=true")).map(([, , body]) => body);
      expect(indexes, layout).toContainEqual({ field_name: TOMBSTONE.key, field_schema: "bool" });
    }
  });

  it("expands a complete vocabulary, pages candidates and invalidates the cache on apply and both clears", async () => {
    const qdrant = new Qdrant({ url: "http://qdrant.test", collection: "t1167fix_requests", dimensions: DIMS, timeoutMs: 1000, oversampling: 6, layout: "lessons" });
    vi.spyOn(qdrant, "ensure").mockResolvedValue();
    vi.spyOn(qdrant, "drop").mockResolvedValue();
    vi.spyOn(qdrant, "count").mockResolvedValue(2);
    const vocabulary = Array.from({ length: 1025 }, (_, i) => ({ value: i === 1 || i === 2 ? `zebra${i}` : `redis${i}`, count: 1 }));
    const call = vi.spyOn(qdrant, "call").mockImplementation(async (_method, path, raw) => {
      const body = raw as { key?: string; limit?: number; offset?: string };
      if (path.endsWith("/facet")) {
        if (body.key === "dl") return { hits: [{ value: 1, count: 2 }] };
        return { hits: vocabulary.slice(0, body.limit) };
      }
      if (path.endsWith("/points/scroll")) {
        const second = body.offset === "next";
        return { points: [{ id: second ? "b" : "a", payload: { doc_id: second ? "b" : "a", session_id: "lesson", terms: [second ? "redis1024" : "redis0"], dl: 1 } }], next_page_offset: second ? null : "next" };
      }
      return {};
    });
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    const facets = () => call.mock.calls.filter(([, , body]) => (body as { key?: string })?.key === "terms");
    expect((await engine.keyword("redis", 50, "all")).map(({ id }) => id)).toEqual(["a", "b"]);
    expect(facets().map(([, , body]) => (body as { limit: number }).limit)).toEqual([1024, 2048]);
    await engine.keyword("redis", 50, "all");
    expect(facets()).toHaveLength(2);
    await engine.apply([], 1000);
    await engine.keyword("redis", 50, "all");
    expect(facets()).toHaveLength(3);
    await engine.clear("vectors");
    await engine.keyword("redis", 50, "all");
    expect(facets()).toHaveLength(4);
    await engine.clear("all");
    await engine.keyword("redis", 50, "observation");
    expect(facets().slice(4).map(([, , body]) => (body as { limit: number }).limit)).toEqual([1024, 2048]);
    const requests = call.mock.calls.filter(([, path]) => path.endsWith("/points/scroll"));
    expect(requests[0]![2]).toMatchObject({ filter: { must: [{ key: "terms", match: { any: expect.arrayContaining([...queryTerms("redis").map(({ term }) => term), "redis1024"]) } }], must_not: [TOMBSTONE] }, with_vector: false });
    expect(requests[1]![2]).toMatchObject({ offset: "next" });
    expect(requests.at(-1)![2]).toMatchObject({ filter: { must: expect.arrayContaining([{ key: "layer", match: { value: "observation" } }]) } });
    for (const [, , body] of facets()) expect(body).toMatchObject({ exact: true, filter: { must_not: [TOMBSTONE] } });
    expect(call.mock.calls.some(([, path]) => path.endsWith("/points/query"))).toBe(false);
  });

  it("re-reads the vocabulary after a write in one facet call sized from the last read", async () => {
    const qdrant = new Qdrant({ url: "http://qdrant.test", collection: "t1167fix_resize", dimensions: DIMS, timeoutMs: 1000, oversampling: 6, layout: "lessons" });
    vi.spyOn(qdrant, "ensure").mockResolvedValue();
    vi.spyOn(qdrant, "count").mockResolvedValue(1);
    const vocabulary = Array.from({ length: 5000 }, (_, i) => ({ value: `redis${i}`, count: 1 }));
    const call = vi.spyOn(qdrant, "call").mockImplementation(async (_method, path, raw) => {
      const body = raw as { key?: string; limit?: number };
      if (path.endsWith("/facet")) return body.key === "dl" ? { hits: [{ value: 1, count: 1 }] } : { hits: vocabulary.slice(0, body.limit) };
      if (path.endsWith("/points/scroll")) return { points: [{ id: "a", payload: { doc_id: "a", session_id: "lesson", terms: ["redis0"], dl: 1 } }], next_page_offset: null };
      return {};
    });
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    const facets = () => call.mock.calls.filter(([, , body]) => (body as { key?: string })?.key === "terms").map(([, , body]) => (body as { limit: number }).limit);
    await engine.keyword("redis", 10, "all");
    const first = facets().length;
    await engine.apply([], 1000);
    await engine.keyword("redis", 10, "all");
    expect(facets().slice(first)).toHaveLength(1);
  });

  it("bounds the terms filter when prefix expansion is wide, and still scores every matching lesson", async () => {
    const qdrant = new Qdrant({ url: "http://qdrant.test", collection: "t1167fix_wide", dimensions: DIMS, timeoutMs: 1000, oversampling: 6, layout: "lessons" });
    vi.spyOn(qdrant, "ensure").mockResolvedValue();
    vi.spyOn(qdrant, "count").mockResolvedValue(3);
    const vocabulary = [...Array.from({ length: 3000 }, (_, i) => ({ value: `redis${i}`, count: 1 })), { value: "zebra", count: 1 }];
    const points = [
      { id: "a", payload: { doc_id: "a", session_id: "lesson", terms: ["redis7"], dl: 1 } },
      { id: "b", payload: { doc_id: "b", session_id: "lesson", terms: ["redis2999", "redis2999"], dl: 2 } },
      { id: "z", payload: { doc_id: "z", session_id: "lesson", terms: ["zebra"], dl: 1 } },
    ];
    const call = vi.spyOn(qdrant, "call").mockImplementation(async (_method, path, raw) => {
      const body = raw as { key?: string; limit?: number };
      if (path.endsWith("/facet")) return body.key === "dl" ? { hits: [{ value: 1, count: 2 }, { value: 2, count: 1 }] } : { hits: vocabulary.slice(0, body.limit) };
      if (path.endsWith("/points/scroll")) return { points, next_page_offset: null };
      return {};
    });
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    const hits = await engine.keyword("redis", 10, "all");
    expect(hits.map(({ id }) => id).sort()).toEqual(["a", "b"]);
    const scrolls = call.mock.calls.filter(([, path]) => path.endsWith("/points/scroll")).map(([, , body]) => body as { filter: { must?: Array<{ match?: { any?: string[] } }> } });
    const anyLengths = scrolls.flatMap(({ filter }) => (filter.must ?? []).map((c) => c.match?.any?.length ?? 0));
    expect(Math.max(0, ...anyLengths)).toBeLessThanOrEqual(1024);
  });
});

describe.skipIf(!QDRANT_URL)("lessons lexical live paging and lifecycle", () => {
  const qdrant = qdrantFor(`t1167fix_lexical_${process.pid}`, DIMS, "lessons");
  afterAll(() => qdrant.drop(), 30_000);

  it("preserves tied cutoffs across pages, updates, deletes, restart and clear", async () => {
    const memory = new SearchIndex();
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    const corpus = Array.from({ length: 310 }, (_, i) => document(`lsn_${String(i).padStart(4, "0")}`, i % 2 ? "redisproxy" : "redis"));
    for (const doc of corpus) memory.add(doc, "lesson");
    expect((await engine.apply(corpus.map(docOp))).failed).toEqual([]);
    const compare = async (worker = engine) => {
      for (const query of ["redis", "red", "redisproxy", "redis redisproxy", "missing"]) {
        for (const limit of [1, 50, 1000]) {
          const expected = memory.search(query, limit).map(({ obsId, sessionId, score }) => ({ id: obsId, sessionId, score }));
          expect(await worker.keyword(query, limit, "all"), query).toEqual(expected);
        }
      }
    };
    await compare();
    const updated = document(corpus[0]!.id, "redisproxy");
    memory.add(updated, "lesson");
    memory.remove(corpus[1]!.id);
    await engine.apply([docOp(updated), { k: "del", id: corpus[1]!.id }]);
    await qdrant.call("POST", `${qdrant.path}/points/payload?wait=true`, { points: [pointId(corpus[1]!.id)], payload: { terms: ["redisproxy"], dl: 10000 } });
    await compare();
    await compare(new SearchEngine(qdrant, DEFAULT_AVGDL));
    await engine.clear("vectors");
    await compare();
    await engine.clear("all");
    expect(await engine.keyword("red", 50, "all")).toEqual([]);
    memory.clear();
    const next = document("lsn_next", "redisproxy");
    memory.add(next, "lesson");
    await engine.apply([docOp(next)]);
    await compare();
  }, 60_000);

  it("matches SearchIndex when a query term's prefix expansion is wider than the terms filter bound", async () => {
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    await engine.clear("all");
    const memory = new SearchIndex();
    const corpus = Array.from({ length: 1200 }, (_, i) => document(`lsn_wide_${i}`, i % 3 ? `redis${i.toString(36)}` : `redis${i.toString(36)} zebra`));
    corpus.push(document("lsn_wide_other", "zebra crossing"));
    for (const doc of corpus) memory.add(doc, "lesson");
    expect((await engine.apply(corpus.map(docOp))).failed).toEqual([]);
    for (const query of ["redis", "red zebra", "zebra", "redis1"]) {
      for (const limit of [5, 1000]) {
        const expected = memory.search(query, limit).map(({ obsId, sessionId, score }) => ({ id: obsId, sessionId, score }));
        expect(await engine.keyword(query, limit, "all"), `${query} ${limit}`).toEqual(expected);
      }
    }
  }, 60_000);

  it("keeps older writes fenced and excludes tombstones from cached frequencies", async () => {
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    await engine.clear("all");
    const first = document("lsn_versioned", "redisproxy");
    await engine.apply([docOp(first)], 1000);
    expect((await engine.keyword("red", 50, "all")).map(({ id }) => id)).toEqual([first.id]);
    await engine.apply([{ k: "del", id: first.id }], 3000);
    expect(await engine.keyword("red", 50, "all")).toEqual([]);
    await engine.apply([docOp(first)], 2000);
    expect(await engine.keyword("red", 50, "all")).toEqual([]);
    const revived = document(first.id, "rediscache");
    await engine.apply([docOp(revived)], 4000);
    await engine.apply([docOp(first), { k: "del", id: first.id }], 3500);
    const memory = new SearchIndex();
    memory.add(revived, "lesson");
    expect(await engine.keyword("red", 50, "all")).toEqual(memory.search("red", 50).map(({ obsId, sessionId, score }) => ({ id: obsId, sessionId, score })));
    expect(await engine.keyword("redisproxy", 50, "all")).toEqual([]);
  }, 30_000);
});

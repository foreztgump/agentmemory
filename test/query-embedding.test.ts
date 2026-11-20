import { afterEach, describe, expect, it, vi } from "vitest";
import { withDimensionGuard } from "../src/providers/embedding/index.js";
import { VoyageEmbeddingProvider } from "../src/providers/embedding/voyage.js";
import { CohereEmbeddingProvider } from "../src/providers/embedding/cohere.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import {
  getSearchIndex,
  rankMemoryIds,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/search.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import type { CompressedObservation, EmbeddingProvider, Memory } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.restoreAllMocks();
  setVectorIndex(null);
  setEmbeddingProvider(null);
  getSearchIndex().clear();
});

function spyFetch(response: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
}

function sentBodies(spy: ReturnType<typeof spyFetch>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
}

describe("query and document input types", () => {
  it("Voyage sends input_type query for queries and document for stored content", async () => {
    const spy = spyFetch(() => new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.1) }] })));
    const provider = withDimensionGuard(new VoyageEmbeddingProvider("test-key"));
    await provider.embedQuery!("find the thing");
    await provider.embed("stored text");
    await provider.embedBatch(["stored text"]);
    expect(sentBodies(spy).map((b) => b.input_type)).toEqual(["query", "document", "document"]);
  });

  it("Cohere sends search_query for queries and search_document for stored content", async () => {
    const spy = spyFetch(() => new Response(JSON.stringify({ embeddings: [new Array(1024).fill(0.1)] })));
    const provider = withDimensionGuard(new CohereEmbeddingProvider("test-key"));
    await provider.embedQuery!("find the thing");
    await provider.embed("stored text");
    await provider.embedBatch(["stored text"]);
    expect(sentBodies(spy).map((b) => b.input_type)).toEqual(["search_query", "search_document", "search_document"]);
  });

  it("the dimension guard checks query embeddings too", async () => {
    spyFetch(() => new Response(JSON.stringify({ data: [{ embedding: new Array(8).fill(0.1) }] })));
    const provider = withDimensionGuard(new VoyageEmbeddingProvider("test-key"));
    await expect(provider.embedQuery!("q")).rejects.toThrow(/dimension/i);
  });
});

function splitProvider(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn>; embedQuery: ReturnType<typeof vi.fn> } {
  return {
    name: "split",
    dimensions: 2,
    embed: vi.fn(async () => new Float32Array([0, 1])),
    embedQuery: vi.fn(async () => new Float32Array([1, 0])),
    embedBatch: vi.fn(async () => []),
  };
}

const kv = {
  get: async () => null,
  set: async <T>(_s: string, _k: string, v: T) => v,
  delete: async () => {},
  list: async () => [],
};

function obs(id: string): CompressedObservation {
  return {
    id, sessionId: `ses_${id}`, timestamp: "2026-11-19T00:00:00.000Z", type: "command_run",
    title: "quasar note", narrative: "quasar", facts: [], concepts: [], files: [], importance: 5,
  };
}

describe("search embeds the query as a query", () => {
  it("HybridSearch uses embedQuery, with and without a request", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    bm25.add(obs("o1"));
    vector.add("o1", "ses_o1", new Float32Array([1, 0]));
    const provider = splitProvider();
    const hybrid = new HybridSearch(bm25, vector, provider, kv as never, 0.4, 0.6, 0);
    await hybrid.search("quasar", 5);
    await hybrid.search("quasar", 5, "all", undefined, {});
    expect(provider.embedQuery).toHaveBeenCalledTimes(2);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("HybridSearch falls back to embed for a provider without embedQuery", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    bm25.add(obs("o1"));
    vector.add("o1", "ses_o1", new Float32Array([1, 0]));
    const embed = vi.fn(async () => new Float32Array([1, 0]));
    const hybrid = new HybridSearch(bm25, vector, { name: "plain", dimensions: 2, embed, embedBatch: async () => [] }, kv as never, 0.4, 0.6, 0);
    await hybrid.search("quasar", 5);
    expect(embed).toHaveBeenCalledWith("quasar");
  });

  it("memory recall ranking uses embedQuery", async () => {
    const saved = {
      id: "mem_1", title: "quasar policy", content: "quasar", type: "fact", concepts: [], files: [],
      sessionIds: [], strength: 7, createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
      version: 1, isLatest: true,
    } as Memory;
    getSearchIndex().add(memoryToObservation(saved), "memory");
    const vector = new VectorIndex();
    vector.add(saved.id, "memory", new Float32Array([1, 0]));
    const provider = splitProvider();
    setVectorIndex(vector);
    setEmbeddingProvider(provider);
    expect((await rankMemoryIds("quasar", 1)).mode).toBe("hybrid");
    expect(provider.embedQuery).toHaveBeenCalledWith("quasar");
    expect(provider.embed).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import { loadEmbeddingConfig } from "../src/config.js";
import type { CompressedObservation } from "../src/types.js";

function observation(id: string, text: string): CompressedObservation {
  return {
    id, sessionId: `ses_${id}`, timestamp: "2026-11-19T00:00:00.000Z", type: "command_run",
    title: text, narrative: text, facts: [], concepts: [], files: [], importance: 5,
  };
}

async function keywordHitRank(bm25Weight: number, vectorWeight: number): Promise<number> {
  const records = new Map<string, unknown>();
  const kv = {
    get: async <T>(scope: string, id: string) => (records.get(`${scope}/${id}`) as T) ?? null,
    set: async <T>(scope: string, id: string, value: T) => { records.set(`${scope}/${id}`, value); return value; },
    delete: async () => {},
    list: async () => [],
  };
  const bm25 = new SearchIndex();
  const vector = new VectorIndex();
  const add = async (obs: CompressedObservation) => {
    bm25.add(obs);
    await kv.set(KV.observations(obs.sessionId), obs.id, obs);
  };
  await add(observation("keyword_hit", "zephyrquartz rollout checklist"));
  for (let i = 0; i < 40; i++) {
    const id = `vector_${String(i).padStart(2, "0")}`;
    await add(observation(id, `unrelated note ${i}`));
    vector.add(id, `ses_${id}`, new Float32Array([1, i / 100]));
  }
  const provider = { name: "fixed", dimensions: 2, embed: async () => new Float32Array([1, 0]), embedBatch: async () => [] };
  const hybrid = new HybridSearch(bm25, vector, provider, kv as never, bm25Weight, vectorWeight, 0);
  const results = await hybrid.search("zephyrquartz", 10);
  expect(results).toHaveLength(10);
  return results.findIndex((r) => r.observation.id === "keyword_hit") + 1;
}

describe("hybrid fusion keeps a keyword rank-1 hit when the vector list does not overlap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("at the default weights", async () => {
    vi.stubEnv("BM25_WEIGHT", "");
    vi.stubEnv("VECTOR_WEIGHT", "");
    const { bm25Weight, vectorWeight } = loadEmbeddingConfig();
    expect(await keywordHitRank(bm25Weight, vectorWeight)).toBeGreaterThan(0);
  });

  it.each([
    [0.5, 0.5],
    [0.6, 0.4],
  ])("at BM25 %s / vector %s", async (bm25Weight, vectorWeight) => {
    expect(await keywordHitRank(bm25Weight, vectorWeight)).toBeGreaterThan(0);
  });
});

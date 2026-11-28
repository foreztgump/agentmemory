import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { getSearchIndex } from "../src/functions/search.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { KV } from "../src/state/schema.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import type { Memory } from "../src/types.js";

// The store shape agents search most (TEE-1451): ~760 saved memories over 8 projects, queried with
// { query, project, targetLayer: "memory" }. Each state read is one round trip to the engine and Kvrocks in
// production, so the cost of a search is its read count and how many of those reads wait on each other.
function fixture() {
  const store = new Map<string, Map<string, unknown>>();
  const reads = { gets: 0, waves: 0, inFlight: 0 };
  const kv = {
    get: async (scope: string, key: string) => {
      reads.gets++;
      if (reads.inFlight++ === 0) reads.waves++;
      await new Promise((resolve) => setImmediate(resolve));
      reads.inFlight--;
      return store.get(scope)?.get(key) ?? null;
    },
    set: async (scope: string, key: string, value: unknown) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async () => {},
    list: async (scope: string) => Array.from(store.get(scope)?.values() ?? []),
  };
  const index = getSearchIndex();
  const hybrid = new HybridSearch(index, null, null, kv as never, 0.4, 0.6, 0);
  let handle!: (data: Record<string, unknown>) => Promise<{ results: Array<{ obsId: string; memoryType?: string }> }>;
  const sdk = {
    registerFunction: (_id: string, fn: typeof handle) => { handle = fn; },
    trigger: vi.fn(async () => ({ success: true, lessons: [] })),
  };
  registerSmartSearchFunction(sdk as never, kv as never, (...args) => hybrid.search(...args));
  const seed = () => {
    for (let i = 0; i < 760; i++) {
      const project = i % 50 === 0 ? "rare" : `project-${i % 8}`;
      const text = `deploy rollback decision ${i} for ${project} ${i % 3 ? "staging" : "production"} cluster`;
      const memory: Memory = {
        id: `mem_${i}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", type: "fact",
        title: text, content: text, concepts: [], files: [], sessionIds: [], strength: 5,
        version: 1, isLatest: true, project,
      };
      index.add(memoryToObservation(memory), "memory");
      store.set(KV.memories, store.get(KV.memories) ?? new Map());
      store.get(KV.memories)!.set(memory.id, memory);
    }
  };
  const search = async (data: Record<string, unknown>) => {
    reads.gets = 0;
    reads.waves = 0;
    const out = await handle({ query: "deploy rollback production", ...data });
    return { ids: out.results.map((r) => r.obsId), types: out.results.map((r) => r.memoryType), gets: reads.gets, waves: reads.waves };
  };
  return { seed, search };
}

describe("smart search read cost (TEE-1451)", () => {
  afterEach(() => getSearchIndex().clear());

  const shapes: Array<[string, Record<string, unknown>]> = [
    ["project memory", { project: "project-3", targetLayer: "memory", limit: 10 }],
    ["project memory, limit 5", { project: "project-5", targetLayer: "memory", limit: 5 }],
    ["rare project memory", { project: "rare", targetLayer: "memory", limit: 10 }],
    ["rare project, every layer", { project: "rare", targetLayer: "all", limit: 10, includeLessons: false }],
    ["memory", { targetLayer: "memory", limit: 10 }],
  ];

  it("returns the same ranked results for the shapes agents send", async () => {
    const f = fixture();
    f.seed();
    for (const [name, data] of shapes) {
      const r = await f.search(data);
      expect({ ids: r.ids, types: r.types }).toMatchSnapshot(name);
    }
  });

  // Before TEE-1451 a scoped search whose project held few matches read each memory up to four times
  // (enrich tried the observation scope first, then the project filter and the compact list re-read it) and
  // ran the project filter ten reads at a time: 2,500 reads in 79 waves here, against 60 in 2 unscoped.
  it.each([
    ["project memory", { project: "project-3", targetLayer: "memory", limit: 10 }, { gets: 200, waves: 6 }],
    ["rare project memory", { project: "rare", targetLayer: "memory", limit: 10 }, { gets: 900, waves: 12 }],
    ["memory", { targetLayer: "memory", limit: 10 }, { gets: 60, waves: 3 }],
  ])("keeps the reads of a %s search under its ceiling", async (_name, data, ceiling) => {
    const f = fixture();
    f.seed();
    const r = await f.search(data);
    expect(r.gets).toBeLessThanOrEqual(ceiling.gets);
    expect(r.waves).toBeLessThanOrEqual(ceiling.waves);
  });
});

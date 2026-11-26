// Disk mode is ready only once the search worker ranks exactly: until its
// corpus statistics have filled, keyword search falls back to Qdrant's raw
// order, so the boot must not report the index ready before then.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchWorkerClient } from "../src/fork/search/client.js";
import type { StatsResult } from "../src/fork/search/protocol.js";
import { DiskBackendService } from "../src/fork/search/service.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { rebuildKeywordIndex } from "../src/functions/search.js";
import { createSearchRuntime, registerSearchBackend, type SearchRuntime } from "../src/state/search-ports.js";
import { SearchIndex } from "../src/state/search-index.js";
import { mockKV } from "./helpers/mocks.js";
import { QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const stats = (rankingReady: boolean): StatsResult => ({ docs: 1, vectors: 0, memories: 0, lessons: 0, missingVectors: 0, rankingReady });

function serviceWith(statsCalls: () => Promise<StatsResult>): DiskBackendService {
  const client = { stats: statsCalls } as unknown as SearchWorkerClient;
  return new DiskBackendService({ client, health: {}, stats: {}, outbox: {}, reconciler: {}, reembed: {}, withVectors: false } as never);
}

afterEach(() => {
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "memory");
});

describe("waiting for exact ranking", () => {
  it("resolves once the worker reports its ranking statistics ready", async () => {
    const answers = [false, false, true];
    const calls = vi.fn(async () => stats(answers.shift() ?? true));
    await serviceWith(calls).whenRankingReady(5_000, 1);
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it("gives up after its bound, so a worker that never fills cannot hold the boot", async () => {
    const calls = vi.fn(async () => stats(false));
    const started = Date.now();
    await serviceWith(calls).whenRankingReady(50, 5);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls.mock.calls.length).toBeGreaterThan(1);
  });

  it("treats a worker without the field as ready", async () => {
    const calls = vi.fn(async () => ({ docs: 1, vectors: 0, memories: 0, lessons: 0, missingVectors: 0 }) as StatsResult);
    await serviceWith(calls).whenRankingReady(5_000, 1);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("keeps the disk boot's keyword rebuild pending until the worker ranks exactly", async () => {
    let release!: () => void;
    const ranking = new Promise<void>((resolve) => { release = resolve; });
    const keyword = new SearchIndex();
    registerSearchBackend("disk", () => ({
      backend: "disk",
      keyword,
      vector: null,
      openPersistence: () => { throw new Error("unused"); },
      service: {
        start: () => {},
        stop: async () => {},
        status: async () => ({}) as never,
        degradedNotice: () => null,
        whenRankingReady: () => ranking,
      },
    }) as unknown as SearchRuntime);
    createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "disk");
    let done = false;
    const rebuild = rebuildKeywordIndex(mockKV() as never).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).toBe(false);
    release();
    await rebuild;
    expect(done).toBe(true);
  });
});

describe.skipIf(!QDRANT_URL)("the worker reports when it ranks exactly", () => {
  it("is not ready before the corpus statistics fill, and is after", async () => {
    const qdrant = qdrantFor(`ranking_ready_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    try {
      await engine.apply([{ k: "doc", id: "obs_1", sessionId: "s", layer: "observation", ts: 1, rev: "r1" as never, fields: { title: "alpha", narrative: "beta", facts: [], concepts: [], files: [], type: "discovery" } }]);
      expect((await engine.stats()).rankingReady).toBe(false);
      engine.prefixes?.fillInBackground();
      await engine.settled();
      expect((await engine.stats()).rankingReady).toBe(true);
    } finally {
      await qdrant.drop();
    }
  }, 60_000);
});

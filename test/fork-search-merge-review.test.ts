import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";
import { searchBackendProblems, type SearchBackendStatus } from "../src/fork/search/backend-status.js";
import { docOfRecord } from "../src/fork/search/doc-of-record.js";
import { BackendHealth } from "../src/fork/search/health.js";
import { ReembedLoop } from "../src/fork/search/reembed.js";
import { RemoteKeywordIndex } from "../src/fork/search/remote-index.js";
import { createDiskSearchRuntime } from "../src/fork/search/runtime.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

const obs = (id: string, title: string, sessionId: string): CompressedObservation => ({
  id, sessionId, timestamp: "2026-11-19T00:00:00Z", title, narrative: `about ${title}`, type: "discovery", facts: [], concepts: [], files: [], importance: 5,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("merge review (ocr from origin/disk)", () => {
  it("rewrites the doc when the worker stores an older rev than the record, even if this process's ledger already has the new one (#9)", async () => {
    const kv = mockKV();
    const record = obs("obs_1", "edited", "s");
    await kv.set(KV.observations("s"), "obs_1", record);
    const current = docOfRecord("observation", record)!.rev;
    const added: string[] = [];
    const keyword = { prefetch: async () => {}, has: () => true, revOf: () => current, add: (o: CompressedObservation) => added.push(o.id) };
    const loop = new ReembedLoop({
      client: { scanMissingVectors: async () => ({ items: [{ id: "obs_1", sessionId: "s", layer: "observation", rev: "stale-rev" }] }) },
      keyword,
      vector: { has: () => false },
      health: new BackendHealth(),
      perMinute: 6000,
    } as never);
    loop.start({ kv: kv as never, embedBatch: async (jobs) => ({ ok: jobs.length, fail: 0, skipped: 0 }), embeddingEnabled: () => true });
    loop.stop();
    await loop.step();
    expect(added).toEqual(["obs_1"]);
  });

  it("does not promise that reconcile re-derives dropped writes when reconcile is off (#10)", () => {
    const status = {
      backend: "disk", state: "healthy", reason: null, since: new Date(0).toISOString(), documents: 0, vectors: 0,
      pendingWrites: 0, droppedWrites: 3, missingDocuments: null, missing: null, missingVectors: null,
      reconcile: { state: "off", startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null },
      reembed: { state: "off", perMinute: 0, embedded: 0, failed: 0 },
    } as SearchBackendStatus;
    const fix = searchBackendProblems(status).find((p) => p.code === "search-writes-dropped")?.fix;
    expect(fix).not.toContain("No action needed");
    expect(fix).toContain("AM_SEARCH_RECONCILE_INTERVAL_MS");
  });

  it("does not wait on unsendable writes for session counts while the backend is degraded (#12)", async () => {
    const health = new BackendHealth();
    health.reportFailure(new Error("Qdrant unreachable"));
    const drainFor = vi.fn(async () => {});
    const index = new RemoteKeywordIndex({ sessionCounts: async () => [] } as never, { drainFor } as never, {} as never, {} as never, health);
    await index.observationCountsBySession();
    expect(drainFor).not.toHaveBeenCalled();
  });

  it("logs when the lessons collection cannot be reached, as it did before the merge (#6)", async () => {
    const warn = vi.spyOn(logger, "warn");
    const docs = {
      stats: async () => ({ docs: 0, vectors: 0, missingVectors: 0, memories: 0, lessons: 0 }),
      health: async () => ({ ok: true, collection: "c", dimensions: 16, status: "green" }),
    };
    const lessons = { keyword: async () => { throw new Error("lessons worker unreachable"); } };
    const runtime = createDiskSearchRuntime(docs as never, false, 16, { lessons: lessons as never, images: {} as never }, {
      reconcileIntervalMs: 0, sweepPerPass: 0, reembedPerMinute: 0,
    });
    try {
      expect(await runtime.lessons!.search("alpha", 5, "all")).toEqual([]);
      expect(warn.mock.calls.some(([, data]) => JSON.stringify(data ?? {}).includes("lessons worker unreachable"))).toBe(true);
    } finally {
      runtime.stats.stop?.();
      runtime.openPersistence().stop();
    }
  });
});

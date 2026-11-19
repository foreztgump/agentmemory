import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendHealth } from "../src/fork/search/health.js";
import { ReembedLoop } from "../src/fork/search/reembed.js";
import { createSearchRuntime, registerSearchBackend } from "../src/state/search-ports.js";
import { KV } from "../src/state/schema.js";
import { createStatusReporter } from "../src/triggers/api.js";
import { mockKV } from "./helpers/mocks.js";

afterEach(() => {
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "memory");
  vi.useRealTimers();
});

describe("status timeout attribution (#14)", () => {
  it.each(["disk", "memory"] as const)("attributes an unavailable index check to the stalled %s dependency", async (backend) => {
    vi.useFakeTimers();
    const kv = mockKV();
    const runtime = createSearchRuntime({ kv: kv as never, embeddingProvider: null }, "memory");
    if (backend === "disk") {
      registerSearchBackend("disk", () => ({
        ...runtime,
        backend: "disk",
        service: { reconciled: true, status: () => new Promise(() => {}) } as never,
      }));
      createSearchRuntime({ kv: kv as never, embeddingProvider: null }, "disk");
    } else {
      const list = kv.list.bind(kv);
      kv.list = ((scope: string) => scope === KV.sessions ? new Promise(() => {}) : list(scope)) as typeof kv.list;
    }
    const pending = createStatusReporter({ trigger: async () => null } as never, kv as never, {})({ health: null });
    await vi.advanceTimersByTimeAsync(5000);
    const report = await pending;
    const problem = report.problems.find((p) => p.code === "index-check-unavailable");
    expect(report.index.missingObservations).toBeNull();
    if (backend === "disk") {
      expect(problem?.message).toContain("The search backend's status did not answer in time");
      expect(problem?.fix).toContain("check the search backend");
    } else {
      expect(problem?.message).toBe("The session store did not answer in time, so the search index was not checked for missing observations.");
      expect(problem?.fix).toContain("the store is overloaded");
    }
  });
});

it("starts every candidate record read before waiting for any to finish (#16)", async () => {
  const candidates = [
    { id: "obs_1", sessionId: "ses_1", layer: "observation", rev: "r1" },
    { id: "mem_1", sessionId: "ses_2", layer: "memory", rev: "r2" },
  ];
  const reads: Array<[string, string]> = [];
  let releaseReads!: () => void;
  const blocked = new Promise<null>((resolve) => { releaseReads = () => resolve(null); });
  const loop = new ReembedLoop({
    client: { scanMissingVectors: async () => ({ items: candidates }) },
    keyword: { prefetch: async () => {} },
    vector: { has: () => false },
    health: new BackendHealth(),
    perMinute: 120,
  } as never);
  const embedBatch = vi.fn();
  loop.start({
    kv: {
      get: (scope: string, id: string) => {
        reads.push([scope, id]);
        return blocked;
      },
    } as never,
    embedBatch,
    embeddingEnabled: () => true,
  });
  loop.stop();
  const pending = loop.step();
  try {
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(reads).toEqual([[KV.observations("ses_1"), "obs_1"], [KV.memories, "mem_1"]]);
  } finally {
    releaseReads();
    await pending;
  }
  expect(embedBatch).not.toHaveBeenCalled();
});

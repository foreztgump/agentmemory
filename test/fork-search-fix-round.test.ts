import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendHealth } from "../src/fork/search/health.js";
import { ReembedLoop } from "../src/fork/search/reembed.js";
import { Reconciler } from "../src/fork/search/reconcile.js";
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

describe("status in disk mode before a reconcile pass has finished (restart diagnosis)", () => {
  async function diskStatus(reconcileState: "running" | "off") {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", { id: "ses_1", observationCount: 1 });
    await kv.set(KV.observations("ses_1"), "obs_1", { id: "obs_1", sessionId: "ses_1", title: "t", narrative: "n" });
    const listed: string[] = [];
    const list = kv.list.bind(kv);
    kv.list = ((scope: string) => {
      listed.push(scope);
      return list(scope);
    }) as typeof kv.list;
    const runtime = createSearchRuntime({ kv: kv as never, embeddingProvider: null }, "memory");
    const status = {
      backend: "disk", state: "healthy", reason: null, since: new Date(0).toISOString(), documents: 0, vectors: 0,
      pendingWrites: 0, droppedWrites: 0, missingDocuments: null, missing: null, missingVectors: null,
      reconcile: { state: reconcileState, startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null },
      reembed: { state: "off", perMinute: 0, embedded: 0, failed: 0 },
    };
    registerSearchBackend("disk", () => ({
      ...runtime,
      backend: "disk",
      service: { reconciled: false, status: async () => status } as never,
    }));
    createSearchRuntime({ kv: kv as never, embeddingProvider: null }, "disk");
    const report = await createStatusReporter({ trigger: async () => null } as never, kv as never, {})({ health: null });
    return { report, listed };
  }

  it("never lists every session's observations while the first pass fills an empty index", async () => {
    const { report, listed } = await diskStatus("running");
    expect(listed).not.toContain(KV.observations("ses_1"));
    expect(report.index.missingObservations).toBeNull();
    const codes = report.problems.map((p) => p.code);
    expect(codes).not.toContain("index-missing-observations");
    expect(codes).not.toContain("index-check-unavailable");
    expect(codes).toContain("search-reconcile-pending");
  });

  it("gives disk-mode advice, not the memory-mode restart text, when reconcile is off (Found #2)", async () => {
    const { report, listed } = await diskStatus("off");
    expect(listed).not.toContain(KV.observations("ses_1"));
    const codes = report.problems.map((p) => p.code);
    expect(codes).not.toContain("index-missing-observations");
    expect(report.problems.find((p) => p.code === "search-documents-unchecked")?.fix).toContain("AM_SEARCH_RECONCILE_INTERVAL_MS");
  });
});

it("reports the session count while the first pass still runs, not only once it ends (Found #3)", async () => {
  const kv = mockKV();
  await kv.set(KV.sessions, "ses_1", { id: "ses_1" });
  await kv.set(KV.sessions, "ses_2", { id: "ses_2" });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reconciler = new Reconciler({
    client: { sessionCounts: async () => [], stats: async () => { await blocked; return { memories: 0 }; }, scanDocs: async () => ({ items: [] }) },
    keyword: { removedHere: () => false },
    outbox: { drainFor: async () => {}, counters: { spilled: 0 }, pending: 0 },
    health: new BackendHealth(),
    intervalMs: 60_000,
    sweepPerPass: 0,
  } as never);
  reconciler.start(kv as never);
  const pass = reconciler.runPass();
  try {
    await vi.waitFor(() => expect(reconciler.report()).toMatchObject({ state: "running", sessions: 2 }));
  } finally {
    reconciler.stop();
    release();
    await pass;
  }
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

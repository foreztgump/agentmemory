// TEE-1169: reconcile, paced re-embed and the degraded status of the disk search backend.
// Unit cases always run; the Qdrant cases need QDRANT_URL:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-reconcile.test.ts
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { pointId, type Qdrant } from "../src/fork/worker/qdrant.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../src/fork/search/runtime.js";
import type { SearchWorkerClient } from "../src/fork/search/client.js";
import { diffDocs } from "../src/fork/search/reconcile.js";
import { ReembedLoop } from "../src/fork/search/reembed.js";
import { BackendHealth } from "../src/fork/search/health.js";
import { searchBackendProblems, type ServiceHooks } from "../src/fork/search/backend-status.js";
import { contentRev, type ContentRev, type DocStub } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL, loadMaintenanceSettings } from "../src/fork/search/settings.js";
import { docOfRecord } from "../src/fork/search/doc-of-record.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import { KV } from "../src/state/schema.js";
import { setEmbeddingProvider, setVectorIndex, vectorIndexAddBatchGuarded } from "../src/functions/search.js";
import { createSearchRuntime, registerSearchBackend } from "../src/state/search-ports.js";
import type { CompressedObservation, EmbeddingProvider, Memory } from "../src/types.js";
import { DIMS, engineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";
import { mockKV } from "./helpers/mocks.js";

const NO_TIMERS = { reconcileIntervalMs: 0, sweepPerPass: 3, reembedPerMinute: 6000 };

const obs = (id: string, title: string, sessionId: string, narrative = `about ${title}`): CompressedObservation => ({
  id, sessionId, timestamp: "2026-11-19T00:00:00Z", title, narrative, type: "discovery", facts: [], concepts: [], files: [], importance: 5,
});
const memory = (id: string, title: string, isLatest = true): Memory => ({
  id, title, content: `content of ${title}`, type: "fact", concepts: [], files: [], sessionIds: ["ses_m"], createdAt: "2026-11-19T00:00:00Z",
  updatedAt: "2026-11-19T00:00:00Z", strength: 1, version: 1, isLatest,
} as unknown as Memory);
const stub = (id: string, rev: string): DocStub => ({ id, sessionId: "s", layer: "observation", rev: rev as ContentRev });

describe("diffDocs", () => {
  it("separates missing, stale and leaked docs", () => {
    const wanted = new Map<string, ContentRev>([["a", "r1" as ContentRev], ["b", "r2" as ContentRev], ["c", "r3" as ContentRev]]);
    expect(diffDocs(wanted, [stub("a", "r1"), stub("b", "old"), stub("x", "r9")])).toEqual({ missing: ["c"], stale: ["b"], leaked: ["x"] });
  });
});

describe("BackendHealth", () => {
  it("fires onRecover once on the healthy edge and opens one request per retry window while degraded", () => {
    const health = new BackendHealth();
    let recovered = 0;
    health.onRecover(() => recovered++);
    health.reportOk();
    expect(recovered).toBe(0);
    health.reportFailure(new Error("down"));
    expect(health.current).toMatchObject({ ok: false, reason: "down" });
    expect(health.allowRequest(10_000)).toBe(true);
    expect(health.allowRequest(11_000)).toBe(false);
    expect(health.allowRequest(15_001)).toBe(true);
    health.reportOk();
    health.reportOk();
    expect(recovered).toBe(1);
    expect(health.allowRequest()).toBe(true);
  });

  it("counts a probe that does not answer in time as a failure", async () => {
    const health = new BackendHealth();
    const state = await health.probe({ health: () => new Promise(() => {}) }, 20);
    expect(state).toMatchObject({ ok: false });
  });
});

describe("maintenance settings", () => {
  it("defaults to a 60 s reconcile and 120 embeddings a minute, and accepts 0 to turn either off", () => {
    expect(loadMaintenanceSettings({})).toEqual({ reconcileIntervalMs: 60_000, sweepPerPass: 3, reembedPerMinute: 120 });
    expect(loadMaintenanceSettings({ AM_SEARCH_REEMBED_PER_MINUTE: "0", AM_SEARCH_RECONCILE_INTERVAL_MS: "0" })).toMatchObject({ reembedPerMinute: 0, reconcileIntervalMs: 0 });
  });

  it("rejects a negative or fractional value at boot", () => {
    expect(() => loadMaintenanceSettings({ AM_SEARCH_REEMBED_PER_MINUTE: "-1" })).toThrow(/AM_SEARCH_REEMBED_PER_MINUTE/);
    expect(() => loadMaintenanceSettings({ AM_SEARCH_RECONCILE_INTERVAL_MS: "1.5" })).toThrow(/AM_SEARCH_RECONCILE_INTERVAL_MS/);
    expect(() => loadMaintenanceSettings({ AM_SEARCH_REEMBED_PER_MINUTE: "0x10" })).toThrow(/AM_SEARCH_REEMBED_PER_MINUTE/);
  });
});

describe("ReembedLoop pacing without a worker", () => {
  it("waits before the next page when a page has nothing to embed, instead of rescanning at once", async () => {
    const client = { scanMissingVectors: async () => ({ items: [{ id: "obs_gone", sessionId: "s", layer: "observation", rev: "r" }], next: "cursor" }) };
    const keyword = { prefetch: async () => {}, has: () => false, revOf: () => undefined, add: () => {} };
    const vector = { has: () => false };
    const loop = new ReembedLoop({ client, keyword, vector, health: new BackendHealth(), perMinute: 120 } as never);
    loop.start({ kv: mockKV() as never, embedBatch: async () => ({ ok: 0, fail: 0, skipped: 0 }), embeddingEnabled: () => true });
    loop.stop();
    expect(await loop.step()).toBeGreaterThan(0);
  });

  it("reports idle, not running, after a step that failed", async () => {
    const client = { scanMissingVectors: async () => { throw new Error("worker gone"); } };
    const loop = new ReembedLoop({ client, keyword: {}, vector: { has: () => false }, health: new BackendHealth(), perMinute: 120 } as never);
    loop.start({ kv: mockKV() as never, embedBatch: async () => ({ ok: 0, fail: 0, skipped: 0 }), embeddingEnabled: () => true });
    loop.stop();
    await loop.step();
    expect(loop.report().state).toBe("idle");
  });
});

describe("docOfRecord", () => {
  it("indexes what indexRecords indexes: titled observations with a narrative, and latest memories with content", () => {
    expect(docOfRecord("observation", obs("o", "t", "s"))?.rev).toBe(contentRev(termSourceOf(obs("o", "t", "s"))));
    expect(docOfRecord("observation", obs("o", "t", "s", ""))).toBeNull();
    expect(docOfRecord("memory", memory("m", "t"))?.layer).toBe("memory");
    expect(docOfRecord("memory", memory("m", "t", false))).toBeNull();
    expect(docOfRecord("memory", null)).toBeNull();
  });
});

describe("status problems", () => {
  const base = {
    backend: "disk" as const, state: "healthy" as const, reason: null, since: "", documents: 1, vectors: 1, pendingWrites: 0, droppedWrites: 0,
    missingDocuments: 0, missing: { observations: 0, memories: 0 }, missingVectors: 0,
    reconcile: { state: "idle" as const, startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null },
    reembed: { state: "idle" as const, perMinute: 120, embedded: 0, failed: 0 },
  };
  it("reports nothing for a healthy, reconciled backend", () => {
    expect(searchBackendProblems(base)).toEqual([]);
    expect(searchBackendProblems(null)).toEqual([]);
  });
  it("reports a degraded backend as an error and missing documents as a warning", () => {
    expect(searchBackendProblems({ ...base, state: "degraded", reason: "ECONNREFUSED" }).map((p) => [p.code, p.level])).toContainEqual(["search-backend-degraded", "error"]);
    expect(searchBackendProblems({ ...base, missingDocuments: 3 }).map((p) => [p.code, p.level])).toEqual([["search-documents-missing", "warn"]]);
  });
});

// ---------------------------------------------------------------- live Qdrant

const fakeProvider = {
  name: "fake",
  dimensions: DIMS,
  embed: async () => new Float32Array(DIMS).fill(0.5),
  embedBatch: async (texts: string[]) => {
    embedCalls += texts.length;
    return texts.map((_, i) => Float32Array.from({ length: DIMS }, (__, d) => (d === i % DIMS ? 1 : 0.1)));
  },
} as unknown as EmbeddingProvider;
let embedCalls = 0;

interface Rig { q: Qdrant; engine: SearchEngine; runtime: DiskSearchRuntime; kv: ReturnType<typeof mockKV>; down: { value: boolean } }
const rigs: Rig[] = [];

/** A disk runtime on a fresh collection, reachable through a switch that makes every worker call fail. */
async function rig(label: string, withVectors = false): Promise<Rig> {
  const q = qdrantFor(`reconcile_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await q.ensure();
  const engine = new SearchEngine(q, DEFAULT_AVGDL);
  const down = { value: false };
  const live = engineClient(engine);
  const client = Object.fromEntries(
    Object.entries(live).map(([name, fn]) => [
      name,
      (...args: unknown[]) => (down.value ? Promise.reject(new Error("connect ECONNREFUSED qdrant")) : (fn as (...a: unknown[]) => unknown)(...args)),
    ]),
  ) as unknown as SearchWorkerClient;
  const runtime = createDiskSearchRuntime(client, withVectors, DIMS, NO_TIMERS);
  const kv = mockKV();
  const r = { q, engine, runtime, kv, down };
  rigs.push(r);
  return r;
}

const hooks = (r: Rig): ServiceHooks => ({ kv: r.kv as never, embedBatch: vectorIndexAddBatchGuarded, embeddingEnabled: () => r.runtime.vector !== null });

async function putSession(r: Rig, id: string, rows: CompressedObservation[]): Promise<void> {
  await r.kv.set(KV.sessions, id, { id, project: "p", cwd: "/", startedAt: "", status: "active", observationCount: rows.length });
  for (const row of rows) await r.kv.set(KV.observations(id), row.id, row);
}

async function liveIds(r: Rig, sessionId?: string): Promise<string[]> {
  const page = await r.engine.scanDocs(sessionId, undefined, 1000);
  return page.items.map((d) => d.id).sort();
}

afterEach(() => {
  setEmbeddingProvider(null);
  setVectorIndex(null);
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "memory");
});
afterAll(async () => {
  for (const r of rigs) {
    await r.runtime.service.stop();
    r.runtime.stats.stop();
    await r.runtime.outbox.stop(100);
    await r.q.drop();
  }
}, 60_000);

describe.skipIf(!QDRANT_URL)("reconcile on live Qdrant", () => {
  it("indexes every record of an empty index with no manual step, then reports zero missing and changes nothing on a second pass", async () => {
    const r = await rig("fill");
    await putSession(r, "ses_a", [obs("obs_a1", "alpha", "ses_a"), obs("obs_a2", "beta", "ses_a"), obs("obs_a3", "untitled", "ses_a", "")]);
    await putSession(r, "ses_b", [obs("obs_b1", "gamma", "ses_b")]);
    await r.kv.set(KV.memories, "mem_1", memory("mem_1", "delta"));
    r.runtime.service.start(hooks(r));
    expect(r.runtime.reconciler.missing()).toBeNull();

    await r.runtime.reconciler.runPass();
    expect(await liveIds(r, "ses_a")).toEqual(["obs_a1", "obs_a2"]);
    expect(await liveIds(r, "ses_b")).toEqual(["obs_b1"]);
    expect(await liveIds(r)).toEqual(["mem_1"]);
    const status = await r.runtime.service.status();
    expect(status).toMatchObject({ state: "healthy", missingDocuments: 0, reconcile: { state: "idle", added: 4, deleted: 0, error: null } });

    await r.runtime.reconciler.runPass();
    expect(r.runtime.reconciler.report()).toMatchObject({ added: 0, deleted: 0 });
  }, 30_000);

  it("deletes leaked docs, of a gone session and of a deleted record, and leaves a tombstone", async () => {
    const r = await rig("leak");
    await putSession(r, "ses_a", [obs("obs_keep", "keep", "ses_a"), obs("obs_gone", "gone", "ses_a")]);
    await putSession(r, "ses_old", [obs("obs_old", "old", "ses_old")]);
    await r.kv.set(KV.memories, "mem_old", memory("mem_old", "superseded"));
    r.runtime.service.start(hooks(r));
    await r.runtime.reconciler.runPass();
    expect(await liveIds(r, "ses_old")).toEqual(["obs_old"]);

    // The records go away while the deletes never reach the index (a crash or a spill).
    await r.kv.delete(KV.observations("ses_a"), "obs_gone");
    await r.kv.delete(KV.sessions, "ses_old");
    await r.kv.delete(KV.observations("ses_old"), "obs_old");
    // Supersession: a new memory key, and the old one stops being the latest version.
    await r.kv.set(KV.memories, "mem_old", memory("mem_old", "superseded", false));
    await r.kv.set(KV.memories, "mem_new", memory("mem_new", "replacement"));
    await r.runtime.reconciler.runPass();

    expect(await liveIds(r, "ses_a")).toEqual(["obs_keep"]);
    expect(await liveIds(r, "ses_old")).toEqual([]);
    expect(await liveIds(r)).toEqual(["mem_new"]);
    const [point] = await r.q.call<Array<{ payload?: Record<string, unknown> }>>("POST", `${r.q.path}/points`, { ids: [pointId("obs_gone")], with_payload: ["deleted"] });
    expect(point?.payload).toMatchObject({ deleted: true });
    expect(r.runtime.reconciler.report()).toMatchObject({ deleted: 3 });
  }, 30_000);

  it("keeps a doc whose record is written between the index read and the delete", async () => {
    const r = await rig("race");
    await putSession(r, "ses_a", [obs("obs_a1", "alpha", "ses_a")]);
    r.runtime.service.start(hooks(r));
    // Capture's order: the doc is queued first here, the record lands while reconcile compares.
    r.runtime.keyword.add(obs("obs_new", "fresh capture", "ses_a"));
    await r.runtime.outbox.drainFor(5000);
    const list = r.kv.list.bind(r.kv);
    let reads = 0;
    r.kv.list = (async (scope: string) => {
      const rows = await list(scope);
      // The first read is the row count; the second is the doc-by-doc compare, which must not see the record.
      if (scope === KV.observations("ses_a") && ++reads === 2) await r.kv.set(KV.observations("ses_a"), "obs_new", obs("obs_new", "fresh capture", "ses_a"));
      return rows;
    }) as typeof r.kv.list;
    await r.runtime.reconciler.runPass();
    expect(await liveIds(r, "ses_a")).toEqual(["obs_a1", "obs_new"]);
  }, 30_000);

  it("rewrites a doc whose indexed content is older than its record", async () => {
    const r = await rig("stale");
    r.runtime.keyword.add(obs("obs_s", "first draft", "ses_a"));
    await r.runtime.outbox.drainFor(5000);
    await putSession(r, "ses_a", [obs("obs_s", "final wording", "ses_a")]);
    r.runtime.service.start(hooks(r));
    await r.runtime.reconciler.runPass();
    const hits = await r.engine.keyword("wording", 10, "all");
    expect(hits.map((h) => h.id)).toEqual(["obs_s"]);
  }, 30_000);

  it("repairs writes the outbox dropped while the worker was unreachable once it is back", async () => {
    const r = await rig("spill");
    await putSession(r, "ses_a", []);
    r.runtime.service.start(hooks(r));
    await r.runtime.reconciler.runPass();
    r.down.value = true;
    // A process that dies with writes queued loses them the same way.
    for (let i = 0; i < 20; i++) {
      const row = obs(`obs_${i}`, `topic${i}`, "ses_a");
      await r.kv.set(KV.observations("ses_a"), row.id, row);
      r.runtime.keyword.add(row);
    }
    await r.runtime.keyword.search("topic1");
    (r.runtime.outbox as unknown as { slots: Map<string, unknown> }).slots.clear();
    r.down.value = false;
    const status = await r.runtime.service.status();
    expect(status.state).toBe("healthy");
    await r.runtime.reconciler.runPass();
    expect((await liveIds(r, "ses_a")).length).toBe(20);
    expect((await r.runtime.service.status()).missingDocuments).toBe(0);
  }, 30_000);
});

describe.skipIf(!QDRANT_URL)("paced re-embed on live Qdrant", () => {
  it("embeds each doc without a vector once, stores it, and never embeds a present vector again", async () => {
    const r = await rig("reembed", true);
    registerSearchBackend("disk", () => r.runtime);
    createSearchRuntime({ kv: r.kv as never, embeddingProvider: fakeProvider }, "disk");
    setVectorIndex(r.runtime.vector);
    setEmbeddingProvider(fakeProvider);
    await putSession(r, "ses_a", [obs("obs_1", "one", "ses_a"), obs("obs_2", "two", "ses_a")]);
    await r.kv.set(KV.memories, "mem_1", memory("mem_1", "three"));
    r.runtime.service.start(hooks(r));
    await r.runtime.reconciler.runPass();
    expect((await r.engine.stats()).missingVectors).toBe(3);

    // A restart: this process has never seen these docs, so the ledger has no rev for them.
    embedCalls = 0;
    await r.runtime.reembed.step();
    await r.runtime.outbox.drainFor(5000);
    expect(embedCalls).toBe(3);
    const after = await r.engine.stats();
    expect(after).toMatchObject({ vectors: 3, missingVectors: 0 });
    expect(r.runtime.vector!.unfenced).toBe(0);

    await r.runtime.reembed.step();
    expect(embedCalls).toBe(3);
    expect(r.runtime.reembed.report()).toMatchObject({ embedded: 3, failed: 0 });
  }, 30_000);

  it("waits between batches so the rate stays at perMinute", async () => {
    const r = await rig("pace", true);
    const runtime = createDiskSearchRuntime(engineClient(r.engine), true, DIMS, { ...NO_TIMERS, reembedPerMinute: 60 });
    rigs.push({ ...r, runtime });
    registerSearchBackend("disk", () => runtime);
    createSearchRuntime({ kv: r.kv as never, embeddingProvider: fakeProvider }, "disk");
    setVectorIndex(runtime.vector);
    setEmbeddingProvider(fakeProvider);
    const rows = Array.from({ length: 5 }, (_, i) => obs(`obs_${i}`, `t${i}`, "ses_a"));
    for (const row of rows) runtime.keyword.add(row);
    await runtime.outbox.drainFor(5000);
    await putSession(r, "ses_a", rows);
    runtime.service.start({ ...hooks(r), embeddingEnabled: () => true });
    const delay = await runtime.reembed.step();
    // 5 embeddings at 60 a minute need 5 s before the next batch.
    expect(delay).toBeGreaterThan(4000);
    expect(delay).toBeLessThanOrEqual(5000);
  }, 30_000);

  it("does nothing with re-embedding off or no embedding provider", async () => {
    const r = await rig("off", false);
    r.runtime.keyword.add(obs("obs_1", "one", "ses_a"));
    await r.runtime.outbox.drainFor(5000);
    r.runtime.service.start(hooks(r));
    embedCalls = 0;
    await r.runtime.reembed.step();
    expect(embedCalls).toBe(0);
    expect(r.runtime.reembed.report().state).toBe("no-embedding-provider");
    expect((await r.runtime.service.status()).missingVectors).toBeNull();
  }, 30_000);
});

describe.skipIf(!QDRANT_URL)("degraded backend on live Qdrant", () => {
  it("reports degraded while the worker cannot reach Qdrant, answers searches with nothing instead of an error, and recovers on its own", async () => {
    const r = await rig("degraded", true);
    r.runtime.keyword.add(obs("obs_1", "searchable", "ses_a"));
    await r.runtime.outbox.drainFor(5000);
    r.runtime.service.start(hooks(r));
    expect((await r.runtime.service.status()).state).toBe("healthy");
    expect(r.runtime.service.degradedNotice()).toBeNull();

    r.down.value = true;
    const status = await r.runtime.service.status();
    expect(status).toMatchObject({ state: "degraded", reason: expect.stringContaining("ECONNREFUSED") });
    expect(await r.runtime.keyword.search("searchable")).toEqual([]);
    await expect(r.runtime.keyword.search("searchable", 10, "all", { strict: true })).rejects.toThrow();
    expect(r.runtime.service.degradedNotice()).toMatchObject({ backend: "disk", legs: ["keyword", "vector"] });

    // A search while degraded fails fast instead of waiting for the read-your-writes drain.
    r.runtime.keyword.add(obs("obs_2", "queued", "ses_a"));
    const started = Date.now();
    await r.runtime.keyword.search("queued");
    expect(Date.now() - started).toBeLessThan(500);

    r.down.value = false;
    r.runtime.health.reportOk();
    expect((await r.runtime.service.status()).state).toBe("healthy");
    expect((await r.runtime.keyword.search("searchable")).map((h) => h.obsId)).toEqual(["obs_1"]);
  }, 30_000);

  it("reports degraded when the worker answers but Qdrant is unreachable", async () => {
    const q = qdrantFor(`reconcile_noqdrant_${process.pid}`);
    const unreachable = new (q.constructor as new (c: unknown) => Qdrant)({ ...q.config, url: "http://127.0.0.1:1" });
    const engine = new SearchEngine(unreachable, DEFAULT_AVGDL);
    const runtime = createDiskSearchRuntime(engineClient(engine), false, DIMS, NO_TIMERS);
    const status = await runtime.service.status();
    runtime.stats.stop();
    await runtime.outbox.stop(10);
    expect(status.state).toBe("degraded");
    expect(status.reason).toMatch(/Qdrant unreachable|fetch failed/);
  }, 30_000);
});

// ---------------------------------------------------------------- fix round 2026-11-19 (ocr triage)

describe("fix round: status text and re-embed cooldown", () => {
  const base = {
    backend: "disk" as const, state: "healthy" as const, reason: null, since: "", documents: 1, vectors: 1, pendingWrites: 0, droppedWrites: 0,
    missingDocuments: 3, missing: { observations: 3, memories: 0 }, missingVectors: 0,
    reconcile: { state: "off" as const, startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null },
    reembed: { state: "idle" as const, perMinute: 120, embedded: 0, failed: 0 },
  };

  it("does not promise a background reconcile for missing documents when reconcile is off (#7)", () => {
    const problem = searchBackendProblems(base).find((p) => p.code === "search-documents-missing");
    expect(problem?.fix).not.toMatch(/reconcile adds them/);
    expect(problem?.fix).toMatch(/AM_SEARCH_RECONCILE_INTERVAL_MS/);
  });

  it("cools down a record whose vector did not land even when the rest of its batch succeeded (#9)", async () => {
    const kv = mockKV();
    await kv.set(KV.observations("s"), "obs_good", obs("obs_good", "good", "s"));
    await kv.set(KV.observations("s"), "obs_bad", obs("obs_bad", "bad", "s"));
    const landed = new Set<string>();
    const client = {
      scanMissingVectors: async () => ({
        items: ["obs_good", "obs_bad"].filter((id) => !landed.has(id)).map((id) => ({ id, sessionId: "s", layer: "observation", rev: "r" })),
        next: undefined,
      }),
    };
    const keyword = { prefetch: async () => {}, has: () => true, revOf: (id: string) => docOfRecord("observation", obs(id, id.slice(4), "s"))!.rev, add: () => {} };
    const vector = { has: (id: string) => landed.has(id) };
    const batches: string[][] = [];
    const loop = new ReembedLoop({ client, keyword, vector, health: new BackendHealth(), perMinute: 6000 } as never);
    loop.start({
      kv: kv as never,
      embedBatch: async (jobs) => {
        batches.push(jobs.map((j) => j.id));
        for (const job of jobs) if (job.id !== "obs_bad") landed.add(job.id);
        const ok = jobs.filter((j) => j.id !== "obs_bad").length;
        return { ok, fail: jobs.length - ok, skipped: 0 };
      },
      embeddingEnabled: () => true,
    });
    loop.stop();
    await loop.step();
    await loop.step();
    expect(batches).toEqual([["obs_good", "obs_bad"]]);
  });
});

describe("fix round: smart-search degraded notice", () => {
  it("attaches the degraded notice to the expanded shape as well as the compact one (#17)", async () => {
    const { registerSmartSearchFunction } = await import("../src/functions/smart-search.js");
    const notice = { backend: "disk" as const, legs: ["keyword" as const], reason: "Qdrant unreachable" };
    registerSearchBackend("disk", () => ({
      backend: "disk", keyword: {} as never, vector: null, openPersistence: () => { throw new Error("none"); },
      service: { degradedNotice: () => notice } as never,
    }));
    createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "disk");
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", { id: "ses_1", project: "p", cwd: "/", startedAt: "", status: "active", observationCount: 1 });
    await kv.set(KV.observations("ses_1"), "obs_1", obs("obs_1", "alpha", "ses_1"));
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const sdk = { registerFunction: (id: string, fn: (p: unknown) => Promise<unknown>) => handlers.set(id, fn), registerTrigger: () => {}, trigger: async () => null };
    registerSmartSearchFunction(sdk as never, kv as never, async () => []);
    const compact = await handlers.get("mem::smart-search")!({ query: "alpha" });
    const expanded = await handlers.get("mem::smart-search")!({ expandIds: ["obs_1"] });
    expect(compact).toMatchObject({ mode: "compact", degraded: notice });
    expect(expanded).toMatchObject({ mode: "expanded", degraded: notice });
  });
});

describe.skipIf(!QDRANT_URL)("fix round on live Qdrant", () => {
  it("does not bring back an observation deleted during the pass after the delete ledger forgot it (#15)", async () => {
    const r = await rig("evicted");
    await putSession(r, "ses_a", [obs("obs_keep", "keep", "ses_a"), obs("obs_del", "deleted mid pass", "ses_a")]);
    r.runtime.service.start(hooks(r));
    const list = r.kv.list.bind(r.kv);
    let reads = 0;
    r.kv.list = (async (scope: string) => {
      const rows = await list(scope);
      // The doc-by-doc compare reads the record; the delete lands right after, and its ledger entry is already evicted.
      if (scope === KV.observations("ses_a") && ++reads === 2) await r.kv.delete(KV.observations("ses_a"), "obs_del");
      return rows;
    }) as typeof r.kv.list;
    await r.runtime.reconciler.runPass();
    await r.runtime.outbox.drainFor(5000);
    expect(r.runtime.keyword.removedHere("obs_del")).toBe(false);
    expect(await liveIds(r, "ses_a")).toEqual(["obs_keep"]);
  }, 30_000);

  it("keeps the status page's session count once reconcile has run in disk mode (#13)", async () => {
    const { createStatusReporter } = await import("../src/triggers/api.js");
    const r = await rig("sessions");
    await putSession(r, "ses_a", [obs("obs_a1", "alpha", "ses_a")]);
    await putSession(r, "ses_b", [obs("obs_b1", "beta", "ses_b")]);
    registerSearchBackend("disk", () => r.runtime);
    createSearchRuntime({ kv: r.kv as never, embeddingProvider: null }, "disk");
    r.runtime.service.start(hooks(r));
    await r.runtime.reconciler.runPass();
    expect(r.runtime.reconciler.missing()).not.toBeNull();
    const report = await createStatusReporter({ trigger: async () => null } as never, r.kv as never, {})({ health: null });
    expect(report.index.sessions).toBe(2);
    expect(report.index.missingObservations).toBe(0);
  }, 30_000);
});

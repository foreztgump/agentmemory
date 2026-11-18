// Regression tests that pin the verified findings of the TEE-1164 adversarial
// review of the am-search worker. Each case asserts the behavior the worker
// must have, so each fails until its finding is fixed. Cases that need Qdrant
// skip unless QDRANT_URL is set:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-findings.test.ts
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../src/fork/search/runtime.js";
import { SearchOutbox } from "../src/fork/search/outbox.js";
import type { SearchWorkerClient } from "../src/fork/search/client.js";
import type { Qdrant } from "../src/fork/worker/qdrant.js";
import { contentRev, type DocOp, type Op } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL, loadSearchWorkerSettings } from "../src/fork/search/settings.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import { DIMS, engineClient, qdrantFor } from "./helpers/search-engine.js";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";
import { createSearchRuntime, getSearchRuntime, registerSearchBackend } from "../src/state/search-ports.js";
import {
  getSearchIndex,
  rebuildKeywordIndex,
  registerSearchFunction,
  setEmbeddingProvider,
  setHybridRanker,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { registerApiTriggers, createStatusReporter } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { VERSION } from "../src/version.js";
import { KV } from "../src/state/schema.js";
import { termSourceOf } from "../src/state/term-extraction.js";

const live = !!process.env.QDRANT_URL;

const obs = (id: string, title: string, narrative = "", sessionId = "ses_adv"): CompressedObservation => ({
  id, sessionId, timestamp: "2026-11-18T00:00:00Z", title, narrative, type: "discovery", facts: [], concepts: [], files: [], importance: 5,
});
const docOp = (id: string, title: string): DocOp => {
  const record = obs(id, title);
  const fields = termSourceOf(record);
  return { k: "doc", id, sessionId: record.sessionId, ts: 1, layer: "observation", fields, rev: contentRev(fields) };
};
const embedding = Float32Array.from({ length: DIMS }, (_, i) => Math.sin(i + 1));
const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);

interface Rig {
  q: Qdrant;
  engine: SearchEngine;
  runtime?: DiskSearchRuntime;
}
const rigs: Rig[] = [];
async function rig(label: string): Promise<Rig> {
  const q = qdrantFor(`findings_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await q.ensure();
  const state: Rig = { q, engine: new SearchEngine(q, DEFAULT_AVGDL) };
  rigs.push(state);
  return state;
}

function resetGlobals(): void {
  setEmbeddingProvider(null);
  setVectorIndex(null);
  setHybridRanker(null);
  setIndexPersistence(null);
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "memory");
}
afterEach(resetGlobals);
afterAll(async () => {
  for (const r of rigs) {
    r.runtime?.stats.stop();
    await r.runtime?.outbox.stop(10_000);
    await r.q.drop();
  }
}, 60_000);

interface Gate {
  reached: Promise<void>;
  release: () => void;
  open: Promise<void>;
  signal: () => void;
}
function gate(): Gate {
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  const open = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, open, signal };
}

/** An invocation timeout that does not cancel the remote handler, as the iii SDK behaves. */
function timeOutFirstApply(r: Rig, client: SearchWorkerClient) {
  const state = { late: undefined as ReturnType<SearchWorkerClient["apply"]> | undefined, expire: () => {} };
  let first = true;
  const expired = new Promise<never>((_resolve, reject) => {
    state.expire = () => reject(new Error("invocation timed out after 60000ms"));
  });
  expired.catch(() => {});
  client.apply = (ops) => {
    const operation = r.engine.apply(ops);
    if (!first) return operation;
    first = false;
    state.late = operation;
    return Promise.race([operation, expired]);
  };
  return state;
}

describe.skipIf(!live)("finding 1: a timed-out write must not resurrect stale state", () => {
  it("rejects a stale vector when an update lands after the revision lookup", async () => {
    const r = await rig("fence_race");
    const old = docOp("obs_fence", "old version");
    const updated = docOp("obs_fence", "new version");
    await r.engine.apply([old]);
    const originalCall = r.q.call.bind(r.q);
    const lookup = gate();
    r.q.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const result = await originalCall<T>(method, path, body);
      if (method === "POST" && path === r.q.path + "/points") { lookup.signal(); await lookup.open; }
      return result;
    };
    const pending = r.engine.apply([{ k: "vec", id: old.id, rev: old.rev, f32b64: float32ToBase64(embedding) }]);
    await lookup.reached;
    await r.engine.apply([updated]);
    lookup.release();
    const result = await pending;
    const hits = await r.engine.vector(float32ToBase64(embedding), 10, "all", 6);
    expect(result.fenced).toEqual([old.id]);
    expect(ids(hits)).toEqual([]);
  });

  it("rejects a timed-out vector invocation after the outbox retries a newer document", async () => {
    const r = await rig("retry_fence");
    const client = engineClient(r.engine);
    const runtime = (r.runtime = createDiskSearchRuntime(client, true, DIMS));
    await runtime.stats.refresh();
    runtime.keyword.add(obs("obs_retry", "old version"));
    await runtime.outbox.drainFor(10_000);
    const originalCall = r.q.call.bind(r.q);
    const lookup = gate();
    let blocked = false;
    r.q.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const result = await originalCall<T>(method, path, body);
      if (!blocked && method === "POST" && path === r.q.path + "/points") { blocked = true; lookup.signal(); await lookup.open; }
      return result;
    };
    const timeout = timeOutFirstApply(r, client);
    runtime.vector!.add("obs_retry", "ses_adv", embedding);
    const drain = runtime.outbox.drainFor(10_000);
    await lookup.reached;
    runtime.keyword.add(obs("obs_retry", "new version"));
    timeout.expire();
    await drain;
    lookup.release();
    await timeout.late;
    const hits = await runtime.vector!.search(embedding);
    expect(hits).toEqual([]);
  }, 20_000);

  it("does not resurrect a deleted memory when a timed-out document write completes late", async () => {
    const r = await rig("retry_delete");
    const client = engineClient(r.engine);
    const runtime = (r.runtime = createDiskSearchRuntime(client, true, DIMS));
    await runtime.stats.refresh();
    const originalCall = r.q.call.bind(r.q);
    const write = gate();
    let blocked = false;
    r.q.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (!blocked && method === "POST" && path === r.q.path + "/points/batch?wait=true") { blocked = true; write.signal(); await write.open; }
      return originalCall<T>(method, path, body);
    };
    const timeout = timeOutFirstApply(r, client);
    runtime.keyword.add(obs("mem_deleted", "deletedzombie"), "memory");
    runtime.vector!.add("mem_deleted", "ses_adv", embedding);
    const drain = runtime.outbox.drainFor(10_000);
    await write.reached;
    runtime.keyword.remove("mem_deleted");
    runtime.vector!.remove("mem_deleted");
    timeout.expire();
    await drain;
    write.release();
    await timeout.late;
    const keywordHits = await runtime.keyword.search("deletedzombie");
    const vectorHits = await runtime.vector!.search(embedding);
    expect(keywordHits.map((h) => h.obsId)).toEqual([]);
    expect(vectorHits.map((h) => h.obsId)).toEqual([]);
  }, 20_000);
});

describe("finding 2: the outbox must not spill when the worker is healthy", () => {
  it.skipIf(!live)("indexes and finds all 5,001 observations of a mem::import", async () => {
    const r = await rig("healthy_burst");
    const runtime = (r.runtime = createDiskSearchRuntime(engineClient(r.engine), false));
    registerSearchBackend("disk", () => runtime);
    createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "disk");
    setEmbeddingProvider(null);
    setVectorIndex(null);
    await runtime.stats.refresh();
    const records = Array.from({ length: 5001 }, (_, i) => obs("obs_burst_" + i, "zeppelinfresh", "narrative", i < 5000 ? "ses_one" : "ses_two"));
    const kv = mockKV();
    const sdk = mockSdk();
    registerExportImportFunction(sdk as never, kv as never);
    const session = (id: string, observationCount: number) => ({ id, project: "adversarial", cwd: "/tmp", startedAt: "2026-11-18T00:00:00Z", status: "completed", observationCount });
    const result = (await sdk.trigger({
      function_id: "mem::import",
      payload: {
        exportData: {
          version: VERSION,
          exportedAt: "2026-11-18T00:00:00Z",
          sessions: [session("ses_one", 5000), session("ses_two", 1)],
          memories: [],
          summaries: [],
          observations: { ses_one: records.slice(0, 5000), ses_two: records.slice(5000) },
        },
      },
    })) as { success: boolean; observations: number };
    expect(result.success).toBe(true);
    expect(result.observations).toBe(5001);
    await runtime.outbox.drainFor(60_000);
    const stats = await r.engine.stats();
    const hits = await runtime.keyword.search("zeppelinfresh", 10);
    expect(stats.docs).toBe(5001);
    expect(hits).toHaveLength(10);
  }, 90_000);

  it("delivers a capture enqueued while 5,000 bulk writes are pending", async () => {
    const delivered: string[] = [];
    const client = {
      apply: async (ops: Op[]) => {
        for (const op of ops) delivered.push(op.id);
        return { applied: ops.length, fenced: [], failed: [] };
      },
      clear: async () => {},
    } as unknown as SearchWorkerClient;
    const outbox = new SearchOutbox(client, { maxOps: 5000, maxBytes: 64 * 1024 * 1024, flushMs: 250, batch: 256 });
    const fields = (title: string) => ({ title, narrative: title, facts: [], concepts: [], files: [], type: "discovery" as const });
    const doc = (id: string): Op => ({ k: "doc", id, sessionId: "ses_1", layer: "observation", ts: 1, rev: contentRev(fields(id)), fields: fields(id) });
    for (let i = 0; i < 5000; i++) outbox.put(doc(`obs_bulk_${i}`));
    outbox.put(doc("obs_capture"));
    await outbox.drainFor(10_000);
    await outbox.stop(1000);
    expect(delivered).toContain("obs_capture");
    expect(outbox.counters.spilled).toBe(0);
  }, 20_000);
});

describe.skipIf(!live)("finding 3: a late stats poll must not hide new vectors", () => {
  it("keeps newly written vectors visible to hybrid search when a stats poll completes late", async () => {
    const r = await rig("stats_race");
    const client = engineClient(r.engine);
    const readStats = client.stats;
    const poll = gate();
    client.stats = async () => {
      const snapshot = await readStats();
      poll.signal();
      await poll.open;
      return snapshot;
    };
    const runtime = (r.runtime = createDiskSearchRuntime(client, true, DIMS));
    await poll.reached;
    const o = obs("obs_stats", "unrelated lexical text");
    runtime.keyword.add(o);
    runtime.vector!.add(o.id, o.sessionId, embedding);
    await runtime.outbox.drainFor(10_000);
    poll.release();
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const provider = { name: "probe", dimensions: DIMS, embed: async () => embedding } as EmbeddingProvider;
    const kv = { get: async (_scope: string, id: string) => (id === o.id ? o : null) };
    const hybrid = new HybridSearch(runtime.keyword, runtime.vector, provider, kv as never, 0.4, 0.6, 0);
    const hybridHits = await hybrid.search("semantic-only-query", 10);
    expect(hybridHits.map((h) => h.observation.id)).toEqual([o.id]);
  }, 20_000);
});

describe.skipIf(!live)("finding 4: keyword ranking tracks the in-memory index", () => {
  it("keeps top-10 overlap with the in-memory index at or above 0.90 on an exact-term corpus", async () => {
    const r = await rig("bm25");
    const runtime = (r.runtime = createDiskSearchRuntime(engineClient(r.engine), false));
    const memory = new SearchIndex();
    const add = (o: CompressedObservation) => { memory.add(o); runtime.keyword.add(o); };
    for (let i = 0; i < 1000; i++) add(obs("obs_filler_" + i, "filler"));
    for (let q = 0; q < 20; q++) {
      const word = "quartzmarker" + q;
      for (let i = 0; i < 10; i++) add(obs(`obs_short_${q}_${i}`, word));
      for (let i = 0; i < 10; i++) add(obs(`obs_long_${q}_${i}`, Array(5).fill(word).join(" "), Array(14).fill("padding").join(" ")));
    }
    await runtime.outbox.drainFor(30_000);
    let overlap = 0;
    for (let q = 0; q < 20; q++) {
      const word = "quartzmarker" + q;
      const want = memory.search(word, 10).map((h) => h.obsId);
      const got = (await runtime.keyword.search(word, 10)).map((h) => h.obsId);
      overlap += got.filter((id) => want.includes(id)).length / want.length;
    }
    expect(overlap / 20).toBeGreaterThanOrEqual(0.9);
  }, 60_000);
});

/** One durable KV shared by the "processes" of a restart test. */
function sharedKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async (scope: string, key: string) => store.get(scope)?.get(key) ?? null,
    set: async (scope: string, key: string, data: unknown) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => { store.get(scope)?.delete(key); },
    list: async <T>(scope: string) => [...(store.get(scope)?.values() ?? [])] as T[],
    listGroups: async () => [],
    update: async () => {},
    backend: "file",
  };
}

function routingSdk() {
  const handlers = new Map<string, (payload: never) => unknown>();
  return {
    handlers,
    registerFunction: (id: string, fn: (payload: never) => unknown) => handlers.set(id, fn),
    registerTrigger: () => {},
    trigger: async ({ function_id, payload }: { function_id: string; payload: never }) => {
      if (function_id === "mem::lesson-recall") return { success: true, lessons: [] };
      if (function_id === "mem::graph-stats") return null;
      const fn = handlers.get(function_id);
      if (!fn) throw new Error(`No function: ${function_id}`);
      return fn(payload);
    },
  };
}

const fakeProvider = {
  name: "fake",
  dimensions: DIMS,
  embed: async () => new Float32Array(DIMS).fill(0.25),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.25)),
} as EmbeddingProvider;

/** Boots a disk runtime on an existing collection with an empty ledger, as a process start does. */
function startDisk(q: Qdrant, kv: ReturnType<typeof sharedKV>) {
  const engine = new SearchEngine(q, DEFAULT_AVGDL);
  const runtime = createDiskSearchRuntime(engineClient(engine), true, DIMS);
  registerSearchBackend("disk", () => runtime);
  createSearchRuntime({ kv: kv as never, embeddingProvider: fakeProvider }, "disk");
  setVectorIndex(runtime.vector);
  setEmbeddingProvider(fakeProvider);
  setIndexPersistence({ scheduleSave: () => {}, save: async () => {} } as never);
  return { runtime, engine };
}

describe.skipIf(!live)("finding 5: disk mode after a process restart", () => {
  it("reports no missing observations for the ones mem::search returns", async () => {
    const r = await rig("restart_status");
    const kv = sharedKV();
    const rows = Array.from({ length: 5 }, (_, i) => obs(`obs_ok_${i}`, `subject ${i}`, i === 4 ? "" : `narrative ${i}`, "ses_import"));
    const exportData = {
      version: VERSION,
      exportedAt: "2026-11-01T00:00:00.000Z",
      sessions: [{ id: "ses_import", project: "p", cwd: "/tmp", startedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", status: "completed", observationCount: 5 }],
      memories: [], summaries: [], observations: { ses_import: rows }, graphNodes: [], graphEdges: [], actions: [], accessLogs: [],
    };

    const first = startDisk(r.q, kv);
    const importSdk = routingSdk();
    registerExportImportFunction(importSdk as never, kv as never);
    const imported = (await importSdk.handlers.get("mem::import")!({ exportData, strategy: "merge" } as never)) as { success: boolean };
    expect(imported.success).toBe(true);
    await first.runtime.outbox.drainFor(20_000);
    first.runtime.stats.stop();
    await first.runtime.outbox.stop(1000);

    const second = startDisk(r.q, kv);
    r.runtime = second.runtime;
    await second.runtime.stats.refresh();
    const hybrid = new HybridSearch(getSearchIndex(), getSearchRuntime().vector, fakeProvider, kv as never, 0.4, 0.6, 0);
    setHybridRanker((q, l, layer, auth, req) => hybrid.search(q, l, layer, auth, req));
    const sdk = routingSdk();
    registerSearchFunction(sdk as never, kv as never);
    const search = (await sdk.handlers.get("mem::search")!({ query: "subject", limit: 10 } as never)) as { results: Array<{ observation: { id: string } }> };
    expect(search.results.map((x) => x.observation.id).sort()).toEqual(["obs_ok_0", "obs_ok_1", "obs_ok_2", "obs_ok_3"]);
    const report = await createStatusReporter(sdk as never, kv as never, {})({ health: null });
    expect(report.index.missingObservations).toBe(0);
  }, 60_000);

  it("locates observations in their sessions as the memory backend does", async () => {
    process.env.AGENTMEMORY_ALLOW_ANY_HOST = "1";
    const r = await rig("restart_locate");
    const kv = sharedKV();
    const rows = [
      obs("obs_alpha", "kubernetes ingress timeout", "the ingress controller dropped requests", "ses_1"),
      obs("obs_beta", "postgres vacuum stalled", "autovacuum blocked", "ses_1"),
    ];
    for (const row of rows) await kv.set(KV.observations("ses_1"), row.id, row);
    await kv.set(KV.sessions, "ses_1", { id: "ses_1", project: "p", cwd: "/tmp", startedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", status: "completed", observationCount: rows.length });

    const first = startDisk(r.q, kv);
    for (const row of rows) first.runtime.keyword.add(row);
    await first.runtime.outbox.drainFor(10_000);
    first.runtime.stats.stop();
    await first.runtime.outbox.stop(1000);

    const second = startDisk(r.q, kv);
    r.runtime = second.runtime;
    await second.runtime.stats.refresh();
    const found = await second.runtime.keyword.search("kubernetes", 5);
    expect(found.map((h) => h.obsId)).toEqual(["obs_alpha"]);

    const sdk = routingSdk();
    registerApiTriggers(sdk as never, kv as never);
    const locate = async () => {
      const response = (await sdk.handlers.get("api::observations-locate")!({
        method: "GET",
        headers: { "content-type": "application/json" },
        query_params: { ids: "obs_alpha,obs_beta" },
      } as never)) as { body: { sessions: Record<string, string> } };
      return response.body.sessions;
    };
    const disk = await locate();

    createSearchRuntime({ kv: kv as never, embeddingProvider: null }, "memory");
    setVectorIndex(null);
    setEmbeddingProvider(null);
    await rebuildKeywordIndex(kv as never);
    const memory = await locate();

    expect(memory).toEqual({ obs_alpha: "ses_1", obs_beta: "ses_1" });
    expect(disk).toEqual(memory);
  }, 60_000);
});

describe("finding 6: settings validation", () => {
  it("rejects AM_SEARCH_OVERSAMPLING below 1", () => {
    const parse = (raw: string) => () => loadSearchWorkerSettings({ AM_QDRANT_URL: "http://127.0.0.1:1", AM_SEARCH_OVERSAMPLING: raw });
    expect(parse("6")).not.toThrow();
    expect(parse("0.5")).toThrow(/AM_SEARCH_OVERSAMPLING/);
  });
});

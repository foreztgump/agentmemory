import { describe, expect, it, vi } from "vitest";
import { iiiSearchClient, type SearchWorkerClient } from "../../../src/fork/search/client.js";
import { BackendHealth } from "../../../src/fork/search/health.js";
import { DocLedger, SearchOutbox } from "../../../src/fork/search/outbox.js";
import { SEARCH_FN } from "../../../src/fork/search/protocol.js";
import { RemoteVectorStore, READ_VECTORS_BATCH, StatsCache } from "../../../src/fork/search/remote-index.js";
import { activeVectorReader, vectorReaderFor } from "../../../src/fork/retention/vectors.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { pointId } from "../../../src/fork/worker/qdrant.js";
import { createSearchHandlers, type WorkerEngines } from "../../../src/fork/worker/router.js";
import type { VectorStorePort } from "../../../src/state/search-ports.js";
import { base64ToFloat32, float32ToBase64, VectorIndex } from "../../../src/state/vector-index.js";

const DIMS = 8;
const embedding = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed * 3 + i));

describe("memory mode", () => {
  it("returns the stored vector itself and leaves out an id with none", () => {
    const index = new VectorIndex();
    index.add("obs_1", "ses_1", embedding(1));
    const read = index.readVectors(["obs_1", "obs_missing"]);
    expect([...read.keys()]).toEqual(["obs_1"]);
    expect(read.get("obs_1")).toEqual(embedding(1));
  });

  it("stops returning a vector once it is removed", () => {
    const index = new VectorIndex();
    index.add("obs_1", "ses_1", embedding(1));
    index.remove("obs_1");
    expect(index.readVectors(["obs_1"]).size).toBe(0);
  });

  it("is readable through vectorReaderFor as base64 that decodes to the exact stored floats", async () => {
    const index = new VectorIndex();
    index.add("obs_1", "ses_1", embedding(1));
    const reader = vectorReaderFor(index);
    expect(reader.canRead).toBe(true);
    const read = await reader.read(["obs_1", "obs_missing"]);
    expect([...read.keys()]).toEqual(["obs_1"]);
    expect(base64ToFloat32(read.get("obs_1")!)).toEqual(embedding(1));
  });
});

describe("vectorReaderFor", () => {
  it("has nothing to keep when no embedding provider is configured", async () => {
    const reader = vectorReaderFor(null);
    expect(reader.canRead).toBe(true);
    expect((await reader.read(["obs_1"])).size).toBe(0);
  });

  it("cannot read from a store without readVectors, and read fails loudly instead of reporting no vectors", async () => {
    const port = { add: vi.fn(), remove: vi.fn(), has: () => true, get: () => ({}), search: vi.fn(), size: 1, clear: vi.fn() } as unknown as VectorStorePort;
    const reader = vectorReaderFor(port);
    expect(reader.canRead).toBe(false);
    await expect(reader.read(["obs_1"])).rejects.toThrow(/cannot read/);
  });

  it("passes a store's read failure through, so a failure never looks like a row with no vector", async () => {
    const port = { readVectors: async () => { throw new Error("backend down"); } } as unknown as VectorStorePort;
    await expect(vectorReaderFor(port).read(["obs_1"])).rejects.toThrow("backend down");
  });
});

describe("disk mode: RemoteVectorStore.readVectors", () => {
  const limits = { maxOps: 100, maxBytes: 1 << 20, flushMs: 5, batch: 256 };

  function rig(readVectors: SearchWorkerClient["readVectors"], extra: Partial<SearchWorkerClient> = {}) {
    const calls: string[] = [];
    const client = {
      apply: vi.fn(async (ops: unknown[]) => { calls.push("apply"); return { applied: ops.length, fenced: [], failed: [] }; }),
      readVectors: vi.fn(async (ids: string[]) => { calls.push("readVectors"); return readVectors(ids); }),
      ...extra,
    } as unknown as SearchWorkerClient;
    const outbox = new SearchOutbox(client, limits);
    const ledger = new DocLedger();
    const health = new BackendHealth();
    const store = new RemoteVectorStore(client, outbox, ledger, new StatsCache(client, outbox), health);
    return { store, client, ledger, health, calls };
  }
  const stored = (ids: string[]) => ids.map((id, i) => ({ id, f32b64: float32ToBase64(embedding(i)) }));

  it("decodes the worker's vectors exactly and leaves out ids the worker does not return", async () => {
    const { store } = rig(async (ids) => stored(ids).slice(0, 1));
    const read = await store.readVectors(["obs_1", "obs_2"]);
    expect([...read.keys()]).toEqual(["obs_1"]);
    expect(read.get("obs_1")).toEqual(embedding(0));
  });

  it("reads in batches of READ_VECTORS_BATCH and merges the answers", async () => {
    const ids = Array.from({ length: READ_VECTORS_BATCH * 2 + 5 }, (_, i) => `obs_${i}`);
    const { store, client } = rig(async (batch) => stored(batch));
    const read = await store.readVectors(ids);
    expect(read.size).toBe(ids.length);
    const sizes = vi.mocked(client.readVectors).mock.calls.map(([batch]) => batch.length);
    expect(sizes).toEqual([READ_VECTORS_BATCH, READ_VECTORS_BATCH, 5]);
  });

  it("asks once for an id given twice and not at all for no ids", async () => {
    const { store, client } = rig(async (batch) => stored(batch));
    await store.readVectors(["obs_1", "obs_1"]);
    expect(vi.mocked(client.readVectors).mock.calls[0]![0]).toEqual(["obs_1"]);
    vi.mocked(client.readVectors).mockClear();
    expect((await store.readVectors([])).size).toBe(0);
    expect(client.readVectors).not.toHaveBeenCalled();
  });

  it("sends queued writes first, so a vector added a moment ago is readable", async () => {
    const { store, ledger, calls } = rig(async (ids) => stored(ids));
    ledger.replace("obs_1", { rev: "r1", sessionId: "ses_1", layer: "observation" });
    store.add("obs_1", "ses_1", embedding(1));
    await store.readVectors(["obs_1"]);
    expect(calls).toEqual(["apply", "readVectors"]);
  });

  it("rejects when the worker fails, so an unreadable vector never reads as none", async () => {
    const { store } = rig(async () => { throw new Error("qdrant timeout"); });
    await expect(store.readVectors(["obs_1"])).rejects.toThrow("qdrant timeout");
  });

  it("fails fast without a request while the backend is degraded", async () => {
    const { store, client, health } = rig(async (ids) => stored(ids));
    health.reportFailure(new Error("down"));
    health.allowRequest();
    await expect(store.readVectors(["obs_1"])).rejects.toThrow(/unavailable/);
    expect(client.readVectors).not.toHaveBeenCalled();
  });
});

describe("search::read-vectors wire", () => {
  it("the client sends the ids and unwraps the vectors", async () => {
    const trigger = vi.fn(async () => ({ vectors: [{ id: "obs_1", f32b64: "AAAA" }] }));
    const docs = iiiSearchClient({ trigger } as never);
    expect(await docs.readVectors(["obs_1"])).toEqual([{ id: "obs_1", f32b64: "AAAA" }]);
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ function_id: SEARCH_FN.readVectors, payload: { ids: ["obs_1"] } }));
    await iiiSearchClient({ trigger } as never, "lessons").readVectors(["lsn_1"]);
    expect(trigger).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { ids: ["lsn_1"], collection: "lessons" } }));
  });

  it("the worker routes it to the named text collection and refuses the images collection", async () => {
    const engine = (name: string) => ({ readVectors: vi.fn(async () => [{ id: name, f32b64: "AAAA" }]) });
    const engines = { docs: engine("docs"), lessons: engine("lessons"), images: {} } as unknown as WorkerEngines;
    const handler = createSearchHandlers(engines, 6)[SEARCH_FN.readVectors] as (data: unknown) => Promise<unknown>;
    expect(await handler({ ids: ["a"] })).toEqual({ vectors: [{ id: "docs", f32b64: "AAAA" }] });
    expect(await handler({ ids: ["a"], collection: "lessons" })).toEqual({ vectors: [{ id: "lessons", f32b64: "AAAA" }] });
    await expect(handler({ ids: ["a"], collection: "images" })).rejects.toThrow(/images/);
  });
});

describe("SearchEngine.readVectors", () => {
  const point = (docId: string, payload: Record<string, unknown>, vector: unknown) => ({ id: pointId(docId), payload: { doc_id: docId, ...payload }, vector });

  function engineOver(points: unknown[]) {
    const call = vi.fn(async () => points);
    const qdrant = { config: { layout: "text", collection: "c" }, path: "/collections/c", ensure: async () => {}, call };
    return { engine: new SearchEngine(qdrant as never, 100), call };
  }

  it("asks Qdrant for the dense vector of the points of those ids, and returns it as exact base64", async () => {
    const dense = Array.from(embedding(2));
    const { engine, call } = engineOver([point("obs_1", {}, { dense })]);
    const read = await engine.readVectors(["obs_1"]);
    expect(call).toHaveBeenCalledWith("POST", "/collections/c/points", expect.objectContaining({ ids: [pointId("obs_1")], with_vector: ["dense"] }));
    expect(read.map((v) => v.id)).toEqual(["obs_1"]);
    expect(base64ToFloat32(read[0]!.f32b64)).toEqual(Float32Array.from(dense));
  });

  it("leaves out a deleted point and a point with no dense vector", async () => {
    const dense = Array.from(embedding(2));
    const { engine } = engineOver([
      point("obs_gone", { deleted: true }, { dense }),
      point("obs_nodense", { dense: false }, {}),
      point("obs_nullvec", {}, null),
      point("obs_live", {}, { dense }),
    ]);
    expect((await engine.readVectors(["obs_gone", "obs_nodense", "obs_nullvec", "obs_live"])).map((v) => v.id)).toEqual(["obs_live"]);
  });

  it("ignores ids that are not non-empty strings and asks Qdrant nothing for an empty list", async () => {
    const { engine, call } = engineOver([]);
    expect(await engine.readVectors("obs_1")).toEqual([]);
    expect(await engine.readVectors([1, "", null])).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("activeVectorReader", () => {
  it("follows the runtime the sweep runs against, not the one present when it was built", async () => {
    const early = { vector: null as VectorStorePort | null };
    const reader = activeVectorReader(() => early);
    expect(reader.canRead).toBe(true);
    const index = new VectorIndex();
    index.add("obs_1", "ses_1", embedding(1));
    early.vector = index;
    expect([...(await reader.read(["obs_1"])).keys()]).toEqual(["obs_1"]);
    early.vector = { has: () => true } as unknown as VectorStorePort;
    expect(reader.canRead).toBe(false);
  });
});

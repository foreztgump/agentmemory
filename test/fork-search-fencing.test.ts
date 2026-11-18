// A vector computed for an older version of a record is never stored. Two
// layers enforce it: the app worker's revision check while the embedding runs,
// and the search worker's rev fence for the window between enqueue and apply.
// The Qdrant cases are skipped unless QDRANT_URL is set.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";
import type { StateKV } from "../src/state/kv.js";
import { createSearchRuntime, registerSearchBackend } from "../src/state/search-ports.js";
import { setEmbeddingProvider, setVectorIndex, vectorIndexAddGuarded } from "../src/functions/search.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../src/fork/search/runtime.js";
import type { SearchWorkerClient } from "../src/fork/search/client.js";
import { contentRev, type Op } from "../src/fork/search/protocol.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { DIMS, engineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

function obs(id: string, title: string): CompressedObservation {
  return { id, sessionId: "ses_1", timestamp: "2026-11-01T00:00:00.000Z", type: "discovery", title, narrative: title, facts: [], concepts: [], files: [], importance: 5 } as CompressedObservation;
}

const embedding = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed + i));

/** An embedding provider whose next call waits until release() is called. */
function slowProvider() {
  let release: () => void = () => {};
  const provider: EmbeddingProvider = {
    name: "slow",
    dimensions: DIMS,
    embed: () => new Promise<Float32Array>((resolve) => { release = () => resolve(embedding(1)); }),
    embedBatch: async (texts: string[]) => texts.map((_, i) => embedding(i)),
  } as EmbeddingProvider;
  return { provider, release: () => release() };
}

function useRuntime(runtime: DiskSearchRuntime, provider: EmbeddingProvider): void {
  registerSearchBackend("disk", () => runtime);
  createSearchRuntime({ kv: {} as StateKV, embeddingProvider: provider }, "disk");
  setVectorIndex(runtime.vector);
  setEmbeddingProvider(provider);
}

afterEach(() => {
  setVectorIndex(null);
  setEmbeddingProvider(null);
  createSearchRuntime({ kv: {} as StateKV, embeddingProvider: null }, "memory");
});

describe("vector writes carry the rev of the record they were embedded from", () => {
  function recordingClient(sent: Op[][]): SearchWorkerClient {
    return {
      apply: async (ops) => { sent.push(ops); return { applied: ops.length, fenced: [], failed: [] }; },
      keyword: async () => [], vector: async () => [],
      stats: async () => ({ docs: 0, vectors: 0, memories: 0, lessons: 0, missingVectors: 0 }),
      sessionCounts: async () => [], scanMissingVectors: async () => ({ items: [] }), clear: async () => {},
      health: async () => ({ ok: true, collection: "c", dimensions: DIMS, status: "green" }),
    };
  }

  it("sends a newer document before a queued vector, so the worker sees the new rev first", async () => {
    const sent: Op[][] = [];
    const runtime = createDiskSearchRuntime(recordingClient(sent), true, DIMS);
    runtime.keyword.add(obs("obs_1", "first version"));
    await runtime.outbox.drainFor(1000);
    runtime.vector!.add("obs_1", "ses_1", embedding(1));
    runtime.keyword.add(obs("obs_1", "second version"));
    await runtime.outbox.drainFor(1000);
    runtime.stats.stop();
    const last = sent.at(-1)!;
    expect(last.map((op) => op.k)).toEqual(["doc", "vec"]);
    const [doc, vec] = last as [Extract<Op, { k: "doc" }>, Extract<Op, { k: "vec" }>];
    expect(vec.rev).toBe(contentRev(termSourceOf(obs("obs_1", "first version"))));
    expect(doc.rev).not.toBe(vec.rev);
  });

  it("drops a vector for a record this process never indexed, instead of sending it unfenced", async () => {
    const sent: Op[][] = [];
    const runtime = createDiskSearchRuntime(recordingClient(sent), true, DIMS);
    runtime.vector!.add("obs_unknown", "ses_1", embedding(1));
    await runtime.outbox.drainFor(1000);
    runtime.stats.stop();
    expect(sent).toEqual([]);
    expect(runtime.vector!.unfenced).toBe(1);
  });
});

describe.skipIf(!QDRANT_URL)("fencing against a live Qdrant", () => {
  const qdrant = qdrantFor(`fencing_${process.pid}`);
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  let runtime: DiskSearchRuntime;

  const storedVector = async (id: string) => {
    const hits = await engine.vector(float32ToBase64(embedding(1)), 50, "all", 6);
    return hits.some((h) => h.id === id);
  };

  beforeAll(async () => {
    await qdrant.ensure();
    runtime = createDiskSearchRuntime(engineClient(engine), true, DIMS);
  });

  afterAll(async () => {
    runtime.stats.stop();
    await runtime.outbox.stop(10_000);
    await qdrant.drop();
  });

  it("stores the vector when the record did not change (control)", async () => {
    const { provider, release } = slowProvider();
    useRuntime(runtime, provider);
    runtime.keyword.add(obs("obs_same", "unchanged record"));
    const pending = vectorIndexAddGuarded("obs_same", "ses_1", "unchanged record", { kind: "observation", logId: "obs_same" });
    release();
    expect(await pending).toBe(true);
    await runtime.outbox.drainFor(10_000);
    expect(await storedVector("obs_same")).toBe(true);
  });

  it("does not store a slow embedding when the record changed while it ran", async () => {
    const { provider, release } = slowProvider();
    useRuntime(runtime, provider);
    runtime.keyword.add(obs("obs_changed", "version one"));
    const pending = vectorIndexAddGuarded("obs_changed", "ses_1", "version one", { kind: "observation", logId: "obs_changed" });
    runtime.keyword.add(obs("obs_changed", "version two"));
    release();
    await pending;
    await runtime.outbox.drainFor(10_000);
    expect(await storedVector("obs_changed")).toBe(false);
  });

  it("does not store a slow embedding when the record was deleted while it ran", async () => {
    const { provider, release } = slowProvider();
    useRuntime(runtime, provider);
    runtime.keyword.add(obs("obs_deleted", "short lived"));
    const pending = vectorIndexAddGuarded("obs_deleted", "ses_1", "short lived", { kind: "observation", logId: "obs_deleted" });
    runtime.keyword.remove("obs_deleted");
    release();
    await pending;
    await runtime.outbox.drainFor(10_000);
    expect(await storedVector("obs_deleted")).toBe(false);
  });

  it("the worker refuses a queued vector once a newer version of the record reached it first", async () => {
    runtime.keyword.add(obs("obs_queued", "queued version one"));
    await runtime.outbox.drainFor(10_000);
    const fencedBefore = runtime.outbox.counters.fenced;
    runtime.vector!.add("obs_queued", "ses_1", embedding(1));
    runtime.keyword.add(obs("obs_queued", "queued version two"));
    await runtime.outbox.drainFor(10_000);
    expect(runtime.outbox.counters.fenced).toBe(fencedBefore + 1);
    expect(await storedVector("obs_queued")).toBe(false);
  });

  it("the worker refuses a vector whose rev does not match the stored record, or whose record is gone", async () => {
    const fields = termSourceOf(obs("obs_direct", "direct version two"));
    const staleRev = contentRev(termSourceOf(obs("obs_direct", "direct version one")));
    await engine.apply([{ k: "doc", id: "obs_direct", sessionId: "ses_1", layer: "observation", ts: 1, rev: contentRev(fields), fields }]);
    const f32b64 = float32ToBase64(embedding(1));
    expect((await engine.apply([{ k: "vec", id: "obs_direct", rev: staleRev, f32b64 }])).fenced).toEqual(["obs_direct"]);
    await engine.apply([{ k: "del", id: "obs_direct" }]);
    expect((await engine.apply([{ k: "vec", id: "obs_direct", rev: contentRev(fields), f32b64 }])).fenced).toEqual(["obs_direct"]);
    expect(await storedVector("obs_direct")).toBe(false);
  });
});

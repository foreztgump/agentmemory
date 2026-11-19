// Pins the findings of the TEE-1164 review: outbox accounting and ordering
// around clear(), the worker's clear scope and vector length checks, payload
// index repair, the CLI's Qdrant URL check and the shutdown drain budget.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchWorkerClient } from "../src/fork/search/client.js";
import { SearchOutbox } from "../src/fork/search/outbox.js";
import { contentRev, type Op } from "../src/fork/search/protocol.js";
import { DiskIndexPersistence } from "../src/fork/search/runtime.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { Qdrant } from "../src/fork/worker/qdrant.js";
import { renderWorkerCompose } from "../src/cli/compose-project.js";
import { SHUTDOWN_FLUSH_TIMEOUT_MS } from "../src/shutdown.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import { extractTerms } from "../src/state/term-extraction.js";

const DIMS = 16;
const fields = (title: string) => ({ title, narrative: title, facts: [], concepts: [], files: [], type: "discovery" as const });
const doc = (id: string, title = id): Op => ({ k: "doc", id, sessionId: "ses_1", layer: "observation", ts: 1, rev: contentRev(fields(title)), fields: fields(title) });
const vec = (id: string, length = DIMS): Op => ({ k: "vec", id, rev: contentRev(fields(id)), f32b64: float32ToBase64(new Float32Array(length).fill(0.5)) });

function recordingClient(overrides: Partial<SearchWorkerClient> = {}) {
  const applied: Op[][] = [];
  const clears: string[] = [];
  const client = {
    apply: async (ops: Op[]) => {
      applied.push(ops);
      return { applied: ops.length, fenced: [], failed: [] };
    },
    clear: async (scope: string) => {
      clears.push(scope);
    },
    ...overrides,
  } as unknown as SearchWorkerClient;
  return { client, applied, clears };
}

describe("search outbox around clear()", () => {
  it("frees the bytes of cleared vectors, so later writes do not spill", async () => {
    const { client, applied } = recordingClient();
    const vectorBytes = float32ToBase64(new Float32Array(DIMS)).length;
    const outbox = new SearchOutbox(client, { maxOps: 100, maxBytes: 128 * 4 + vectorBytes * 2, flushMs: 60_000, batch: 256 });
    outbox.put(vec("a"));
    outbox.put(vec("b"));
    outbox.clear("vectors");
    outbox.put(doc("c"));
    outbox.put(doc("d"));
    await outbox.drainFor(2000);
    expect(outbox.counters.spilled).toBe(0);
    expect(applied.flat().map((op) => op.id).sort()).toEqual(["c", "d"]);
  });

  it("does not resend a batch that failed after a clear was queued behind it", async () => {
    let failFirst: (error: Error) => void = () => {};
    let first = true;
    const { client, applied, clears } = recordingClient();
    const record = client.apply;
    client.apply = (ops: Op[]) => {
      if (!first) return record(ops);
      first = false;
      return new Promise((_, reject) => { failFirst = reject; });
    };
    const outbox = new SearchOutbox(client, { maxOps: 100, maxBytes: 1 << 20, flushMs: 5, batch: 256 });
    outbox.put(doc("deleted-before-clear"));
    void outbox.drainFor(0);
    await vi.waitFor(() => expect(first).toBe(false));
    outbox.clear("all");
    outbox.put(doc("after-clear"));
    failFirst(new Error("worker restarted"));
    await outbox.drainFor(5000);
    expect(clears).toEqual(["all"]);
    expect(applied.flat().map((op) => op.id)).toEqual(["after-clear"]);
  });
});

describe("shutdown drain", () => {
  afterEach(() => vi.useRealTimers());

  it("gives up before the app's shutdown flush timeout when the worker never answers", async () => {
    vi.useFakeTimers();
    const { client } = recordingClient({ apply: () => new Promise(() => {}) } as Partial<SearchWorkerClient>);
    const outbox = new SearchOutbox(client, { maxOps: 100, maxBytes: 1 << 20, flushMs: 5, batch: 256 });
    outbox.put(doc("a"));
    let settled = false;
    void new DiskIndexPersistence(outbox).save().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_TIMEOUT_MS - 1);
    expect(settled).toBe(true);
  });
});

function stubQdrant(collectionExists: boolean) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body?: string }) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method, path, body });
    const result = path.endsWith("/exists") ? { exists: collectionExists } : path.endsWith("/points") && init.method === "POST" ? [] : { status: "acknowledged" };
    return new Response(JSON.stringify({ result }), { status: 200 });
  });
  const qdrant = new Qdrant({ url: "http://qdrant.test", collection: "review", dimensions: DIMS, oversampling: 6, timeoutMs: 1000 });
  return { qdrant, requests };
}

describe("am-search worker boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { title: "missing arrays" },
    { ...fields("bad facts"), facts: {} },
    { ...fields("bad concepts"), concepts: null },
    { ...fields("bad files"), files: 42 },
    { ...fields("bad source"), source: { userPrompt: 42 } },
  ])("isolates malformed doc fields %j from valid writes in the same batch", async (badFields) => {
    const { qdrant, requests } = stubQdrant(true);
    const engine = new SearchEngine(qdrant, 70);
    const result = await engine.apply([{ ...doc("bad"), fields: badFields }, doc("ok")]);
    expect(result).toEqual({ applied: 1, fenced: [], failed: [{ id: "bad", error: expect.stringContaining("invalid doc fields") }] });
    const batch = requests.find((r) => r.path.endsWith("/points/batch"))!.body as { operations: Array<{ upsert?: { points: Array<{ payload: { doc_id: string; terms: string[] } }> } }> };
    const points = batch.operations.flatMap((op) => op.upsert?.points ?? []);
    expect(points.map((p) => p.payload.doc_id)).toEqual(["ok"]);
    expect(points[0]!.payload.terms).toEqual(extractTerms(fields("ok")));
    await engine.settled();
  });

  it("refuses a clear with an unknown scope instead of dropping the collection", async () => {
    const { qdrant, requests } = stubQdrant(true);
    const engine = new SearchEngine(qdrant, 70);
    await expect(engine.clear("everything" as never)).rejects.toThrow(/scope/);
    await expect(engine.clear(undefined as never)).rejects.toThrow(/scope/);
    expect(requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("reports a vector of the wrong length per id and still applies the rest of the batch", async () => {
    const { qdrant, requests } = stubQdrant(true);
    const engine = new SearchEngine(qdrant, 70);
    const result = await engine.apply([doc("short"), vec("short", DIMS - 1), doc("ok"), vec("ok")]);
    expect(result.failed.map((f) => f.id)).toEqual(["short"]);
    const batch = requests.find((r) => r.path.endsWith("/points/batch"))!.body as { operations: Array<Record<string, { points: Array<{ vector?: { dense?: number[] } }> }>> };
    const dense = batch.operations.flatMap((op) => op.update_vectors?.points ?? []).filter((p) => p.vector?.dense);
    expect(dense).toHaveLength(1);
    expect(dense[0]!.vector!.dense).toHaveLength(DIMS);
  });

  it("creates the payload indexes even when the collection already exists", async () => {
    const { qdrant, requests } = stubQdrant(true);
    await qdrant.ensure();
    const indexed = requests.filter((r) => r.method === "PUT" && r.path.endsWith("/index")).map((r) => (r.body as { field_name: string }).field_name);
    expect(indexed.sort()).toEqual(["ad", "dense", "dl", "layer", "session_id", "ts", "v"]);
  });
});

describe("CLI worker compose in disk mode", () => {
  it("refuses to render the am-search worker without a Qdrant URL", () => {
    const options = (workerEnvironment: Record<string, string>) => ({
      ports: { restPort: 3511, viewerPort: 3513, enginePort: 49534 },
      dataDir: "/tmp/am/data",
      projectRoot: "/tmp/am/pkg",
      nodeBin: "/opt/node/bin/node",
      homeDir: "/tmp/am/home",
      linux: true,
      windows: false,
      workerEnvironment,
    });
    expect(() => renderWorkerCompose(options({ AM_SEARCH_BACKEND: "disk" }))).toThrow(/AM_QDRANT_URL/);
    expect(() => renderWorkerCompose(options({ AM_SEARCH_BACKEND: "disk", AM_QDRANT_URL: "  " }))).toThrow(/AM_QDRANT_URL/);
  });
});

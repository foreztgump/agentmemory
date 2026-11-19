import { afterEach, describe, expect, it, vi } from "vitest";
import { iiiSearchClient, type SearchWorkerClient } from "../src/fork/search/client.js";
import { SearchOutbox } from "../src/fork/search/outbox.js";
import { contentRev, SEARCH_FN, type Op } from "../src/fork/search/protocol.js";
import { float32ToBase64 } from "../src/state/vector-index.js";

vi.mock("../src/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.useRealTimers());

const fields = { title: "title", narrative: "text", facts: [], concepts: [], files: [], type: "discovery" as const };
const rev = contentRev(fields);
const doc = (id: string): Op => ({ k: "doc", id, fields, rev, sessionId: "ses_1", layer: "observation", ts: 1 });
const vec = (id: string): Op => ({ k: "vec", id, rev, f32b64: float32ToBase64(new Float32Array(16)) });
const limits = { maxOps: 100, maxBytes: 1 << 20, flushMs: 5, batch: 256 };
const applied = (ops: Op[]) => ({ applied: ops.length, fenced: [], failed: [] });

describe("outbox retries across a newer clear", () => {
  it("reclaims vector bytes in surviving document slots", async () => {
    vi.useFakeTimers();
    const apply = vi.fn(async (ops: Op[]) => applied(ops));
    const client = { apply, clear: async () => {} } as unknown as SearchWorkerClient;
    const maxBytes = 2 * (128 + JSON.stringify(fields).length);
    const outbox = new SearchOutbox(client, { ...limits, maxBytes });
    outbox.put(doc("a"));
    outbox.put(vec("a"));
    outbox.clear("vectors");
    outbox.put(doc("b"));
    const drained = outbox.drainFor(1000);
    await vi.runAllTimersAsync();
    await drained;
    expect(outbox.counters.spilled).toBe(0);
    expect(apply.mock.calls.flatMap(([ops]) => ops)).toEqual([doc("a"), doc("b")]);
  });

  it("retries documents while dropping old vectors and preserving newer writes", async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    const apply = vi.fn(async (ops: Op[]) => applied(ops));
    apply.mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    const clear = vi.fn(async () => {});
    const outbox = new SearchOutbox({ apply, clear } as unknown as SearchWorkerClient, limits);
    outbox.put(doc("a"));
    outbox.put(vec("a"));
    outbox.put(vec("vector-only"));
    outbox.put(doc("b"));
    const beforeClear = outbox.drainFor(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);
    outbox.clear("vectors");
    const newerDoc = { ...doc("a"), ts: 2 } as Op;
    outbox.put(newerDoc);
    outbox.put(vec("a"));
    rejectFirst(new Error("offline"));
    await vi.runAllTimersAsync();
    await beforeClear;
    expect(clear).toHaveBeenCalledWith("vectors");
    expect(apply.mock.calls[1]![0]).toEqual([newerDoc, vec("a"), doc("b")]);
    expect(outbox.pending).toBe(0);
  });

  it.each(["all", "vectors"] as const)("releases waiters for writes dropped by %s even while clear is blocked", async (scope) => {
    vi.useFakeTimers();
    let rejectApply!: (error: Error) => void;
    let finishClear!: () => void;
    const apply = vi.fn(() => new Promise<ReturnType<typeof applied>>((_, reject) => { rejectApply = reject; }));
    const clear = vi.fn(() => new Promise<void>((resolve) => { finishClear = resolve; }));
    const outbox = new SearchOutbox({ apply, clear } as unknown as SearchWorkerClient, limits);
    outbox.put(scope === "all" ? doc("a") : vec("a"));
    let settled = false;
    const drained = outbox.drainFor(60_000).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    outbox.clear(scope);
    rejectApply(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await drained;
    await vi.advanceTimersByTimeAsync(20);
    expect(clear).toHaveBeenCalledWith(scope);
    expect(apply).toHaveBeenCalledTimes(1);
    finishClear();
    await vi.runAllTimersAsync();
    expect(outbox.pending).toBe(0);
  });
});

it("uses the best-effort search timeout without shortening other calls", async () => {
  const trigger = vi.fn(async (_request: { function_id: string; payload: unknown; timeoutMs: number }) => ({ hits: [], counts: [] }));
  const client = iiiSearchClient({ trigger } as never);
  await client.keyword("query", 10, "all");
  await client.vector("vector", 10, "all");
  await client.stats();
  await client.sessionCounts();
  await client.scanMissingVectors(undefined, 10);
  await client.health();
  await client.apply([]);
  await client.clear("all");
  expect(trigger.mock.calls.map(([request]) => request)).toMatchObject([
    { function_id: SEARCH_FN.keyword, timeoutMs: 3000 },
    { function_id: SEARCH_FN.vector, timeoutMs: 3000 },
    { function_id: SEARCH_FN.stats, timeoutMs: 10_000 },
    { function_id: SEARCH_FN.sessionCounts, timeoutMs: 10_000 },
    { function_id: SEARCH_FN.scanMissingVectors, timeoutMs: 10_000 },
    { function_id: SEARCH_FN.health, timeoutMs: 10_000 },
    { function_id: SEARCH_FN.apply, timeoutMs: 60_000 },
    { function_id: SEARCH_FN.clear, timeoutMs: 60_000 },
  ]);
});

describe("the outbox seeds its versions above the stored ones", () => {
  it("retries the floor read with the batch while it fails, then reads it once per outbox", async () => {
    vi.useFakeTimers();
    const floor = Date.now() * 1000 + 3_600_000_000;
    const maxVersion = vi.fn(async () => floor);
    maxVersion.mockRejectedValueOnce(new Error("worker unavailable"));
    const apply = vi.fn(async (ops: Op[], _version?: number) => applied(ops));
    const outbox = new SearchOutbox({ apply, maxVersion } as unknown as SearchWorkerClient, limits);
    outbox.put(doc("first"));
    const firstDrain = outbox.drainFor(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(maxVersion).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(outbox.pending).toBe(1);
    await vi.runAllTimersAsync();
    await firstDrain;
    expect(maxVersion).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toBeGreaterThan(floor);

    outbox.put(doc("second"));
    const secondDrain = outbox.drainFor(1000);
    await vi.runAllTimersAsync();
    await secondDrain;
    expect(maxVersion).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]![1]).toBeGreaterThan(apply.mock.calls[0]![1]!);
  });

  it("reads the floor with the read timeout", async () => {
    const trigger = vi.fn(async (_request: { function_id: string; payload: unknown; timeoutMs: number }) => ({ version: 42 }));
    expect(await iiiSearchClient({ trigger } as never).maxVersion!()).toBe(42);
    expect(trigger.mock.calls[0]![0]).toMatchObject({ function_id: SEARCH_FN.maxVersion, timeoutMs: 10_000 });
  });
});

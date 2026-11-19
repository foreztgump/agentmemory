// TEE-1167 without Qdrant: the wire protocol, outbox coalescing, runtime wiring,
// settings, worker routing and the disk path of lessons.ts against fakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { iiiSearchClient, type SearchWorkerClient } from "../src/fork/search/client.js";
import { DocLedger, SearchOutbox } from "../src/fork/search/outbox.js";
import { COLLECTION_IDS, collectionName, SEARCH_FN, type ImgOp, type Op } from "../src/fork/search/protocol.js";
import { RemoteKeywordIndex, StatsCache } from "../src/fork/search/remote-index.js";
import { loadSearchWorkerSettings } from "../src/fork/search/settings.js";
import { createSearchHandlers, type WorkerEngines } from "../src/fork/worker/router.js";
import type { CompressedObservation, Lesson } from "../src/types.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.useRealTimers());

const img = (id: string, updatedAt = "2026-11-01T00:00:00.000Z", sessionId = "ses_1"): ImgOp => ({
  k: "img", id, sessionId, f32b64: float32ToBase64(new Float32Array(8)), updatedAt,
});
const limits = { maxOps: 100, maxBytes: 1 << 20, flushMs: 5, batch: 256 };
const applied = (ops: Op[]) => ({ applied: ops.length, fenced: [], failed: [] });

describe("collection-bound client", () => {
  function recorder() {
    const payloads: Array<{ function_id: string; payload: Record<string, unknown> }> = [];
    const trigger = vi.fn(async ({ function_id, payload }: { function_id: string; payload: Record<string, unknown> }) => {
      payloads.push({ function_id, payload });
      return { hits: [], items: [], counts: [], version: 1, total: 0 };
    });
    return { payloads, sdk: { trigger } as never };
  }

  it("sends no collection field for docs, so its wire format is unchanged", async () => {
    const { sdk, payloads } = recorder();
    const client = iiiSearchClient(sdk);
    await client.apply([{ k: "del", id: "a" }], 7);
    await client.keyword("q", 5, "all");
    await client.lookup(["a"]);
    await client.stats();
    await client.health();
    expect(payloads.every((p) => !("collection" in p.payload))).toBe(true);
    expect(JSON.stringify(payloads[0]!.payload)).toBe('{"ops":[{"k":"del","id":"a"}],"version":7}');
  });

  it.each(["lessons", "images"] as const)("binds every %s call to its collection", async (collection) => {
    const { sdk, payloads } = recorder();
    const client = iiiSearchClient(sdk, collection);
    await client.apply([], 1);
    await client.maxVersion!();
    await client.keyword("q", 5, "all");
    await client.imageQuery("AAAA", 3, "ses_1");
    await client.clear("all");
    expect(payloads).toHaveLength(5);
    expect(payloads.every((p) => p.payload.collection === collection)).toBe(true);
    expect(payloads.find((p) => p.function_id === SEARCH_FN.imageQuery)!.payload).toEqual({ f32b64: "AAAA", limit: 3, sessionId: "ses_1", collection });
  });
});

describe("collections", () => {
  it("derives every name from the one list", () => {
    expect(COLLECTION_IDS).toEqual(["docs", "lessons", "images"]);
    expect(COLLECTION_IDS.map((id) => collectionName("am", id))).toEqual(["am", "am_lessons", "am_images"]);
  });
});

describe("settings", () => {
  const base = { AM_QDRANT_URL: "http://qdrant:6333" };

  it("defaults the image vector to 512 dimensions and names the collections after AM_QDRANT_COLLECTION", () => {
    const s = loadSearchWorkerSettings({ ...base, AM_QDRANT_COLLECTION: "mem" });
    expect(s.imageDimensions).toBe(512);
    expect(s.collections).toEqual({ docs: "mem", lessons: "mem_lessons", images: "mem_images" });
  });

  it("reads AM_SEARCH_IMAGE_DIMENSIONS", () => {
    expect(loadSearchWorkerSettings({ ...base, AM_SEARCH_IMAGE_DIMENSIONS: "768" }).imageDimensions).toBe(768);
  });

  it.each(["0", "-4", "abc", "511.5"])("rejects AM_SEARCH_IMAGE_DIMENSIONS=%s at boot", (value) => {
    expect(() => loadSearchWorkerSettings({ ...base, AM_SEARCH_IMAGE_DIMENSIONS: value })).toThrow(/AM_SEARCH_IMAGE_DIMENSIONS/);
  });
});

describe("outbox img ops", () => {
  async function flushed(fn: (outbox: SearchOutbox) => void, outboxLimits = limits) {
    vi.useFakeTimers();
    const apply = vi.fn(async (ops: Op[]) => applied(ops));
    const outbox = new SearchOutbox({ apply, clear: async () => {} } as unknown as SearchWorkerClient, outboxLimits);
    fn(outbox);
    const drained = outbox.drainFor(1000);
    await vi.runAllTimersAsync();
    await drained;
    return { outbox, sent: apply.mock.calls.flatMap(([ops]) => ops) };
  }

  it("a later img for the same id replaces the earlier one", async () => {
    const newer = img("a", "2026-11-02T00:00:00.000Z");
    const { sent } = await flushed((o) => { o.put(img("a")); o.put(newer); });
    expect(sent).toEqual([newer]);
  });

  it("a del replaces a pending img and a later img replaces the del", async () => {
    expect((await flushed((o) => { o.put(img("a")); o.put({ k: "del", id: "a" }); })).sent).toEqual([{ k: "del", id: "a" }]);
    const again = img("a", "2026-11-03T00:00:00.000Z");
    expect((await flushed((o) => { o.put({ k: "del", id: "a" }); o.put(again); })).sent).toEqual([again]);
  });

  it("an img keeps the slot's place among other ids", async () => {
    const { sent } = await flushed((o) => { o.put(img("a")); o.put(img("b")); o.put(img("a", "2026-11-02T00:00:00.000Z")); });
    expect(sent.map((op) => op.id)).toEqual(["a", "b"]);
  });

  it("an img's bytes count toward the cap", async () => {
    vi.useFakeTimers();
    const apply = vi.fn(async () => { throw new Error("offline"); });
    const maxBytes = 128 + img("a").f32b64.length;
    const outbox = new SearchOutbox({ apply, clear: async () => {} } as unknown as SearchWorkerClient, { ...limits, maxBytes });
    outbox.put(img("a"));
    outbox.put(img("b"));
    outbox.put(img("c"));
    await vi.advanceTimersByTimeAsync(20);
    expect(outbox.counters.spilled).toBeGreaterThan(0);
    expect(outbox.pending).toBeLessThanOrEqual(1);
  });
});

describe("RemoteKeywordIndex.addIfChanged", () => {
  const lesson = (title: string): CompressedObservation => ({
    id: "lsn_1", sessionId: "lesson", timestamp: "2026-11-01T00:00:00.000Z", type: "decision", title,
    facts: [], narrative: "", concepts: [], files: [], importance: 0.5,
  } as CompressedObservation);

  it("skips a write whose content rev the ledger already holds", async () => {
    vi.useFakeTimers();
    const apply = vi.fn(async (ops: Op[]) => applied(ops));
    const client = { apply, clear: async () => {} } as unknown as SearchWorkerClient;
    const outbox = new SearchOutbox(client, limits);
    const index = new RemoteKeywordIndex(client, outbox, new DocLedger(), new StatsCache(client, outbox));
    index.addIfChanged(lesson("always pin the digest"), "lesson");
    index.addIfChanged(lesson("always pin the digest"), "lesson");
    index.addIfChanged(lesson("drain nodes first"), "lesson");
    const drained = outbox.drainFor(1000);
    await vi.runAllTimersAsync();
    await drained;
    const sent = apply.mock.calls.flatMap(([ops]) => ops);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ k: "doc", id: "lsn_1", layer: "lesson", fields: { title: "drain nodes first" } });
  });

  it("writes again after a remove", async () => {
    vi.useFakeTimers();
    const apply = vi.fn(async (ops: Op[]) => applied(ops));
    const client = { apply, clear: async () => {} } as unknown as SearchWorkerClient;
    const outbox = new SearchOutbox(client, limits);
    const index = new RemoteKeywordIndex(client, outbox, new DocLedger(), new StatsCache(client, outbox));
    index.addIfChanged(lesson("same"), "lesson");
    let drained = outbox.drainFor(1000);
    await vi.runAllTimersAsync();
    await drained;
    index.remove("lsn_1");
    index.addIfChanged(lesson("same"), "lesson");
    drained = outbox.drainFor(1000);
    await vi.runAllTimersAsync();
    await drained;
    expect(apply.mock.calls.flatMap(([ops]) => ops).map((op) => op.k)).toEqual(["doc", "doc"]);
  });
});

describe("worker routing", () => {
  function engines() {
    const stub = () => ({
      apply: vi.fn(async () => applied([])),
      keyword: vi.fn(async () => []),
      vector: vi.fn(async () => []),
      lookup: vi.fn(async () => []),
      stats: vi.fn(async () => ({})),
      sessionCounts: vi.fn(async () => []),
      scanMissingVectors: vi.fn(async () => ({ items: [] })),
      clear: vi.fn(async () => {}),
      health: vi.fn(async () => ({})),
      maxVersion: vi.fn(async () => 1),
      query: vi.fn(async () => ({ hits: [], total: 0 })),
    });
    const all = { docs: stub(), lessons: stub(), images: stub() };
    return { all, handlers: createSearchHandlers(all as unknown as WorkerEngines, 6) };
  }
  const call = (handlers: ReturnType<typeof engines>["handlers"], id: string, payload: unknown) =>
    (handlers[id as keyof typeof handlers] as (data: unknown) => Promise<unknown>)(payload);

  it("routes a request without a collection to docs", async () => {
    const { all, handlers } = engines();
    await call(handlers, SEARCH_FN.keyword, { query: "q", limit: 3, layer: "all" });
    expect(all.docs.keyword).toHaveBeenCalledTimes(1);
    expect(all.lessons.keyword).not.toHaveBeenCalled();
  });

  it.each(["lessons", "images"] as const)("routes apply, clear, health and max-version to %s", async (collection) => {
    const { all, handlers } = engines();
    await call(handlers, SEARCH_FN.apply, { ops: [], version: 5, collection });
    await call(handlers, SEARCH_FN.clear, { scope: "all", collection });
    await call(handlers, SEARCH_FN.health, { collection });
    await call(handlers, SEARCH_FN.maxVersion, { collection });
    expect(all[collection].apply).toHaveBeenCalledWith([], 5);
    expect(all[collection].clear).toHaveBeenCalledWith("all");
    expect(all[collection].health).toHaveBeenCalled();
    expect(all[collection].maxVersion).toHaveBeenCalled();
    expect(all.docs.apply).not.toHaveBeenCalled();
  });

  it("routes lesson keyword search to the lessons engine", async () => {
    const { all, handlers } = engines();
    await call(handlers, SEARCH_FN.keyword, { query: "q", limit: 3, layer: "all", collection: "lessons" });
    expect(all.lessons.keyword).toHaveBeenCalledTimes(1);
    expect(all.docs.keyword).not.toHaveBeenCalled();
  });

  it("rejects an unknown collection", async () => {
    const { handlers } = engines();
    await expect(call(handlers, SEARCH_FN.keyword, { query: "q", collection: "bogus" })).rejects.toThrow(/unknown collection/);
    await expect(call(handlers, SEARCH_FN.apply, { ops: [], collection: "__proto__" })).rejects.toThrow(/unknown collection/);
    await expect(call(handlers, SEARCH_FN.apply, { ops: [], collection: 3 })).rejects.toThrow(/unknown collection/);
  });

  it.each([
    SEARCH_FN.keyword, SEARCH_FN.vector, SEARCH_FN.lookup, SEARCH_FN.stats, SEARCH_FN.sessionCounts, SEARCH_FN.scanMissingVectors,
  ])("rejects the text call %s on the images collection", async (id) => {
    const { handlers } = engines();
    await expect(call(handlers, id, { collection: "images", query: "q", ids: ["a"] })).rejects.toThrow(/images/);
  });

  it.each([undefined, "docs", "lessons"])("rejects an image query on the %s collection", async (collection) => {
    const { all, handlers } = engines();
    await expect(call(handlers, SEARCH_FN.imageQuery, { f32b64: "AAAA", limit: 3, collection })).rejects.toThrow(/images collection/);
    expect(all.images.query).not.toHaveBeenCalled();
  });

  it("serves an image query on the images collection", async () => {
    const { all, handlers } = engines();
    await call(handlers, SEARCH_FN.imageQuery, { f32b64: "AAAA", limit: 3, sessionId: "s", collection: "images" });
    expect(all.images.query).toHaveBeenCalledWith("AAAA", 3, "s");
  });
});

describe("runtime wiring", () => {
  function fakeSdk() {
    const calls: Array<{ function_id: string; payload: Record<string, unknown> }> = [];
    const trigger = vi.fn(async ({ function_id, payload }: { function_id: string; payload: Record<string, unknown> }) => {
      calls.push({ function_id, payload });
      if (function_id === SEARCH_FN.apply) return { applied: 1, fenced: [], failed: [] };
      if (function_id === SEARCH_FN.maxVersion) return { version: 0 };
      if (function_id === SEARCH_FN.health) return { ok: true, collection: "c", dimensions: 0, status: "green" };
      if (function_id === SEARCH_FN.stats) return { docs: 0, vectors: 0, memories: 0, lessons: 0, missingVectors: 0 };
      return { hits: [], total: 0 };
    });
    return { calls, sdk: { trigger } as never };
  }

  it("the disk runtime has lessons and images, each writing to its own collection", async () => {
    vi.resetModules();
    const ports = await import("../src/state/search-ports.js");
    await import("../src/fork/search/runtime.js");
    const { sdk, calls } = fakeSdk();
    const runtime = ports.createSearchRuntime({ kv: mockKV() as never, embeddingProvider: null, sdk }, "disk");
    expect(runtime.lessons).toBeTruthy();
    expect(runtime.images).toBeTruthy();
    runtime.lessons!.add({
      id: "lsn_1", sessionId: "lesson", timestamp: "2026-11-01T00:00:00.000Z", type: "decision", title: "pin digests",
      facts: [], narrative: "", concepts: [], files: [], importance: 0.5,
    } as CompressedObservation, "lesson");
    runtime.images!.put({ imageRef: "/img/a.png", vector: [1, 0, 0], modelName: "m", dimensions: 3, updatedAt: "2026-11-01T00:00:00.000Z", sessionId: "ses_1" });
    await runtime.openPersistence().save();
    const applies = calls.filter((c) => c.function_id === SEARCH_FN.apply);
    expect(applies.map((c) => c.payload.collection).sort()).toEqual(["images", "lessons"]);
    expect((applies.find((c) => c.payload.collection === "images")!.payload.ops as ImgOp[])[0]).toMatchObject({ k: "img", id: "/img/a.png", sessionId: "ses_1" });
    expect((applies.find((c) => c.payload.collection === "lessons")!.payload.ops as Op[])[0]).toMatchObject({ k: "doc", id: "lsn_1", layer: "lesson" });
    expect(runtime.openPersistence().status().pendingChanges).toBe(0);
    (runtime as unknown as { stats: StatsCache }).stats.stop();
  });

  it("persistence status sums the pending writes of every outbox", async () => {
    vi.resetModules();
    const ports = await import("../src/state/search-ports.js");
    await import("../src/fork/search/runtime.js");
    const trigger = vi.fn(() => new Promise(() => {}));
    const runtime = ports.createSearchRuntime({ kv: mockKV() as never, embeddingProvider: null, sdk: { trigger } as never }, "disk");
    runtime.images!.put({ imageRef: "/img/a.png", vector: [1], modelName: "m", dimensions: 1, updatedAt: "x" });
    runtime.images!.remove("/img/b.png");
    expect(runtime.openPersistence().status().pendingChanges).toBe(2);
    (runtime as unknown as { stats: StatsCache }).stats.stop();
  });

  it("the memory runtime has neither", async () => {
    vi.resetModules();
    const ports = await import("../src/state/search-ports.js");
    const runtime = ports.createSearchRuntime({ kv: mockKV() as never, embeddingProvider: null }, "memory");
    expect(runtime.lessons).toBeUndefined();
    expect(runtime.images).toBeUndefined();
  });
});

describe("lessons.ts in disk mode", () => {
  function lessonRow(content: string): Lesson {
    return {
      id: `lsn_${content.replace(/\W+/g, "_")}`, content, context: "", confidence: 0.6, reinforcements: 0, source: "manual",
      sourceIds: [], tags: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", decayRate: 0.05,
    };
  }

  async function setup() {
    vi.resetModules();
    const ports = await import("../src/state/search-ports.js");
    const lessons = await import("../src/functions/lessons.js");
    const base = mockKV();
    const listed: string[] = [];
    const list = base.list;
    const kv = {
      ...base,
      list: async <T>(scope: string) => {
        listed.push(scope);
        return list<T>(scope);
      },
      getMany: async <T>(scope: string, keys: string[]) => Promise.all(keys.map((k) => base.get<T>(scope, k))),
    };
    const index = {
      added: [] as Array<{ id: string; layer?: string }>,
      removed: [] as string[],
      hits: [] as Array<{ obsId: string; sessionId: string; score: number }>,
      addIfChanged(obs: CompressedObservation, layer?: string) { this.added.push({ id: obs.id, layer }); },
      add(obs: CompressedObservation, layer?: string) { this.added.push({ id: obs.id, layer }); },
      remove(id: string) { this.removed.push(id); },
      search: vi.fn(async function (this: { hits: unknown[] }) { return this.hits; }),
    };
    ports.getSearchRuntime();
    const runtime = ports.getSearchRuntime() as unknown as Record<string, unknown>;
    runtime.lessons = index;
    const sdk = mockSdk({ looseTrigger: true });
    lessons.registerLessonsFunctions(sdk as never, kv as never);
    return { sdk, kv, base, index, listed, lessons };
  }

  it("writes through the lessons index and never lists mem:lessons", async () => {
    const { sdk, index, listed } = await setup();
    const saved = (await sdk.trigger("mem::lesson-save", { content: "pin the image digest" })) as { lesson: Lesson };
    await sdk.trigger("mem::lesson-strengthen", { lessonId: saved.lesson.id });
    index.hits.push({ obsId: saved.lesson.id, sessionId: "lesson", score: 3 });
    const recalled = (await sdk.trigger("mem::lesson-recall", { query: "pin digest" })) as { lessons: Lesson[] };
    await sdk.trigger("mem::lesson-delete", { lessonId: saved.lesson.id });
    expect(recalled.lessons.map((l) => l.id)).toEqual([saved.lesson.id]);
    expect(index.added.map((a) => a.layer)).toEqual(["lesson", "lesson"]);
    expect(index.removed).toEqual([saved.lesson.id]);
    expect(listed.filter((scope) => scope === "mem:lessons")).toEqual([]);
  });

  it("answers recall from KV records only, with no resident copy", async () => {
    const { sdk, base, index } = await setup();
    const saved = (await sdk.trigger("mem::lesson-save", { content: "pin the image digest" })) as { lesson: Lesson };
    index.hits.push({ obsId: saved.lesson.id, sessionId: "lesson", score: 3 });
    base.store.get("mem:lessons")!.delete(saved.lesson.id);
    const recalled = (await sdk.trigger("mem::lesson-recall", { query: "pin digest" })) as { lessons: Lesson[] };
    expect(recalled.lessons).toEqual([]);
  });

  it("applies the confidence, project and deleted filters to the hits", async () => {
    const { sdk, base, index } = await setup();
    const rows = [
      { ...lessonRow("alpha rule"), confidence: 0.9, project: "p1" },
      { ...lessonRow("beta rule"), confidence: 0.05, project: "p1" },
      { ...lessonRow("gamma rule"), confidence: 0.8, project: "p2" },
      { ...lessonRow("delta rule"), confidence: 0.8, project: "p1", deleted: true },
    ];
    for (const r of rows) await base.set("mem:lessons", r.id, r);
    index.hits.push(...rows.map((r, i) => ({ obsId: r.id, sessionId: "lesson", score: 4 - i })));
    const all = (await sdk.trigger("mem::lesson-recall", { query: "rule" })) as { lessons: Lesson[] };
    expect(all.lessons.map((l) => l.content)).toEqual(["alpha rule", "gamma rule"]);
    const p1 = (await sdk.trigger("mem::lesson-recall", { query: "rule", project: "p1" })) as { lessons: Lesson[] };
    expect(p1.lessons.map((l) => l.content)).toEqual(["alpha rule"]);
    expect(index.search).toHaveBeenLastCalledWith("rule", 100, "all");
  });

  it("resetLessonIndex converges the ids it is given to KV", async () => {
    const { base, index, lessons } = await setup();
    const live = lessonRow("live rule");
    const gone = lessonRow("gone rule");
    const dead = { ...lessonRow("dead rule"), deleted: true };
    await base.set("mem:lessons", live.id, live);
    await base.set("mem:lessons", dead.id, dead);
    await lessons.resetLessonIndex([live.id, gone.id, dead.id, live.id]);
    expect(index.added).toEqual([{ id: live.id, layer: "lesson" }]);
    expect(index.removed.sort()).toEqual([dead.id, gone.id].sort());
  });
});

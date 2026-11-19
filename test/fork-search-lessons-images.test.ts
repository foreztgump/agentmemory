// TEE-1167 on a live Qdrant: lesson recall and image search through the worker's
// lessons and images collections, against the in-memory implementations.
//   QDRANT_URL=http://127.0.0.1:6333 [QDRANT_API_KEY=...] npx vitest run test/fork-search-lessons-images.test.ts
// Skipped without QDRANT_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { collectionName, SEARCH_FN, type Op } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { ImageEngine } from "../src/fork/worker/image-engine.js";
import { createSearchHandlers, type WorkerEngines } from "../src/fork/worker/router.js";
import { IMAGES_DIR } from "../src/utils/image-store.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import type { EmbeddingProvider, Lesson } from "../src/types.js";
import { mulberry32 } from "../bench/fork/lib/stats.js";
import { DIMS, imageEngineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const IMAGE_DIMS = 512;
const base = `t1167impl_${process.pid}_${Math.floor(Math.random() * 1e9)}`;

/** The am-search worker in-process: the real router over real engines, reached through the wire's JSON. */
function workerSdk(engines: WorkerEngines) {
  const handlers = createSearchHandlers(engines, 6);
  const calls: Array<{ function_id: string; payload: Record<string, unknown> }> = [];
  const trigger = async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
    const wire = JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
    calls.push({ function_id, payload: wire });
    const handler = handlers[function_id as keyof typeof handlers] as ((data: unknown) => Promise<unknown>) | undefined;
    if (!handler) throw new Error(`No function: ${function_id}`);
    return JSON.parse(JSON.stringify(await handler(wire)));
  };
  return { calls, sdk: { trigger } as never };
}

function makeEngines() {
  const qdrants = {
    docs: qdrantFor(collectionName(base, "docs")),
    lessons: qdrantFor(collectionName(base, "lessons"), DIMS, "lessons"),
    images: qdrantFor(collectionName(base, "images"), IMAGE_DIMS, "image"),
  };
  const engines: WorkerEngines = {
    docs: new SearchEngine(qdrants.docs, DEFAULT_AVGDL),
    lessons: new SearchEngine(qdrants.lessons, DEFAULT_AVGDL),
    images: new ImageEngine(qdrants.images),
  };
  return { qdrants, engines };
}

const compare = (a: string, b: string) => Number(a > b) - Number(a < b);

// Pseudo-words of one length and distinct stems, so no query term is a prefix of another and BM25 has no prefix half-weights to disagree on.
const SYLLABLES = ["ka", "vo", "mi", "ru", "te", "so", "la", "pe", "zu", "ni", "do", "fa"];
const VOCAB = Array.from({ length: 72 }, (_, i) => `${SYLLABLES[i % 12]}${SYLLABLES[Math.floor(i / 12) % 12]}${SYLLABLES[(i * 5 + 3) % 12]}x`);

function lessonFixture(count: number, rand: () => number): Lesson[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  return Array.from({ length: count }, (_, i) => {
    const common = Array.from({ length: 4 + Math.floor(rand() * 4) }, () => pick(VOCAB.slice(0, 24)));
    const rare = i < 40 ? [VOCAB[24 + i]!] : [];
    const words = [...common, ...rare].sort(() => rand() - 0.5);
    return {
      id: `lsn_fixture_${String(i).padStart(3, "0")}`,
      content: words.join(" "),
      context: i % 3 === 0 ? pick(VOCAB.slice(0, 24)) : "",
      confidence: Math.round((0.15 + rand() * 0.8) * 100) / 100,
      reinforcements: Math.floor(rand() * 4),
      source: "manual" as const,
      sourceIds: [],
      project: pick(["alpha", "beta", "gamma"]),
      tags: i % 5 === 0 ? [pick(VOCAB.slice(0, 24))] : [],
      createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 28))).toISOString(),
      updatedAt: "2026-11-01T00:00:00.000Z",
      decayRate: 0.05,
      ...(i % 13 === 7 ? { deleted: true } : {}),
    };
  });
}

function recallKv(rows: Lesson[]) {
  const kv = mockKV();
  const listed: string[] = [];
  const list = kv.list;
  const wrapped = {
    ...kv,
    list: async <T>(scope: string) => {
      listed.push(scope);
      return list<T>(scope);
    },
    getMany: async <T>(scope: string, keys: string[]) => Promise.all(keys.map((k) => kv.get<T>(scope, k))),
  };
  return { kv: wrapped, listed, seed: async () => { for (const r of rows) await kv.set("mem:lessons", r.id, r); } };
}

async function loadModules() {
  vi.resetModules();
  const ports = await import("../src/state/search-ports.js");
  await import("../src/fork/search/runtime.js");
  const lessons = await import("../src/functions/lessons.js");
  const vision = await import("../src/functions/vision-search.js");
  const imageRefs = await import("../src/functions/image-refs.js");
  return { ports, lessons, vision, imageRefs };
}

describe.skipIf(!QDRANT_URL)("lesson recall through the lessons collection", () => {
  const fixture = lessonFixture(50, mulberry32(1167));
  const live = fixture.filter((l) => !l.deleted);
  const queries: Array<{ name: string; data: { query: string; project?: string; minConfidence?: number; limit?: number } }> = [];
  const rand = mulberry32(5);
  let memoryResults: Record<string, Array<{ id: string; score: number }>> = {};
  const { qdrants, engines } = makeEngines();
  let worker: ReturnType<typeof workerSdk>;

  const results = async (sdk: ReturnType<typeof mockSdk>) => {
    const out: typeof memoryResults = {};
    for (const q of queries) {
      const res = (await sdk.trigger("mem::lesson-recall", q.data)) as { success: boolean; lessons: Array<Lesson & { score: number }> };
      expect(res.success).toBe(true);
      out[q.name] = res.lessons.map((l) => ({ id: l.id, score: l.score }));
    }
    return out;
  };

  beforeAll(async () => {
    const rares = live.filter((l) => fixture.indexOf(l) < 40).slice(0, 8);
    for (const l of rares) queries.push({ name: `rare ${l.id}`, data: { query: VOCAB[24 + fixture.indexOf(l)]!, limit: 5 } });
    for (let i = 0; i < 10; i++) queries.push({ name: `shared ${i}`, data: { query: `${VOCAB[Math.floor(rand() * 24)]} ${VOCAB[Math.floor(rand() * 24)]}`, limit: 10 } });
    for (const project of ["alpha", "beta"]) queries.push({ name: `project ${project}`, data: { query: `${VOCAB[1]} ${VOCAB[2]} ${VOCAB[3]}`, project, limit: 10 } });
    queries.push({ name: "min confidence", data: { query: `${VOCAB[4]} ${VOCAB[5]}`, minConfidence: 0.5, limit: 10 } });
    queries.push({ name: "project and min confidence", data: { query: `${VOCAB[6]} ${VOCAB[7]}`, project: "gamma", minConfidence: 0.4, limit: 3 } });

    const memory = await loadModules();
    const mem = recallKv(fixture);
    await mem.seed();
    memory.ports.createSearchRuntime({ kv: mem.kv as never, embeddingProvider: null }, "memory");
    const memSdk = mockSdk({ looseTrigger: true });
    memory.lessons.registerLessonsFunctions(memSdk as never, mem.kv as never);
    memoryResults = await results(memSdk);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(Object.values(qdrants).map((q) => q.drop()));
  }, 60_000);

  it("returns the same top results as memory mode on a fixture of 50 lessons", async () => {
    const disk = await loadModules();
    worker = workerSdk(engines);
    const runtime = disk.ports.createSearchRuntime({ kv: null as never, embeddingProvider: null, sdk: worker.sdk }, "disk");
    const dkv = recallKv(fixture);
    await dkv.seed();
    const sdk = mockSdk({ looseTrigger: true });
    disk.lessons.registerLessonsFunctions(sdk as never, dkv.kv as never);
    await disk.lessons.resetLessonIndex(fixture.map((l) => l.id));
    await runtime.openPersistence().save();

    const diskResults = await results(sdk);
    const nonEmpty = Object.values(memoryResults).filter((r) => r.length > 0).length;
    expect(nonEmpty).toBeGreaterThanOrEqual(queries.length - 2);
    for (const q of queries) {
      expect(diskResults[q.name]!.map((r) => r.id), q.name).toEqual(memoryResults[q.name]!.map((r) => r.id));
      diskResults[q.name]!.forEach((r, i) => expect(r.score, q.name).toBeCloseTo(memoryResults[q.name]![i]!.score, 2));
    }
    expect(dkv.listed.filter((scope) => scope === "mem:lessons")).toEqual([]);
    expect((await engines.lessons.stats()).lessons).toBe(live.length);
    (runtime as unknown as { stats: { stop(): void } }).stats.stop();
  }, 60_000);

  it("keeps the lessons collection in step through save, strengthen, delete, decay and reset", async () => {
    await engines.lessons.clear("all");
    const disk = await loadModules();
    const stack = workerSdk(engines);
    const runtime = disk.ports.createSearchRuntime({ kv: null as never, embeddingProvider: null, sdk: stack.sdk }, "disk");
    const lkv = recallKv([]);
    const sdk = mockSdk({ looseTrigger: true });
    disk.lessons.registerLessonsFunctions(sdk as never, lkv.kv as never);
    const lessonApplies = () => stack.calls.filter((c) => c.function_id === SEARCH_FN.apply && c.payload.collection === "lessons").length;
    const settle = () => runtime.openPersistence().save();
    const recall = async (query: string) =>
      ((await sdk.trigger("mem::lesson-recall", { query, minConfidence: 0 })) as { lessons: Lesson[] }).lessons.map((l) => l.id);

    const a = ((await sdk.trigger("mem::lesson-save", { content: "kavoxz quartz ledger", confidence: 0.6 })) as { lesson: Lesson }).lesson;
    const b = ((await sdk.trigger("mem::lesson-save", { content: "miruxz harbor beacon", confidence: 0.6 })) as { lesson: Lesson }).lesson;
    await settle();
    expect(await recall("quartz")).toEqual([a.id]);
    expect(await recall("harbor")).toEqual([b.id]);

    const before = lessonApplies();
    await sdk.trigger("mem::lesson-strengthen", { lessonId: a.id });
    await settle();
    expect(lessonApplies(), "strengthening changes no indexed text").toBe(before);

    await sdk.trigger("mem::lesson-save", { content: "kavoxz quartz ledger", context: "tungsten furnace" });
    await settle();
    expect(await recall("tungsten")).toEqual([a.id]);

    await sdk.trigger("mem::lesson-delete", { lessonId: b.id });
    await settle();
    expect(await recall("harbor")).toEqual([]);

    const old: Lesson = {
      id: "lsn_old_one", content: "stale cobalt notion", context: "", confidence: 0.12, reinforcements: 0, source: "manual", sourceIds: [], tags: [],
      createdAt: new Date(Date.now() - 70 * 86_400_000).toISOString(), updatedAt: "2026-01-01T00:00:00.000Z", decayRate: 0.05,
    };
    await lkv.kv.set("mem:lessons", old.id, old);
    await disk.lessons.resetLessonIndex([old.id]);
    await settle();
    expect(await recall("cobalt")).toEqual([old.id]);
    const swept = (await sdk.trigger("mem::lesson-decay-sweep", {})) as { softDeleted: number };
    await settle();
    expect(swept.softDeleted).toBe(1);
    expect(await recall("cobalt")).toEqual([]);

    const imported: Lesson = { ...old, id: "lsn_imported", content: "imported zirconium note", createdAt: new Date().toISOString(), confidence: 0.7, deleted: false };
    await lkv.kv.set("mem:lessons", imported.id, imported);
    await lkv.kv.delete("mem:lessons", a.id);
    await disk.lessons.resetLessonIndex([imported.id, a.id]);
    await settle();
    expect(await recall("zirconium")).toEqual([imported.id]);
    expect(await recall("quartz")).toEqual([]);
    expect((await engines.lessons.stats()).lessons).toBe(1);
    expect(lkv.listed.filter((scope) => scope === "mem:lessons").length).toBe(1);
    (runtime as unknown as { stats: { stop(): void } }).stats.stop();
  }, 60_000);
});

describe.skipIf(!QDRANT_URL)("image search through the images collection", () => {
  const rand = mulberry32(512);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const unit = (v: Float32Array) => {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / n);
  };
  const randomVector = () => unit(Float32Array.from({ length: IMAGE_DIMS }, gauss));
  const noisy = (v: Float32Array, sigma: number) => unit(Float32Array.from(v, (x) => x + sigma * gauss() / Math.sqrt(IMAGE_DIMS)));

  const refs = Array.from({ length: 120 }, (_, i) => `${IMAGES_DIR}/img_${String(i).padStart(3, "0")}.png`);
  const vectors = new Map(refs.map((ref) => [ref, randomVector()]));
  const sessionOf = (i: number) => (i % 7 === 0 ? undefined : i % 2 === 0 ? "ses_even" : "ses_odd");
  const queryVectors = new Map(Array.from({ length: 12 }, (_, i) => [`q${i}`, noisy(vectors.get(refs[i * 9]!)!, 0.8)]));

  const provider: EmbeddingProvider = {
    name: "stub-clip",
    dimensions: IMAGE_DIMS,
    embed: async (text: string) => queryVectors.get(text)!,
    embedBatch: async (texts: string[]) => texts.map((t) => queryVectors.get(t)!),
    embedImage: async (ref: string) => vectors.get(ref) ?? randomVector(),
  } as unknown as EmbeddingProvider;

  type SearchResult = { success: boolean; results: Array<{ imageRef: string; score: number; sessionId?: string; observationId?: string; updatedAt: string }>; total: number };
  const { qdrants, engines } = makeEngines();

  afterAll(async () => {
    await Promise.all(Object.values(qdrants).map((q) => q.drop()));
  }, 60_000);

  async function run(backend: "memory" | "disk") {
    const m = await loadModules();
    const kv = mockKV();
    const runtime = m.ports.createSearchRuntime(
      { kv: kv as never, embeddingProvider: null, ...(backend === "disk" ? { sdk: workerSdk(engines).sdk } : {}) },
      backend,
    );
    const sdk = mockSdk({ looseTrigger: true });
    m.vision.registerVisionSearchFunctions(sdk as never, kv as never, provider);
    for (const [i, ref] of refs.entries()) {
      await m.imageRefs.incrementImageRef(kv as never, ref);
      const embedded = (await sdk.trigger("mem::vision-embed", { imageRef: ref, sessionId: sessionOf(i), observationId: `obs_${i}` })) as { success: boolean };
      expect(embedded.success).toBe(true);
    }
    return { m, kv, sdk, runtime };
  }

  it("returns memory mode's exact cosine top-K at 512 dimensions, with session filters and totals", async () => {
    const mem = await run("memory");
    const disk = await run("disk");
    await disk.runtime.openPersistence().save();
    const kvReads: string[] = [];
    const diskKvList = disk.kv.list;
    disk.kv.list = async <T>(scope: string) => {
      kvReads.push(scope);
      return diskKvList<T>(scope);
    };

    const stored = new Map<string, string>();
    for (const ref of refs) stored.set(ref, (await disk.kv.get<{ updatedAt: string }>("mem:image-embeddings", ref))!.updatedAt);
    for (const queryText of queryVectors.keys()) {
      for (const sessionId of [undefined, "ses_even", "ses_odd"]) {
        const want = (await mem.sdk.trigger("mem::vision-search", { queryText, topK: 10, sessionId })) as SearchResult;
        const got = (await disk.sdk.trigger("mem::vision-search", { queryText, topK: 10, sessionId })) as SearchResult;
        const label = `${queryText} ${sessionId ?? "any"}`;
        expect(got.success, label).toBe(true);
        expect(got.total, label).toBe(want.total);
        expect(got.results.map((r) => r.imageRef), label).toEqual(want.results.map((r) => r.imageRef));
        got.results.forEach((r, i) => {
          expect(r.score, label).toBeCloseTo(want.results[i]!.score, 4);
          expect(r.sessionId, label).toBe(want.results[i]!.sessionId);
          expect(r.observationId, label).toBe(want.results[i]!.observationId);
          expect(r.updatedAt, label).toBe(stored.get(r.imageRef));
        });
      }
    }
    expect(kvReads.filter((scope) => scope === "mem:image-embeddings")).toEqual([]);
    (disk.runtime as unknown as { stats: { stop(): void } }).stats.stop();
  }, 120_000);

  it("removing the last reference drops the image from search", async () => {
    const disk = await run("disk");
    const target = refs[18]!;
    const queryText = "q2";
    const before = (await disk.sdk.trigger("mem::vision-search", { queryText, topK: 3 })) as SearchResult;
    expect(before.results[0]!.imageRef).toBe(target);
    await disk.m.imageRefs.decrementImageRef(disk.kv as never, { trigger: async () => undefined } as never, target);
    const after = (await disk.sdk.trigger("mem::vision-search", { queryText, topK: 3 })) as SearchResult;
    expect(after.results.map((r) => r.imageRef)).not.toContain(target);
    expect(after.total).toBe(before.total - 1);
    (disk.runtime as unknown as { stats: { stop(): void } }).stats.stop();
  }, 120_000);

  it("reports a worker failure instead of an empty result", async () => {
    const m = await loadModules();
    const kv = mockKV();
    const sdk = { trigger: async () => { throw new Error("worker unreachable"); } };
    const runtime = m.ports.createSearchRuntime({ kv: kv as never, embeddingProvider: null, sdk: sdk as never }, "disk");
    const fns = mockSdk({ looseTrigger: true });
    m.vision.registerVisionSearchFunctions(fns as never, kv as never, provider);
    const res = (await fns.trigger("mem::vision-search", { queryText: "q0" })) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/image search unavailable.*worker unreachable/);
    (runtime as unknown as { stats: { stop(): void } }).stats.stop();
  }, 30_000);
});

describe.skipIf(!QDRANT_URL)("image engine versions and routing", () => {
  const qdrant = qdrantFor(`${base}_versions`, 4, "image");
  const engine = new ImageEngine(qdrant);
  const client = imageEngineClient(engine);
  const text = qdrantFor(`${base}_versions_text`);
  const textEngine = new SearchEngine(text, DEFAULT_AVGDL);
  const vec = (...xs: number[]) => float32ToBase64(Float32Array.from(xs));
  const imgOp = (id: string, f32b64: string, extra: Record<string, unknown> = {}): Op =>
    ({ k: "img", id, sessionId: "ses_1", f32b64, updatedAt: "2026-11-01T00:00:00.000Z", ...extra }) as Op;
  const search = async (...xs: number[]) => client.imageQuery(vec(...xs), 10);

  afterAll(async () => {
    await Promise.all([qdrant.drop(), text.drop()]);
  }, 30_000);

  it("a late older img cannot resurrect a deleted image", async () => {
    await client.apply([imgOp("revived", vec(1, 0, 0, 0))], 100);
    await client.apply([{ k: "del", id: "revived" }], 200);
    await client.apply([imgOp("revived", vec(1, 0, 0, 0))], 150);
    const res = await search(1, 0, 0, 0);
    expect(res.hits.map((h) => h.id)).not.toContain("revived");
    expect(res.total).toBe(0);
  });

  it("a newer img brings a deleted image back, and a late older del does not remove a newer img", async () => {
    await client.apply([imgOp("again", vec(0, 1, 0, 0))], 300);
    await client.apply([{ k: "del", id: "again" }], 400);
    await client.apply([imgOp("again", vec(0, 1, 0, 0))], 500);
    expect((await search(0, 1, 0, 0)).hits.map((h) => h.id)).toContain("again");
    await client.apply([{ k: "del", id: "again" }], 450);
    expect((await search(0, 1, 0, 0)).hits.map((h) => h.id)).toContain("again");
  });

  it("a newer img replaces the vector and metadata, and an older one does not", async () => {
    await client.apply([imgOp("moved", vec(0, 0, 1, 0), { sessionId: "ses_a", observationId: "obs_1" })], 600);
    await client.apply([imgOp("moved", vec(0, 0, 0, 1), { sessionId: "ses_b" })], 700);
    await client.apply([imgOp("moved", vec(0, 0, 1, 0), { sessionId: "ses_a" })], 650);
    const near = (await search(0, 0, 0, 1)).hits.find((h) => h.id === "moved")!;
    expect(near.score).toBeCloseTo(1, 5);
    expect(near.sessionId).toBe("ses_b");
    expect(near.observationId).toBeUndefined();
    expect((await client.imageQuery(vec(0, 0, 0, 1), 10, "ses_a")).hits.map((h) => h.id)).not.toContain("moved");
  });

  it("a deleted image keeps no vector", async () => {
    await client.apply([imgOp("gone", vec(1, 1, 0, 0))], 800);
    await client.apply([{ k: "del", id: "gone" }], 900);
    const { pointId } = await import("../src/fork/worker/qdrant.js");
    const [point] = await qdrant.call<Array<{ payload: { deleted?: boolean }; vector?: unknown }>>("POST", `${qdrant.path}/points`, { ids: [pointId("gone")], with_payload: true, with_vector: true });
    expect(point!.payload.deleted).toBe(true);
    expect(point!.vector === undefined || Object.keys(point!.vector as object).length === 0).toBe(true);
  });

  it("reports malformed and misrouted ops per id", async () => {
    const res = await client.apply(
      [
        imgOp("short", vec(1, 0)),
        imgOp("odd", "AAAAAA=="),
        imgOp("nan", float32ToBase64(Float32Array.from([1, Number.NaN, 0, 0]))),
        { k: "vec", id: "v", rev: "r", f32b64: vec(1, 0, 0, 0) },
        { k: "doc", id: "d" },
        imgOp("fine", vec(1, 0, 0, 1)),
      ] as Op[],
      1000,
    );
    expect(res.failed.map((f) => f.id).sort()).toEqual(["d", "nan", "odd", "short", "v"]);
    expect((await search(1, 0, 0, 1)).hits.map((h) => h.id)).toContain("fine");
  });

  it("a text collection reports an img op per id and an image query is rejected by routing", async () => {
    const res = await textEngine.apply([imgOp("x", vec(1, 0, 0, 0))] as unknown[], 10);
    expect(res.failed).toHaveLength(1);
    expect(res.applied).toBe(0);
    const handlers = createSearchHandlers({ docs: textEngine, lessons: textEngine, images: engine }, 6);
    await expect((handlers[SEARCH_FN.imageQuery] as (d: unknown) => Promise<unknown>)({ f32b64: vec(1, 0, 0, 0), limit: 3 })).rejects.toThrow(/images collection/);
    await expect((handlers[SEARCH_FN.keyword] as (d: unknown) => Promise<unknown>)({ query: "x", limit: 3, collection: "images" })).rejects.toThrow(/images/);
  });

  it("rejects a query vector of the wrong length", async () => {
    await expect(client.imageQuery(vec(1, 0), 3)).rejects.toThrow(/does not match dimensions/);
  });

  it("reads the highest stored version after a restart", async () => {
    const restarted = imageEngineClient(new ImageEngine(qdrant));
    expect(await restarted.maxVersion!()).toBeGreaterThanOrEqual(1000);
  });
});

// TEE-1196: reconcile repairs the lessons and images collections from their records after an outage dropped writes.
// Unit cases always run; the Qdrant cases need QDRANT_URL:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-collection-reconcile.test.ts
import { afterAll, describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { ImageEngine } from "../src/fork/worker/image-engine.js";
import { pointId, type Qdrant } from "../src/fork/worker/qdrant.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../src/fork/search/runtime.js";
import type { SearchWorkerClient } from "../src/fork/search/client.js";
import { searchBackendProblems, type SearchBackendStatus } from "../src/fork/search/backend-status.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SEARCH_FN } from "../src/fork/search/protocol.js";
import { createSearchHandlers } from "../src/fork/worker/router.js";
import { BackendHealth } from "../src/fork/search/health.js";
import { CollectionReconciler, type CollectionRecords } from "../src/fork/search/collection-reconcile.js";
import { setEmbeddingProvider } from "../src/functions/search.js";
import { lessonToObservation } from "../src/state/memory-utils.js";
import { KV } from "../src/state/schema.js";
import type { ImageEmbedding } from "../src/state/search-ports.js";
import type { EmbeddingProvider, Lesson } from "../src/types.js";
import { DIMS, engineClient, imageEngineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";
import { mockKV } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const NO_TIMERS = { reconcileIntervalMs: 0, sweepPerPass: 3, reembedPerMinute: 0 };
/** Above the outbox's 5000-op cap, so an outage drops the oldest writes. */
const BURST = 5100;
const KV_PAGE = 64;

const lesson = (id: string, content: string, extra: Partial<Lesson> = {}): Lesson => ({
  id, content, context: "", confidence: 0.6, reinforcements: 0, source: "manual", sourceIds: [], project: "p", tags: [],
  createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z", decayRate: 0.05, ...extra,
});

const image = (ref: string, seed: number, updatedAt = "2026-11-19T00:00:00.000Z"): ImageEmbedding => ({
  imageRef: ref, vector: Array.from({ length: DIMS }, (_, d) => Math.fround(Math.sin(seed * 7 + d) + 1.5)), modelName: "clip-test",
  dimensions: DIMS, updatedAt, sessionId: `ses_${seed % 3}`, observationId: seed % 2 ? `obs_${seed}` : undefined,
});

/** The KV the reconciler sees: paged reads only; a whole read of the lessons or images scope fails the test. */
function pagedKV() {
  const kv = mockKV();
  const whole = new Set([KV.lessons, KV.imageEmbeddings]);
  const list = kv.list;
  return Object.assign(kv, {
    list: async <T>(scope: string): Promise<T[]> => {
      if (whole.has(scope)) throw new Error(`whole read of ${scope}`);
      return list<T>(scope);
    },
    async *iterate<T>(scope: string): AsyncGenerator<T[]> {
      const rows = [...(kv.store.get(scope)?.values() ?? [])] as T[];
      for (let i = 0; i < rows.length; i += KV_PAGE) yield rows.slice(i, i + KV_PAGE);
    },
    getMany: async <T>(scope: string, keys: string[]): Promise<Array<T | null>> => keys.map((k) => (kv.store.get(scope)?.get(k) as T) ?? null),
  });
}

describe("collection problems on the status page", () => {
  const collection = (missing: number | null, extra: number | null, state: "idle" | "off" = "idle") => ({
    state: "healthy" as const, reason: null, pendingWrites: 0, droppedWrites: 0, missing, extra,
    reconcile: { state, startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null },
  });
  const base: SearchBackendStatus = {
    backend: "disk", state: "healthy", reason: null, since: "", documents: 0, vectors: 0, pendingWrites: 0, droppedWrites: 0,
    missingDocuments: 0, missing: { observations: 0, memories: 0 }, missingVectors: null,
    reconcile: { state: "idle", startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null },
    reembed: { state: "off", perMinute: 0, embedded: 0, failed: 0 },
  };

  it("names each collection that differs from its records, and nothing when they match", () => {
    expect(searchBackendProblems({ ...base, collections: { lessons: collection(0, 0), images: collection(null, null) } })).toEqual([]);
    const problems = searchBackendProblems({ ...base, collections: { lessons: collection(2, 1), images: collection(0, 3, "off") } });
    expect(problems.map((p) => [p.code, p.level])).toEqual([["search-collection-differs", "warn"], ["search-collection-differs", "warn"]]);
    expect(problems[0]!.message).toContain("lessons search collection differs from the records: 2 missing or outdated, 1 with no record");
    expect(problems[1]!.fix).toContain("AM_SEARCH_RECONCILE_INTERVAL_MS");
  });

  it("counts writes the collections dropped with the docs ones", () => {
    const dropped = { ...collection(0, 0), droppedWrites: 7 };
    expect(searchBackendProblems({ ...base, droppedWrites: 1, collections: { lessons: dropped } }).find((p) => p.code === "search-writes-dropped")?.message).toMatch(/^8 /);
  });
});

describe("collection reconcile fix round (ocr)", () => {
  /** 2500 records the index lacks: three repair pages. */
  function collectionRig(onRepair: (page: number) => void) {
    const health = new BackendHealth();
    const pages: string[][] = [];
    const records: CollectionRecords = {
      wanted: async () => new Map(Array.from({ length: 2500 }, (_, i) => [`id_${i}`, "r"])),
      repair: async (_kv, ids) => {
        pages.push([...ids]);
        onRepair(pages.length);
      },
    };
    const outbox = { drainFor: async () => {}, pending: 0, counters: { spilled: 0 } };
    const client = { scanEntries: async () => ({ items: [] }), health: async () => ({ ok: true }) };
    const c = new CollectionReconciler("lessons", { client: client as never, health, outbox: outbox as never, records });
    return { c, health, pages };
  }

  it("stops repairing and reports paused-degraded when the backend degrades between pages (#5)", async () => {
    const { c, health, pages } = collectionRig(() => health.reportFailure(new Error("worker gone")));
    await c.run(mockKV() as never, () => false);
    expect(pages).toHaveLength(1);
    expect(c.status().reconcile).toMatchObject({ state: "paused-degraded", added: 1000, finishedAt: null });
  });

  it("does not report a pass cut short by stop as finished, and counts only the repairs it sent (#9)", async () => {
    let stopped = false;
    const { c, pages } = collectionRig(() => (stopped = true));
    await c.run(mockKV() as never, () => stopped);
    expect(pages).toHaveLength(1);
    expect(c.status().reconcile.state).not.toBe("idle");
    expect(c.status().reconcile).toMatchObject({ added: 1000, deleted: 0, finishedAt: null });
  });

  it("reports a collection whose reconcile keeps failing (#8)", () => {
    const failing = {
      state: "healthy" as const, reason: null, pendingWrites: 0, droppedWrites: 0, missing: 3, extra: 0,
      reconcile: { state: "idle" as const, startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: "scan failed" },
    };
    const status = {
      backend: "disk" as const, state: "healthy" as const, reason: null, since: "", documents: 0, vectors: 0, pendingWrites: 0, droppedWrites: 0,
      missingDocuments: 0, missing: { observations: 0, memories: 0 }, missingVectors: null,
      reconcile: { state: "idle" as const, startedAt: null, finishedAt: null, durationMs: null, checked: 0, added: 0, deleted: 0, error: null },
      reembed: { state: "off" as const, perMinute: 0, embedded: 0, failed: 0 },
      collections: { images: failing },
    };
    const problem = searchBackendProblems(status).find((p) => p.code === "search-collection-reconcile-failing");
    expect(problem).toMatchObject({ level: "warn" });
    expect(problem?.message).toContain("images");
    expect(problem?.message).toContain("scan failed");
  });
});

describe("search::scan-entries routing", () => {
  it("serves the lessons and images collections and refuses docs", async () => {
    const served = (name: string) => ({ scanEntries: async () => ({ items: [{ id: name, rev: "r" }] }) });
    const handlers = createSearchHandlers({ docs: served("docs"), lessons: served("lessons"), images: served("images") } as never, 6);
    const scan = handlers[SEARCH_FN.scanEntries] as (data: unknown) => Promise<{ items: Array<{ id: string }> }>;
    expect((await scan({ collection: "lessons", limit: 10 })).items[0]!.id).toBe("lessons");
    expect((await scan({ collection: "images", limit: 10 })).items[0]!.id).toBe("images");
    await expect(scan({ limit: 10 })).rejects.toThrow(/not served by the docs collection/);
  });
});

// ---------------------------------------------------------------- live Qdrant

interface Rig {
  qdrants: Qdrant[];
  lessonsEngine: SearchEngine;
  imagesQ: Qdrant;
  imagesEngine: ImageEngine;
  runtime: DiskSearchRuntime;
  kv: ReturnType<typeof pagedKV>;
  down: { value: boolean };
  gates: { lessons: Gate; images: Gate };
}
interface Gate { held: Promise<void> | null }
const rigs: Rig[] = [];

/** Every worker call fails while `down` is set; collection writes wait while `gate.held` is set. */
function switched(live: SearchWorkerClient, down: { value: boolean }, gate?: Gate): SearchWorkerClient {
  return Object.fromEntries(
    Object.entries(live).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        if (down.value) throw new Error("connect ECONNREFUSED am-search");
        if (name === "apply" && gate?.held) await gate.held;
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as SearchWorkerClient;
}

async function rig(): Promise<Rig> {
  const base = `t1196_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const docsQ = qdrantFor(`${base}`);
  const lessonsQ = qdrantFor(`${base}_lessons`, DIMS, "lessons");
  const imagesQ = qdrantFor(`${base}_images`, DIMS, "image");
  const docsEngine = new SearchEngine(docsQ, DEFAULT_AVGDL);
  const lessonsEngine = new SearchEngine(lessonsQ, DEFAULT_AVGDL);
  const imagesEngine = new ImageEngine(imagesQ);
  const down = { value: false };
  const gates: Rig["gates"] = { lessons: { held: null }, images: { held: null } };
  const runtime = createDiskSearchRuntime(switched(engineClient(docsEngine), down), false, DIMS, {
    lessons: switched(engineClient(lessonsEngine), down, gates.lessons),
    images: switched(imageEngineClient(imagesEngine), down, gates.images),
  }, NO_TIMERS);
  const r: Rig = { qdrants: [docsQ, lessonsQ, imagesQ], lessonsEngine, imagesQ, imagesEngine, runtime, kv: pagedKV(), down, gates };
  r.runtime.reconciler.start(r.kv as never);
  rigs.push(r);
  return r;
}

async function scanAll(scan: (cursor: string | undefined) => Promise<{ items: Array<{ id: string; rev: string }>; next?: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await scan(cursor);
    for (const item of page.items) out.set(item.id, item.rev);
    cursor = page.next;
  } while (cursor);
  return out;
}

/** What each collection holds against what its records want, computed here without the reconciler. */
async function truth(r: Rig) {
  const lessonsIndexed = await scanAll((c) => r.lessonsEngine.scanEntries(c, 1000));
  const imagesIndexed = await scanAll((c) => r.imagesEngine.scanEntries(c, 1000));
  const lessonsWanted = new Set([...(r.kv.store.get(KV.lessons)?.values() ?? [])].filter((l) => !(l as Lesson).deleted).map((l) => (l as Lesson).id));
  const imagesWanted = new Set(r.kv.store.get(KV.imageEmbeddings)?.keys() ?? []);
  return { lessonsIndexed, imagesIndexed, lessonsWanted, imagesWanted };
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

async function saveLesson(r: Rig, l: Lesson): Promise<void> {
  await r.kv.set(KV.lessons, l.id, l);
  if (l.deleted) r.runtime.lessons!.remove(l.id);
  else r.runtime.lessons!.addIfChanged(lessonToObservation(l), "lesson");
}

async function saveImage(r: Rig, e: ImageEmbedding): Promise<void> {
  await r.kv.set(KV.imageEmbeddings, e.imageRef, e);
  r.runtime.images!.put(e);
}

async function removeImage(r: Rig, ref: string): Promise<void> {
  await r.kv.delete(KV.imageEmbeddings, ref);
  r.runtime.images!.remove(ref);
}

async function drainAll(r: Rig, ms = 60_000): Promise<void> {
  await Promise.all(r.runtime.outboxes.map((o) => o.drainFor(ms)));
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterAll(async () => {
  setEmbeddingProvider(null);
  for (const r of rigs) {
    await r.runtime.service.stop();
    r.runtime.stats.stop();
    for (const outbox of r.runtime.outboxes) await outbox.stop(100);
    for (const q of r.qdrants) await q.drop();
  }
});

describe.skipIf(!QDRANT_URL)("lessons and images collections after an outage that dropped writes (live Qdrant)", () => {
  it("match the records again with no manual step, report the gap on the status page, and copy image vectors without embedding", async () => {
    let embedCalls = 0;
    const count = async () => {
      embedCalls++;
      throw new Error("reconcile must not embed");
    };
    setEmbeddingProvider({ name: "counting", dimensions: DIMS, embed: count, embedBatch: count, embedImage: count } as unknown as EmbeddingProvider);

    const r = await rig();
    for (let i = 0; i < 30; i++) await saveLesson(r, lesson(`lsn_seed_${i}`, `seed lesson ${i} about qdrant reconcile topic${i}`));
    for (let i = 0; i < 20; i++) await saveImage(r, image(`img/seed_${i}.png`, i));
    await drainAll(r);
    await r.runtime.reconciler.runPass();
    const clean = await r.runtime.service.status();
    expect(clean.collections?.lessons).toMatchObject({ missing: 0, extra: 0, droppedWrites: 0 });
    expect(clean.collections?.images).toMatchObject({ missing: 0, extra: 0, droppedWrites: 0 });

    // Outage: the first failed flush arms the cap, then the oldest writes past it are dropped.
    r.down.value = true;
    await saveLesson(r, lesson("lsn_seed_0", "seed lesson 0 rewritten during the outage"));
    await saveImage(r, image("img/seed_0.png", 100, "2026-11-19T01:00:00.000Z"));
    await drainAll(r, 300);
    await r.kv.delete(KV.lessons, "lsn_seed_1");
    r.runtime.lessons!.remove("lsn_seed_1");
    await saveLesson(r, lesson("lsn_seed_2", "seed lesson 2 about qdrant reconcile topic2", { deleted: true }));
    await saveLesson(r, lesson("lsn_seed_3", "seed lesson 3 edited while the worker was down"));
    await removeImage(r, "img/seed_1.png");
    await saveImage(r, image("img/seed_2.png", 102, "2026-11-19T01:00:00.000Z"));
    for (let i = 0; i < BURST; i++) await saveLesson(r, lesson(`lsn_burst_${i}`, `burst lesson ${i} written while the worker was down`));
    for (let i = 0; i < BURST; i++) await saveImage(r, image(`img/burst_${i}.png`, 1000 + i));

    const during = await r.runtime.service.status();
    expect(during.collections?.lessons?.state).toBe("degraded");
    expect(during.collections?.images?.state).toBe("degraded");
    expect(during.collections?.lessons?.droppedWrites).toBeGreaterThan(0);
    expect(during.collections?.images?.droppedWrites).toBeGreaterThan(0);

    // Recovery: what was still queued lands; the dropped writes do not.
    r.down.value = false;
    await waitFor(() => r.runtime.service.status(), (s) => s.collections?.lessons?.state === "healthy" && s.collections?.images?.state === "healthy");
    await drainAll(r);
    const gap = await truth(r);
    const lessonsMissing = [...gap.lessonsWanted].filter((id) => !gap.lessonsIndexed.has(id));
    const lessonsExtra = [...gap.lessonsIndexed.keys()].filter((id) => !gap.lessonsWanted.has(id));
    const imagesMissing = [...gap.imagesWanted].filter((id) => !gap.imagesIndexed.has(id));
    const imagesExtra = [...gap.imagesIndexed.keys()].filter((id) => !gap.imagesWanted.has(id));
    expect(lessonsMissing.length).toBeGreaterThan(0);
    expect(sorted(lessonsExtra)).toEqual(["lsn_seed_1", "lsn_seed_2"]);
    expect(imagesMissing.length).toBeGreaterThan(0);
    expect(imagesExtra).toEqual(["img/seed_1.png"]);

    // The status page during the gap: each collection's repairs wait at its gate while the page is read.
    const hold = (gate: Gate) => {
      let release!: () => void;
      gate.held = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate.held = null;
        release();
      };
    };
    const releaseLessons = hold(r.gates.lessons);
    const releaseImages = hold(r.gates.images);
    const pass = r.runtime.reconciler.runPass();
    const lessonsGap = await waitFor(() => r.runtime.service.status(), (s) => s.collections?.lessons?.reconcile.state === "running" && !!s.collections.lessons.missing);
    // Stale: seed_0 and seed_3 (lessons), seed_0 and seed_2 (images) were rewritten and those writes were dropped.
    expect(lessonsGap.collections?.lessons).toMatchObject({ missing: lessonsMissing.length + 2, extra: 2 });
    expect(searchBackendProblems(lessonsGap).find((p) => p.code === "search-collection-differs")?.message).toContain("lessons search collection differs");
    releaseLessons();
    const imagesGap = await waitFor(() => r.runtime.service.status(), (s) => s.collections?.images?.reconcile.state === "running" && !!s.collections.images.missing);
    expect(imagesGap.collections?.images).toMatchObject({ missing: imagesMissing.length + 2, extra: 1 });
    expect(searchBackendProblems(imagesGap).find((p) => p.code === "search-collection-differs")?.message).toContain("images search collection differs");
    releaseImages();
    await pass;

    const after = await truth(r);
    const lessonRows = [...r.kv.store.get(KV.lessons)!.values()] as Lesson[];
    expect(sorted(after.lessonsIndexed.keys())).toEqual(sorted(after.lessonsWanted));
    expect(sorted(after.imagesIndexed.keys())).toEqual(sorted(after.imagesWanted));
    expect(after.lessonsIndexed.size).toBe(30 - 2 + BURST);
    expect(after.imagesIndexed.size).toBe(20 - 1 + BURST);
    const healed = await r.runtime.service.status();
    expect(healed.collections?.lessons).toMatchObject({ missing: 0, extra: 0, reconcile: { error: null } });
    expect(healed.collections?.images).toMatchObject({ missing: 0, extra: 0, reconcile: { error: null } });
    expect(searchBackendProblems(healed).map((p) => p.code)).not.toContain("search-collection-differs");

    // Contents: the edited lessons are found by their new text, the removed ones are not found at all.
    expect(lessonRows.filter((l) => !l.deleted).length).toBe(after.lessonsIndexed.size);
    const recall = async (q: string) => (await r.runtime.lessons!.search(q, 10, "all")).map((h) => h.obsId);
    expect(await recall("edited while the worker was down")).toContain("lsn_seed_3");
    expect(await recall("rewritten during the outage")).toContain("lsn_seed_0");
    expect(await recall("topic1")).not.toContain("lsn_seed_1");
    expect(await recall("topic2")).not.toContain("lsn_seed_2");

    // Image vectors: each repaired entry holds exactly the stored vector, with its metadata.
    const repaired = ["img/seed_0.png", "img/seed_2.png", ...imagesMissing.slice(0, 50)];
    const points = await r.imagesQ.call<Array<{ vector: { image: number[] }; payload: { doc_id: string; updated_at: string; session_id: string } }>>(
      "POST", `${r.imagesQ.path}/points`, { ids: repaired.map(pointId), with_payload: true, with_vector: ["image"] },
    );
    expect(points).toHaveLength(repaired.length);
    for (const p of points) {
      const stored = (await r.kv.get<ImageEmbedding>(KV.imageEmbeddings, p.payload.doc_id))!;
      expect(p.payload).toMatchObject({ updated_at: stored.updatedAt, session_id: stored.sessionId });
      const norm = Math.hypot(...stored.vector);
      p.vector.image.forEach((v, d) => expect(v).toBeCloseTo(stored.vector[d]! / norm, 5));
    }
    expect(embedCalls).toBe(0);
  }, 240_000);
});

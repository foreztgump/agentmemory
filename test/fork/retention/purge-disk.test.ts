// Slice 7, images in disk mode against a live Qdrant (TEE-1196's images collection and reconciler). Skipped unless QDRANT_URL is set:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork/retention/purge-disk.test.ts
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

const decrementImageRef = vi.hoisted(() => vi.fn());
vi.mock("../../../src/functions/image-refs.js", () => ({ decrementImageRef }));

import { restoreRun } from "../../../src/fork/retention/restore.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../../../src/fork/search/runtime.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { ImageEngine } from "../../../src/fork/worker/image-engine.js";
import type { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { setEmbeddingProvider, setVectorIndex } from "../../../src/functions/search.js";
import { createSearchRuntime, registerSearchBackend } from "../../../src/state/search-ports.js";
import { KV } from "../../../src/state/schema.js";
import type { StateKV } from "../../../src/state/kv.js";
import type { ImageEmbedding } from "../../../src/state/search-ports.js";
import type { EmbeddingProvider } from "../../../src/types.js";
import { DIMS, engineClient, imageEngineClient, QDRANT_URL, qdrantFor } from "../../helpers/search-engine.js";
import { candidate, observation, rig, seedObservation, seedSeal, type Rig } from "./move-fixtures.js";
import { at, clocked, closedRun, done, purge } from "./purge-fixtures.js";

const NO_TIMERS = { reconcileIntervalMs: 0, sweepPerPass: 3, reembedPerMinute: 0 };
const PATH = "/img/disk.png";
let embedCalls = 0;
const count = async () => {
  embedCalls++;
  throw new Error("purge and reconcile must not embed");
};

interface DiskRig { qdrants: Qdrant[]; imagesEngine: ImageEngine; runtime: DiskSearchRuntime; r: Rig }
const rigs: DiskRig[] = [];

async function diskRig(): Promise<DiskRig> {
  const base = `ret_img_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const docsQ = qdrantFor(base);
  const lessonsQ = qdrantFor(`${base}_lessons`, DIMS, "lessons");
  const imagesQ = qdrantFor(`${base}_images`, DIMS, "image");
  await docsQ.ensure();
  const docsEngine = new SearchEngine(docsQ, DEFAULT_AVGDL);
  const lessonsEngine = new SearchEngine(lessonsQ, DEFAULT_AVGDL);
  const imagesEngine = new ImageEngine(imagesQ);
  const runtime = createDiskSearchRuntime(engineClient(docsEngine), true, DIMS, { lessons: engineClient(lessonsEngine), images: imageEngineClient(imagesEngine) }, NO_TIMERS);
  registerSearchBackend("disk", () => runtime);
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "disk");
  setVectorIndex(runtime.vector);
  const provider = { name: "counting", dimensions: DIMS, embed: count, embedBatch: count, embedImage: count } as unknown as EmbeddingProvider;
  setEmbeddingProvider(provider);
  const r = rig(() => runtime);
  runtime.reconciler.start(r.kv as never);
  const d = { qdrants: [docsQ, lessonsQ, imagesQ], imagesEngine, runtime, r };
  rigs.push(d);
  return d;
}

const embedding = (): ImageEmbedding => ({
  imageRef: PATH, vector: Array.from({ length: DIMS }, (_, i) => Math.fround(Math.sin(i + 1) + 1.5)), modelName: "clip-test", dimensions: DIMS,
  updatedAt: "2026-04-01T00:00:00.000Z", sessionId: "ses_d", observationId: "d1",
});

async function indexedImages(d: DiskRig): Promise<string[]> {
  await Promise.all(d.runtime.outboxes.map((outbox) => outbox.drainFor(10_000)));
  return (await d.imagesEngine.scanEntries(undefined, 1000)).items.map((entry) => entry.id).sort();
}

async function reconcile(d: DiskRig) {
  await d.runtime.reconciler.runPass();
  return (await d.runtime.service.status()).collections?.images;
}

async function fakeDecrement(kv: StateKV, _sdk: unknown, path: string): Promise<void> {
  await kv.delete(KV.imageEmbeddings, path);
  (await import("../../../src/state/search-ports.js")).getSearchRuntime().images?.remove(path);
  await kv.delete(KV.imageRefs, path);
}

async function world(d: DiskRig) {
  const { r } = d;
  const row = embedding();
  await r.kv.set(KV.imageRefs, PATH, 1);
  await r.kv.set(KV.imageEmbeddings, PATH, row);
  d.runtime.images!.put(row);
  expect(await indexedImages(d)).toEqual([PATH]);
  const o = await seedObservation(r, observation("d1", "ses_d", { imageData: PATH }), { indexed: false });
  const seal = await seedSeal(r, "ses_d", 1);
  await closedRun(r, "ret_a" as never, [await candidate(r, "O", o, seal)]);
  return row;
}

afterEach(() => {
  decrementImageRef.mockReset();
  decrementImageRef.mockImplementation(fakeDecrement);
});
afterAll(async () => {
  setEmbeddingProvider(null);
  setVectorIndex(null);
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "memory");
  for (const d of rigs) {
    await d.runtime.service.stop();
    d.runtime.stats.stop();
    for (const outbox of d.runtime.outboxes) await outbox.stop(100);
    for (const q of d.qdrants) await q.drop();
  }
}, 60_000);

describe.skipIf(!QDRANT_URL)("disk mode: the images collection and TEE-1196's reconciler", () => {
  it("R8: after a move, a reconcile pass does not repair the image back, and a restore puts it back without embedding", async () => {
    const d = await diskRig();
    decrementImageRef.mockImplementation(fakeDecrement);
    const row = await world(d);

    expect(await indexedImages(d)).toEqual([]);
    expect(await d.r.kv.get(KV.imageEmbeddings, PATH)).toBeNull();
    expect(await reconcile(d)).toMatchObject({ missing: 0, extra: 0 });
    expect(await indexedImages(d)).toEqual([]);
    expect(await d.r.kv.get(KV.imageEmbeddings, PATH)).toBeNull();

    const { deps } = clocked(d.r);
    expect(await restoreRun(deps, "ret_a" as never, "test")).toMatchObject({ restored: 1 });
    expect(await d.r.kv.get(KV.imageEmbeddings, PATH)).toEqual(row);
    expect(await indexedImages(d)).toEqual([PATH]);
    expect(await reconcile(d)).toMatchObject({ missing: 0, extra: 0 });
    expect(await indexedImages(d)).toEqual([PATH]);
    expect(embedCalls).toBe(0);
  }, 60_000);

  it("R4: after purge the image is gone from the records and the index, and the next reconcile pass finds nothing to repair", async () => {
    const d = await diskRig();
    decrementImageRef.mockImplementation(fakeDecrement);
    await world(d);
    const { clock, deps } = clocked(d.r);
    clock.now = at(25);

    expect(done(await purge(deps))).toMatchObject({ purged: 1, runsEmptied: 1 });

    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(await d.r.kv.get(KV.imageEmbeddings, PATH)).toBeNull();
    expect(await d.r.kv.get(KV.imageRefs, PATH)).toBeNull();
    expect(await d.r.kv.get(KV.retentionImageHolds, PATH)).toBeNull();
    expect(await indexedImages(d)).toEqual([]);
    expect(await reconcile(d)).toMatchObject({ missing: 0, extra: 0 });
    expect(await indexedImages(d)).toEqual([]);
    expect(embedCalls).toBe(0);
  }, 60_000);
});

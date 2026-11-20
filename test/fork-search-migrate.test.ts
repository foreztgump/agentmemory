import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  f16round,
  FetchGuard,
  halfSteps,
  fill,
  MARKER_KEY,
  MigrateError,
  MIGRATION_VERSION,
  planVectors,
  type Targets,
  verify,
  waitForOptimizer,
} from "../scripts/fork/search-migrate.js";
import { docOp, nextOpVersion } from "../src/fork/search/protocol.js";
import { DEFAULT_IMAGE_DIMENSIONS } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { ImageEngine } from "../src/fork/worker/image-engine.js";
import { lessonToObservation } from "../src/state/memory-utils.js";
import { pointId, type Qdrant } from "../src/fork/worker/qdrant.js";
import { vectorBucketScope } from "../src/state/index-persistence.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import type { CompressedObservation, Lesson } from "../src/types.js";
import { FakeRedis, type Store } from "./helpers/fake-redis.js";
import { DIMS, engineClient, imageEngineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";
import { mockKV } from "./helpers/mocks.js";
import { createDiskSearchRuntime } from "../src/fork/search/runtime.js";

const vec = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed * 3.1 + i) + 0.01 * seed);
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const hash = (rows: Record<string, unknown>) => new Map(Object.entries(rows).map(([k, v]) => [k, json(v)]));
const bucket = (n: number) => `state:${vectorBucketScope(n)}`;
const row = (id: string, s: string, seed: number) => ({ id, s, e: float32ToBase64(vec(seed)) });

function obs(id: string, sessionId: string, narrative: string | undefined): CompressedObservation {
  return {
    id, sessionId, timestamp: "2026-11-01T10:00:00.000Z", type: "discovery", title: `title of ${id}`,
    ...(narrative === undefined ? {} : { narrative }), facts: ["a fact"], concepts: ["concept"], files: ["src/x.ts"], importance: 5,
  } as CompressedObservation;
}

const IMG = DEFAULT_IMAGE_DIMENSIONS;
const imageVec = (seed: number, length = IMG) => Array.from({ length }, (_, i) => Math.sin(seed * 1.7 + i) + 0.02 * seed);
const image = (ref: string, seed: number, extra: { sessionId?: string; observationId?: string; length?: number } = {}) => ({
  imageRef: ref, vector: imageVec(seed, extra.length), modelName: "clip", dimensions: IMG, updatedAt: `2026-11-0${seed}T00:00:00.000Z`,
  ...(extra.sessionId ? { sessionId: extra.sessionId } : {}), ...(extra.observationId ? { observationId: extra.observationId } : {}),
});

function lesson(id: string, content: string, deleted = false): Lesson {
  return {
    id, content, context: `context of ${id}`, confidence: 0.7, reinforcements: 0, source: "manual", sourceIds: [], tags: ["kvrocks"],
    createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z", decayRate: 0.05, ...(deleted ? { deleted } : {}),
  };
}

/**
 * lsn_1 and lsn_3 live, lsn_2 deleted (not indexed). img_a with a session and an observation, img_b with neither,
 * img_c a vector of 511 floats (refused).
 *
 * obs_1 the same text embedded twice (the later bucket wins); obs_2 the same vector in two buckets; obs_3 two different vectors (conflict);
 * obs_4 has no narrative (not indexed); obs_5 a vector of the wrong length; obs_6 a vector the
 * pending log deletes; obs_7 no vector; obs_8 a vector only in the pending log; obs_x a vector
 * with no record; mem_1 latest with a vector; mem_2 superseded with a vector.
 */
function fixture(): Store {
  return new Map([
    ["state:mem:sessions", hash({ ses_1: { id: "ses_1" }, ses_2: { id: "ses_2" }, ses_3: { id: "ses_3" } })],
    ["state:mem:obs:ses_1", hash({ obs_1: obs("obs_1", "ses_1", "first narrative about qdrant"), obs_2: obs("obs_2", "ses_1", "second narrative") })],
    ["state:mem:obs:ses_2", hash({
      obs_3: obs("obs_3", "ses_2", "third"), obs_4: obs("obs_4", "ses_2", undefined), obs_5: obs("obs_5", "ses_2", "fifth"),
      obs_6: obs("obs_6", "ses_2", "sixth"), obs_7: obs("obs_7", "ses_2", "seventh"), obs_8: obs("obs_8", "ses_2", "eighth"),
    })],
    ["state:mem:memories", hash({
      mem_1: { id: "mem_1", title: "a memory", content: "remember kvrocks", isLatest: true, sessionIds: ["ses_1"], createdAt: "2026-11-02T00:00:00.000Z", concepts: [], files: [], type: "fact", strength: 5 },
      mem_2: { id: "mem_2", title: "old memory", content: "superseded", isLatest: false, sessionIds: ["ses_1"], createdAt: "2026-11-01T00:00:00.000Z", concepts: [], files: [], type: "fact", strength: 5 },
    })],
    [bucket(0), hash({ obs_1: row("obs_1", "ses_1", 1), obs_2: row("obs_2", "ses_1", 2), obs_3: row("obs_3", "ses_2", 3), obs_6: row("obs_6", "ses_2", 6), mem_1: row("mem_1", "ses_1", 11), mem_2: row("mem_2", "ses_1", 12) })],
    [bucket(1), hash({
      obs_1: { id: "obs_1", s: "ses_1", e: float32ToBase64(vec(1).map((x, i) => x + (i === 0 ? 1e-3 : 0))) },
      obs_2: row("obs_2", "ses_1", 2), obs_3: row("obs_3", "ses_2", 33), obs_4: row("obs_4", "ses_2", 4),
      obs_5: { id: "obs_5", s: "ses_2", e: float32ToBase64(new Float32Array(DIMS + 1)) }, obs_x: row("obs_x", "ses_9", 9),
    })],
    ["state:mem:index:vec-pending", hash({ obs_6: { q: 10, id: "obs_6", t: 1 }, obs_8: { q: 11, id: "obs_8", s: "ses_2", k: "observation", e: float32ToBase64(vec(8)) } })],
    ["state:mem:index:bm25", hash({ "vectors:meta": { v: 3, bucketCount: 1, count: 1, savedAt: "2026-11-01T00:00:00.000Z" } })],
    ["state:mem:lessons", hash({
      lsn_1: lesson("lsn_1", "prefer kvrocks hashes for paged scans"), lsn_2: lesson("lsn_2", "a deleted lesson", true), lsn_3: lesson("lsn_3", "qdrant upserts converge"),
    })],
    ["state:mem:image-embeddings", hash({
      "img/a.png": image("img/a.png", 1, { sessionId: "ses_1", observationId: "obs_1" }), "img/b.png": image("img/b.png", 2),
      "img/c.png": image("img/c.png", 3, { length: IMG - 1 }),
    })],
  ]);
}

const EXPECTED_PLAN = {
  bucketScopes: 2, bucketRows: 12, pendingRows: 2, malformed: 1, duplicateRows: 1, nearDuplicates: 1, conflicting: 1,
  pendingVectors: 1, pendingDeletes: 1, pendingClears: 0, docs: 7,
};

describe("planVectors", () => {
  it("collapses duplicates, refuses conflicts and malformed rows, replays the pending log, and ignores the stale meta", async () => {
    const plan = await planVectors(new FakeRedis(fixture()), DIMS, 2);
    expect(plan.report).toMatchObject(EXPECTED_PLAN);
    expect(plan.report.nearDuplicateMinCosine).toBeGreaterThan(0.99);
    expect(plan.winners.get("obs_1")!.source).toBe(1);
    expect([...plan.winners.keys()].sort()).toEqual(["mem_1", "mem_2", "obs_1", "obs_2", "obs_4", "obs_8", "obs_x"]);
    expect(plan.winners.get("obs_2")!.source).toBe(0);
  });

  it("drops every earlier vector at a pending clear", async () => {
    const store = fixture();
    store.get("state:mem:index:vec-pending")!.set("~clear", json({ q: 10.5, c: 1 }));
    const plan = await planVectors(new FakeRedis(store), DIMS, 2);
    expect([...plan.winners.keys()]).toEqual(["obs_8"]);
  });

  it("loads no vector for a document whose newest pending row cannot be read", async () => {
    const store = fixture();
    store.get("state:mem:index:vec-pending")!.set("obs_1", json({ q: 12, id: "obs_1", e: "not base64 of floats" }));
    const plan = await planVectors(new FakeRedis(store), DIMS, 2);
    expect(plan.winners.has("obs_1")).toBe(false);
    expect(plan.report.malformed).toBe(2);
  });

  it("refuses a legacy snapshot layout", async () => {
    const store = fixture();
    store.get("state:mem:index:bm25")!.set("vectors:manifest", json({ v: 1, shards: [], chars: 0 }));
    await expect(planVectors(new FakeRedis(store), DIMS, 2)).rejects.toThrow(MigrateError);
  });
});

describe("float16 rounding", () => {
  it("rounds to the nearest half, ties to even, with subnormals", () => {
    expect(f16round(1 / 3)).toBe(0.333251953125);
    expect(f16round(65504)).toBe(65504);
    expect(f16round(1 + 2 ** -11)).toBe(1);
    expect(f16round(1 + 3 * 2 ** -11)).toBe(1 + 2 ** -9);
    expect(f16round(2 ** -24)).toBe(2 ** -24);
    expect(f16round(1e-8)).toBe(0);
    expect(f16round(-0.1)).toBe(-0.0999755859375);
  });
});

describe("optimizer gate", () => {
  const collection = (statuses: string[]) => {
    let n = 0;
    const qdrant = {
      path: "/collections/c",
      config: { collection: "c" },
      call: async () => ({ status: statuses[Math.min(n++, statuses.length - 1)] }),
    } as unknown as Parameters<typeof waitForOptimizer>[0];
    return { qdrant, polls: () => n };
  };

  it("waits while Qdrant is optimizing, until two polls in a row find it idle", async () => {
    const c = collection(["green", "yellow", "yellow", "green", "yellow", "green", "green"]);
    expect(await waitForOptimizer(c.qdrant, 1)).toBe(true);
    expect(c.polls()).toBe(7);
  });

  it("returns at once on an idle collection, green or grey", async () => {
    for (const status of ["green", "grey"]) {
      const c = collection([status]);
      expect(await waitForOptimizer(c.qdrant, 1)).toBe(false);
      expect(c.polls()).toBe(2);
    }
  });
});

describe("half-step distance", () => {
  it("never counts a NaN or infinite component as a match", () => {
    expect(halfSteps(0.5, 0.5)).toBe(0);
    expect(halfSteps(Number.NaN, 0.5)).toBe(Infinity);
    expect(halfSteps(0.5, Number.NaN)).toBe(Infinity);
    expect(halfSteps(Infinity, Infinity)).toBe(Infinity);
  });
});

describe("no embedding provider", () => {
  it("imports nothing that can embed", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const [, spec] of source.matchAll(/(?:import|export)[^"']*?from\s+["'](\.[^"']+)["']/g)) {
        const target = resolve(dirname(file), spec!.replace(/\.js$/, ".ts"));
        walk(target);
      }
    };
    walk(resolve("scripts/fork/search-migrate.ts"));
    const reached = [...seen].map((f) => f.slice(process.cwd().length + 1));
    expect(reached).toContain("src/fork/worker/engine.ts");
    expect(reached.filter((f) => /providers\/|embedding|functions\/search\.ts|src\/index\.ts/.test(f))).toEqual([]);
  });

  it("refuses and counts any call that is not to Qdrant", async () => {
    const guard = new FetchGuard("http://127.0.0.1:1").install();
    try {
      await expect(fetch("https://api.voyageai.com/v1/embeddings", { method: "POST" })).rejects.toThrow(/refused/);
      expect(guard.refused).toBe(1);
      await expect(fetch("not a url")).rejects.toThrow(/refused a call to an unparsable URL/);
      expect(guard.refused).toBe(2);
    } finally {
      guard.uninstall();
    }
  });
});

describe.skipIf(!QDRANT_URL)("fill and verify on Qdrant", { timeout: 120_000 }, () => {
  const collections: Qdrant[] = [];
  afterEach(async () => {
    for (const q of collections.splice(0)) await q.drop();
  });
  const setup = async (name: string) => {
    const base = `tee1168_${name}_${Date.now()}`;
    const qdrant = qdrantFor(base);
    const lessons = qdrantFor(`${base}_lessons`, DIMS, "lessons");
    const images = qdrantFor(`${base}_images`, IMG, "image");
    collections.push(qdrant, lessons, images);
    const targets: Targets = {
      docs: { qdrant, engine: new SearchEngine(qdrant, 70) },
      lessons: { qdrant: lessons, engine: new SearchEngine(lessons, 70) },
      images: { qdrant: images, engine: new ImageEngine(images) },
    };
    return { qdrant, engine: targets.docs.engine, targets };
  };
  const options = { page: 2, dimensions: DIMS, allowNonempty: false, log: () => {} };
  const verifyAll = (store: FakeRedis, targets: Targets, guard = new FetchGuard("http://unused")) =>
    verify(store, targets, { page: 2, dimensions: DIMS, rate: 1, guard });
  const line = (lines: string[], name: string) => lines.find((l) => l.slice(5).startsWith(`${name}:`));

  it("loads documents and stored vectors and verifies them", async () => {
    const { qdrant, engine, targets } = await setup("fill");
    const data = fixture();
    data.get("state:mem:obs:ses_1")!.set("obs_bad", Buffer.from("{not json"));
    const store = new FakeRedis(data);
    const result = await fill(store, targets, { ...options, optimizerCheckDocs: 1 });
    // 8 documents + 2 live lessons; 4 stored vectors + 2 images; img/c.png refused.
    expect(result.written).toEqual({ docs: 10, vectors: 6, fenced: 0, unparsable: 1, refused: 1 });
    const checked = await verifyAll(store, targets);
    expect(checked.lines.join("\n")).toContain("OK   vectors: stored-and-indexable 4 index 4; 3 stored vectors have no indexable record, 4 documents have no stored vector");
    expect(checked.ok, checked.lines.join("\n")).toBe(true);
    expect(checked.lines.find((l) => l.includes("sampled vectors"))).toMatch(/4 sampled, 0 differ, 0 within one float16 step; checksum store (\w+) index \1$/);
    expect(await engine.stats()).toMatchObject({ docs: 8, vectors: 4, memories: 1, missingVectors: 4 });
    const [point] = await qdrant.call<Array<{ payload: { v: number } }>>("POST", `${qdrant.path}/points`, { ids: [pointId("obs_1")], with_payload: ["v"] });
    expect(point!.payload.v).toBe(MIGRATION_VERSION);
    // Weighted once with the corpus's own mean, so the worker has nothing to reweight.
    const { avgdl } = JSON.parse(store.data.get(MARKER_KEY)!.get("meta")!.toString()) as { avgdl: number };
    const { points } = await qdrant.call<{ points: Array<{ payload: { ad: number; dl: number } }> }>("POST", `${qdrant.path}/points/scroll`, { limit: 100, with_payload: ["ad", "dl"] });
    expect(new Set(points.map((p) => p.payload.ad))).toEqual(new Set([avgdl]));
    expect(points.reduce((n, p) => n + p.payload.dl, 0) / points.length).toBeCloseTo(avgdl, 10);
    const hits = await engine.vector(float32ToBase64(vec(8)), 1, "all", 6);
    expect(hits[0]!.id).toBe("obs_8");
  });

  it("fills the lessons and images collections, skipping deleted lessons and refusing image vectors that are not 512 floats", async () => {
    const { targets } = await setup("lessons_images");
    const store = new FakeRedis(fixture());
    await fill(store, targets, options);
    const checked = await verifyAll(store, targets);
    expect(checked.ok, checked.lines.join("\n")).toBe(true);
    expect(line(checked.lines, "lessons")).toBe("OK   lessons: store 2 index 2; 0 records unreadable");
    expect(line(checked.lines, "lesson revs")).toMatch(/^OK   lesson revs: 2 checked, 0 differ; checksum store (\w+) index \1$/);
    expect(line(checked.lines, "images")).toBe("OK   images: store 2 index 2; 1 refused (not 512 floats), 0 unreadable");
    expect(line(checked.lines, "image vectors")).toMatch(/^OK   image vectors: 2 checked, 0 differ; checksum store (\w+) index \1$/);

    const lessonHits = await targets.lessons.engine.keyword("kvrocks hashes", 5, "all");
    expect(lessonHits[0]).toMatchObject({ id: "lsn_1", sessionId: "lesson" });
    expect(lessonHits.map((h) => h.id)).not.toContain("lsn_2");
    const [point] = await targets.lessons.qdrant.call<Array<{ payload: { v: number; lexical_order: number[]; rev: string } }>>(
      "POST", `${targets.lessons.qdrant.path}/points`, { ids: [pointId("lsn_1")], with_payload: ["v", "lexical_order", "rev"] },
    );
    expect(point!.payload.v).toBe(MIGRATION_VERSION);
    // lsn_1 is on the first page and lsn_3 on the second; both carry version 1, so only the position keeps their write order.
    const orders = await targets.lessons.qdrant.call<Array<{ payload: { doc_id: string; lexical_order: number[] } }>>(
      "POST", `${targets.lessons.qdrant.path}/points`, { ids: [pointId("lsn_1"), pointId("lsn_3")], with_payload: ["doc_id", "lexical_order"] },
    );
    const order = new Map(orders.map((p) => [p.payload.doc_id, p.payload.lexical_order]));
    expect(order.get("lsn_1")![0]).toBe(MIGRATION_VERSION);
    expect(order.get("lsn_3")![0]).toBe(MIGRATION_VERSION);
    expect(order.get("lsn_3")![1]).toBeGreaterThan(order.get("lsn_1")![1]!);
    expect(point!.payload.rev).toBe(docOp(lessonToObservation(lesson("lsn_1", "prefer kvrocks hashes for paged scans")), "lesson").rev);

    const found = await targets.images.engine.query(float32ToBase64(Float32Array.from(imageVec(1))), 5, undefined);
    expect(found.total).toBe(2);
    expect(found.hits[0]).toMatchObject({ id: "img/a.png", sessionId: "ses_1", observationId: "obs_1", updatedAt: "2026-11-01T00:00:00.000Z" });
    expect((await targets.images.engine.query(float32ToBase64(Float32Array.from(imageVec(2))), 5, "ses_1")).hits.map((h) => h.id)).toEqual(["img/a.png"]);
  });

  it("converges with no duplicates after being killed during a write and after a unit", async () => {
    const { qdrant, engine, targets } = await setup("resume");
    const store = new FakeRedis(fixture());
    let calls = 0;
    const dying = Object.create(engine) as SearchEngine;
    dying.load = (items, version) => (++calls === 3 ? Promise.reject(new Error("killed")) : engine.load(items, version));
    await expect(fill(store, { ...targets, docs: { qdrant, engine: dying } }, options)).rejects.toThrow("killed");
    store.writesBeforeKill = 2;
    await expect(fill(store, targets, options)).rejects.toThrow("killed");
    store.writesBeforeKill = Infinity;
    const last = await fill(store, targets, options);
    expect(last.skipped).toBeGreaterThan(0);
    const again = await fill(store, targets, options);
    expect(again.written).toEqual({ docs: 0, vectors: 0, fenced: 0, unparsable: 0, refused: 0 });
    expect(await qdrant.count()).toBe(8);
    const checked = await verifyAll(store, targets);
    expect(checked.ok, checked.lines.join("\n")).toBe(true);
  });

  it("converges after being killed in the lessons unit and in the images unit", async () => {
    const { targets } = await setup("resume_li");
    const store = new FakeRedis(fixture());
    const lessons = Object.create(targets.lessons.engine) as SearchEngine;
    let lessonCalls = 0;
    // Page 2 holds lsn_3 alone: the first page has landed when the kill comes.
    lessons.apply = (ops, version) => (++lessonCalls === 2 ? Promise.reject(new Error("killed")) : targets.lessons.engine.apply(ops, version));
    await expect(fill(store, { ...targets, lessons: { ...targets.lessons, engine: lessons } }, options)).rejects.toThrow("killed");
    expect(await targets.lessons.qdrant.count()).toBe(1);
    expect(store.data.get(MARKER_KEY)!.has("unit:lessons")).toBe(false);

    const images = Object.create(targets.images.engine) as ImageEngine;
    let imageCalls = 0;
    // Killed after the first page landed and before the unit's marker.
    images.apply = async (ops, version) => {
      const applied = await targets.images.engine.apply(ops, version);
      if (++imageCalls === 1) throw new Error("killed");
      return applied;
    };
    await expect(fill(store, { ...targets, images: { ...targets.images, engine: images } }, options)).rejects.toThrow("killed");
    expect(store.data.get(MARKER_KEY)!.has("unit:lessons")).toBe(true);
    expect(store.data.get(MARKER_KEY)!.has("unit:images")).toBe(false);
    expect(await targets.images.qdrant.count()).toBe(2);

    const last = await fill(store, targets, options);
    expect(last.written).toMatchObject({ docs: 0, vectors: 2, refused: 1 });
    const again = await fill(store, targets, options);
    expect(again.written).toEqual({ docs: 0, vectors: 0, fenced: 0, unparsable: 0, refused: 0 });
    expect(await targets.lessons.qdrant.count()).toBe(2);
    expect(await targets.images.qdrant.count()).toBe(2);
    const checked = await verifyAll(store, targets);
    expect(checked.ok, checked.lines.join("\n")).toBe(true);
  });

  it("never overwrites or resurrects what a live write changed after it", async () => {
    const { qdrant, engine, targets } = await setup("live");
    const store = new FakeRedis(fixture());
    await fill(store, targets, options);
    const edited = docOp(obs("obs_1", "ses_1", "edited live after the migration"), "observation");
    const live = await engine.apply([edited, { k: "vec", id: "obs_1", rev: edited.rev, f32b64: float32ToBase64(vec(100)) }, { k: "del", id: "obs_2" }], nextOpVersion());
    expect(live.fenced).toEqual([]);
    const liveLesson = docOp(lessonToObservation(lesson("lsn_1", "rewritten live")), "lesson");
    await targets.lessons.engine.apply([liveLesson, { k: "del", id: "lsn_3" }], nextOpVersion());
    await targets.images.engine.apply([{ k: "img", id: "img/a.png", sessionId: "ses_live", f32b64: float32ToBase64(Float32Array.from(imageVec(9))), updatedAt: "live" }, { k: "del", id: "img/b.png" }], nextOpVersion());
    // A second full run, as after losing the marker's progress.
    store.data.set(MARKER_KEY, new Map([...store.data.get(MARKER_KEY)!].filter(([field]) => !field.startsWith("unit:"))));
    const rerun = await fill(store, targets, options);
    expect(rerun.written.fenced).toBe(6);
    const points = await qdrant.call<Array<{ payload: { doc_id: string; rev?: string; deleted?: boolean } }>>("POST", `${qdrant.path}/points`, {
      ids: [pointId("obs_1"), pointId("obs_2")], with_payload: ["doc_id", "rev", "deleted"],
    });
    const byId = new Map(points.map((p) => [p.payload.doc_id, p.payload]));
    expect(byId.get("obs_1")!.rev).toBe(edited.rev);
    expect(byId.get("obs_2")!.deleted).toBe(true);
    expect((await engine.vector(float32ToBase64(vec(100)), 1, "all", 6))[0]!.id).toBe("obs_1");
    expect((await targets.lessons.engine.keyword("rewritten", 5, "all")).map((h) => h.id)).toEqual(["lsn_1"]);
    expect(await targets.lessons.qdrant.count({ must_not: [{ key: "deleted", match: { value: true } }] })).toBe(1);
    const imageHits = await targets.images.engine.query(float32ToBase64(Float32Array.from(imageVec(9))), 5, undefined);
    expect(imageHits).toMatchObject({ total: 1, hits: [{ id: "img/a.png", sessionId: "ses_live", updatedAt: "live" }] });
  });

  it("fails verify on a changed vector, a missing document or an embedding call", async () => {
    const { qdrant, targets } = await setup("tamper");
    const store = new FakeRedis(fixture());
    await fill(store, targets, options);
    await qdrant.call("PUT", `${qdrant.path}/points/vectors?wait=true`, { points: [{ id: pointId("obs_1"), vector: { dense: Array.from(vec(77)) } }] });
    let checked = await verifyAll(store, targets);
    expect(checked.ok).toBe(false);
    expect(checked.lines.find((l) => l.includes("sampled vectors"))).toMatch(/^FAIL .* 1 differ/);

    await qdrant.call("POST", `${qdrant.path}/points/delete?wait=true`, { points: [pointId("obs_7")] });
    checked = await verifyAll(store, targets);
    expect(checked.lines.find((l) => l.includes("observations"))).toMatch(/^FAIL observations: store 7 index 6/);

    const guard = new FetchGuard("http://unused");
    guard.refused = 1;
    checked = await verifyAll(store, targets, guard);
    expect(checked.lines).toContain("FAIL embedding calls: 1");
  });

  it("fails verify on a tampered lesson or image, or a missing one", async () => {
    const { targets } = await setup("tamper_li");
    const store = new FakeRedis(fixture());
    await fill(store, targets, options);
    expect((await verifyAll(store, targets)).ok).toBe(true);

    const lessons = targets.lessons.qdrant;
    await lessons.call("POST", `${lessons.path}/points/payload?wait=true`, { payload: { rev: "0000000000000000" }, points: [pointId("lsn_3")] });
    let checked = await verifyAll(store, targets);
    expect(checked.ok).toBe(false);
    expect(line(checked.lines, "lesson revs")).toMatch(/^FAIL lesson revs: 2 checked, 1 differ; checksum store (\w+) index (?!\1)\w+$/);

    const images = targets.images.qdrant;
    const nudged = imageVec(2).map((x, i) => (i === 7 ? x + 0.5 : x));
    await images.call("PUT", `${images.path}/points/vectors?wait=true`, { points: [{ id: pointId("img/b.png"), vector: { image: nudged } }] });
    checked = await verifyAll(store, targets);
    expect(line(checked.lines, "image vectors")).toMatch(/^FAIL image vectors: 2 checked, 1 differ/);

    await images.call("POST", `${images.path}/points/payload?wait=true`, { payload: { session_id: "ses_other" }, points: [pointId("img/a.png")] });
    checked = await verifyAll(store, targets);
    expect(line(checked.lines, "image vectors")).toMatch(/^FAIL image vectors: 2 checked, 2 differ/);

    await images.call("POST", `${images.path}/points/delete?wait=true`, { points: [pointId("img/a.png")] });
    await lessons.call("POST", `${lessons.path}/points/delete?wait=true`, { points: [pointId("lsn_1")] });
    checked = await verifyAll(store, targets);
    expect(line(checked.lines, "images")).toMatch(/^FAIL images: store 2 index 1/);
    expect(line(checked.lines, "lessons")).toMatch(/^FAIL lessons: store 2 index 1/);
  });

  it("refuses to resume from a marker another migration version wrote", async () => {
    const { targets } = await setup("marker");
    const store = new FakeRedis(fixture());
    store.data.set(MARKER_KEY, new Map([["meta", json({ version: MIGRATION_VERSION + 1, startedAt: "2026-11-01T00:00:00.000Z", avgdl: 30 })]]));
    await expect(fill(store, targets, options)).rejects.toThrow(/another migration version/);
    store.data.set(MARKER_KEY, new Map([["meta", json({ version: MIGRATION_VERSION, avgdl: 30 })]]));
    await expect(fill(store, targets, options)).rejects.toThrow(/corrupt/);
  });

  it("refuses a collection that already holds documents it did not write", async () => {
    const { engine, targets } = await setup("nonempty");
    await engine.apply([docOp(obs("obs_9", "ses_1", "written by the app"), "observation")], nextOpVersion());
    await expect(fill(new FakeRedis(fixture()), targets, options)).rejects.toThrow(/allow-nonempty/);
  });

  it("loses no document and keeps every stored vector when the app's reconcile runs between a killed fill and its resume", async () => {
    const { qdrant, engine, targets } = await setup("reconcile");
    const store = new FakeRedis(fixture());
    let calls = 0;
    const dying = Object.create(engine) as SearchEngine;
    dying.load = (items, version, avgdl) => (++calls === 2 ? Promise.reject(new Error("killed")) : engine.load(items, version, avgdl));
    await expect(fill(store, { ...targets, docs: { qdrant, engine: dying } }, options)).rejects.toThrow("killed");

    const runtime = createDiskSearchRuntime(engineClient(engine), false, DIMS, {
      lessons: engineClient(targets.lessons.engine),
      images: imageEngineClient(targets.images.engine),
    }, { reconcileIntervalMs: 0, sweepPerPass: 3, reembedPerMinute: 0 });
    try {
      runtime.reconciler.start(stateOf(store) as never);
      await runtime.reconciler.runPass();
      const resumed = await fill(store, targets, options);
      expect(resumed.skipped).toBeGreaterThan(0);
      const checked = await verifyAll(store, targets);
      expect(checked.ok, checked.lines.join("\n")).toBe(true);
      await runtime.reconciler.runPass();
      expect(runtime.reconciler.report()).toMatchObject({ added: 0, deleted: 0 });
      expect((await verifyAll(store, targets)).ok).toBe(true);
    } finally {
      await runtime.service.stop();
      runtime.stats.stop();
      for (const outbox of runtime.outboxes) await outbox.stop(100);
    }
  });
});

/** The app's view of the migration's store: every `state:` hash as a KV scope of parsed rows. */
function stateOf(store: FakeRedis) {
  const kv = mockKV();
  for (const [key, fields] of store.data) {
    if (!key.startsWith("state:")) continue;
    for (const [field, value] of fields) void kv.set(key.slice("state:".length), field, JSON.parse(value.toString()));
  }
  return Object.assign(kv, {
    getMany: async <T>(scope: string, keys: string[]): Promise<Array<T | null>> => keys.map((k) => (kv.store.get(scope)?.get(k) as T) ?? null),
  });
}

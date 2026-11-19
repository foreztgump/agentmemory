import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  f16round,
  FetchGuard,
  fill,
  MARKER_KEY,
  MigrateError,
  MIGRATION_VERSION,
  planVectors,
  verify,
} from "../scripts/fork/search-migrate.js";
import { docOp, nextOpVersion } from "../src/fork/search/protocol.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { pointId, type Qdrant } from "../src/fork/worker/qdrant.js";
import { vectorBucketScope } from "../src/state/index-persistence.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import type { CompressedObservation } from "../src/types.js";
import { FakeRedis, type Store } from "./helpers/fake-redis.js";
import { DIMS, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

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

/**
 * obs_1 one vector; obs_2 the same vector in two buckets; obs_3 two different vectors (conflict);
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
      obs_2: row("obs_2", "ses_1", 2), obs_3: row("obs_3", "ses_2", 33), obs_4: row("obs_4", "ses_2", 4),
      obs_5: { id: "obs_5", s: "ses_2", e: float32ToBase64(new Float32Array(DIMS + 1)) }, obs_x: row("obs_x", "ses_9", 9),
    })],
    ["state:mem:index:vec-pending", hash({ obs_6: { q: 10, id: "obs_6", t: 1 }, obs_8: { q: 11, id: "obs_8", s: "ses_2", k: "observation", e: float32ToBase64(vec(8)) } })],
    ["state:mem:index:bm25", hash({ "vectors:meta": { v: 3, bucketCount: 1, count: 1, savedAt: "2026-11-01T00:00:00.000Z" } })],
  ]);
}

const EXPECTED_PLAN = {
  bucketScopes: 2, bucketRows: 11, pendingRows: 2, malformed: 1, duplicateRows: 1, conflicting: 1,
  pendingVectors: 1, pendingDeletes: 1, pendingClears: 0, docs: 7,
};

describe("planVectors", () => {
  it("collapses duplicates, refuses conflicts and malformed rows, replays the pending log, and ignores the stale meta", async () => {
    const plan = await planVectors(new FakeRedis(fixture()), DIMS, 2);
    expect(plan.report).toEqual(EXPECTED_PLAN);
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
    const qdrant = qdrantFor(`tee1168_${name}_${Date.now()}`);
    collections.push(qdrant);
    return { qdrant, engine: new SearchEngine(qdrant, 70) };
  };
  const options = { page: 2, dimensions: DIMS, allowNonempty: false, log: () => {} };
  const verifyAll = (store: FakeRedis, engine: SearchEngine, qdrant: Qdrant, guard = new FetchGuard("http://unused")) =>
    verify(store, engine, qdrant, { page: 2, dimensions: DIMS, rate: 1, guard });

  it("loads documents and stored vectors and verifies them", async () => {
    const { qdrant, engine } = await setup("fill");
    const store = new FakeRedis(fixture());
    const result = await fill(store, engine, qdrant, options);
    expect(result.written).toEqual({ docs: 8, vectors: 4, fenced: 0 });
    const checked = await verifyAll(store, engine, qdrant);
    expect(checked.lines.join("\n")).toContain("OK   vectors: stored-and-indexable 4 index 4; 3 stored vectors have no indexable record, 4 documents have no stored vector");
    expect(checked.ok, checked.lines.join("\n")).toBe(true);
    expect(checked.lines.find((l) => l.includes("sampled vectors"))).toMatch(/4 sampled, 0 differ, 0 within one float16 step; checksum store (\w+) index \1$/);
    expect(await engine.stats()).toMatchObject({ docs: 8, vectors: 4, memories: 1, missingVectors: 4 });
    const [point] = await qdrant.call<Array<{ payload: { v: number } }>>("POST", `${qdrant.path}/points`, { ids: [pointId("obs_1")], with_payload: ["v"] });
    expect(point!.payload.v).toBe(MIGRATION_VERSION);
    const hits = await engine.vector(float32ToBase64(vec(8)), 1, "all", 6);
    expect(hits[0]!.id).toBe("obs_8");
  });

  it("converges with no duplicates after being killed during a write and after a unit", async () => {
    const { qdrant, engine } = await setup("resume");
    const store = new FakeRedis(fixture());
    let calls = 0;
    const dying = Object.create(engine) as SearchEngine;
    dying.apply = (ops, version) => (++calls === 3 ? Promise.reject(new Error("killed")) : engine.apply(ops, version));
    await expect(fill(store, dying, qdrant, options)).rejects.toThrow("killed");
    store.writesBeforeKill = 2;
    await expect(fill(store, engine, qdrant, options)).rejects.toThrow("killed");
    store.writesBeforeKill = Infinity;
    const last = await fill(store, engine, qdrant, options);
    expect(last.skipped).toBeGreaterThan(0);
    const again = await fill(store, engine, qdrant, options);
    expect(again.written).toEqual({ docs: 0, vectors: 0, fenced: 0 });
    expect(await qdrant.count()).toBe(8);
    const checked = await verifyAll(store, engine, qdrant);
    expect(checked.ok, checked.lines.join("\n")).toBe(true);
  });

  it("never overwrites or resurrects what a live write changed after it", async () => {
    const { qdrant, engine } = await setup("live");
    const store = new FakeRedis(fixture());
    await fill(store, engine, qdrant, options);
    const edited = docOp(obs("obs_1", "ses_1", "edited live after the migration"), "observation");
    const live = await engine.apply([edited, { k: "vec", id: "obs_1", rev: edited.rev, f32b64: float32ToBase64(vec(100)) }, { k: "del", id: "obs_2" }], nextOpVersion());
    expect(live.fenced).toEqual([]);
    // A second full run, as after losing the marker's progress.
    store.data.set(MARKER_KEY, new Map([...store.data.get(MARKER_KEY)!].filter(([field]) => !field.startsWith("unit:"))));
    const rerun = await fill(store, engine, qdrant, options);
    expect(rerun.written.fenced).toBe(2);
    const points = await qdrant.call<Array<{ payload: { doc_id: string; rev?: string; deleted?: boolean } }>>("POST", `${qdrant.path}/points`, {
      ids: [pointId("obs_1"), pointId("obs_2")], with_payload: ["doc_id", "rev", "deleted"],
    });
    const byId = new Map(points.map((p) => [p.payload.doc_id, p.payload]));
    expect(byId.get("obs_1")!.rev).toBe(edited.rev);
    expect(byId.get("obs_2")!.deleted).toBe(true);
    expect((await engine.vector(float32ToBase64(vec(100)), 1, "all", 6))[0]!.id).toBe("obs_1");
  });

  it("fails verify on a changed vector, a missing document or an embedding call", async () => {
    const { qdrant, engine } = await setup("tamper");
    const store = new FakeRedis(fixture());
    await fill(store, engine, qdrant, options);
    await qdrant.call("PUT", `${qdrant.path}/points/vectors?wait=true`, { points: [{ id: pointId("obs_1"), vector: { dense: Array.from(vec(77)) } }] });
    let checked = await verifyAll(store, engine, qdrant);
    expect(checked.ok).toBe(false);
    expect(checked.lines.find((l) => l.includes("sampled vectors"))).toMatch(/^FAIL .* 1 differ/);

    await qdrant.call("POST", `${qdrant.path}/points/delete?wait=true`, { points: [pointId("obs_7")] });
    checked = await verifyAll(store, engine, qdrant);
    expect(checked.lines.find((l) => l.includes("observations"))).toMatch(/^FAIL observations: store 7 index 6/);

    const guard = new FetchGuard("http://unused");
    guard.refused = 1;
    checked = await verifyAll(store, engine, qdrant, guard);
    expect(checked.lines).toContain("FAIL embedding calls: 1");
  });

  it("refuses a collection that already holds documents it did not write", async () => {
    const { qdrant, engine } = await setup("nonempty");
    await engine.apply([docOp(obs("obs_9", "ses_1", "written by the app"), "observation")], nextOpVersion());
    await expect(fill(new FakeRedis(fixture()), engine, qdrant, options)).rejects.toThrow(/allow-nonempty/);
  });
});

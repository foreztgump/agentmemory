// TEE-1164 fix round 2: behaviours 1 and 3 to 7 of the review of 227e79b, each
// pinned against a real Qdrant. Each case asserts what a caller or a search
// sees, except where a case says it watches the worker's requests to Qdrant.
// Skipped unless QDRANT_URL is set:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-round2.test.ts
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { pointId, type Qdrant } from "../src/fork/worker/qdrant.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../src/fork/search/runtime.js";
import { contentRev, type DocOp } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import { createSearchRuntime } from "../src/state/search-ports.js";
import { setEmbeddingProvider, setVectorIndex } from "../src/functions/search.js";
import type { CompressedObservation } from "../src/types.js";
import { DIMS, engineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const obs = (id: string, title: string, sessionId = "ses_r2"): CompressedObservation => ({
  id, sessionId, timestamp: "2026-11-18T00:00:00Z", title, narrative: "", type: "discovery", facts: [], concepts: [], files: [], importance: 5,
});
const docOp = (id: string, title: string): DocOp => {
  const fields = termSourceOf(obs(id, title));
  return { k: "doc", id, sessionId: "ses_r2", ts: 1, layer: "observation", fields, rev: contentRev(fields) };
};
const embedding = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed * 3 + i));
const vecOp = (op: DocOp, seed: number) => ({ k: "vec" as const, id: op.id, rev: op.rev, f32b64: float32ToBase64(embedding(seed)) });
const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);
const obsIds = (hits: Array<{ obsId: string }>) => hits.map((h) => h.obsId);

interface Rig {
  q: Qdrant;
  engine: SearchEngine;
  runtime?: DiskSearchRuntime;
}
const rigs: Rig[] = [];
async function rig(label: string): Promise<Rig> {
  const q = qdrantFor(`round2_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await q.ensure();
  const state: Rig = { q, engine: new SearchEngine(q, DEFAULT_AVGDL) };
  rigs.push(state);
  return state;
}

afterEach(() => {
  setEmbeddingProvider(null);
  setVectorIndex(null);
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "memory");
});
afterAll(async () => {
  for (const r of rigs) {
    r.runtime?.stats.stop();
    await r.runtime?.outbox.stop(10_000);
    await r.q.drop();
  }
}, 60_000);

async function stored(r: Rig, id: string): Promise<Record<string, unknown> | undefined> {
  const [point] = await r.q.call<Array<{ payload?: Record<string, unknown> }>>("POST", `${r.q.path}/points`, { ids: [pointId(id)], with_payload: true, with_vector: false });
  return point?.payload;
}

describe.skipIf(!QDRANT_URL)("behaviour 1: versions survive a restart with the clock behind", () => {
  // A previous process stamped these from a clock that was ahead of this one.
  const AHEAD = Date.now() * 1000 + 3_600_000_000;

  async function seedAhead(r: Rig): Promise<void> {
    const gone = docOp("obs_gone", "formerlygone");
    await r.engine.apply([docOp("obs_kept", "formerlykept"), gone], AHEAD);
    await r.engine.apply([{ k: "del", id: "obs_gone" }], AHEAD + 1);
  }

  it("applies the writes of a restarted app whose clock is behind what Qdrant stores", async () => {
    const r = await rig("restart_app");
    await seedAhead(r);

    const restarted = new SearchEngine(r.q, DEFAULT_AVGDL);
    const runtime = (r.runtime = createDiskSearchRuntime(engineClient(restarted), true, DIMS));
    await runtime.stats.refresh();
    runtime.keyword.add(obs("obs_kept", "rewrittenkept"));
    runtime.keyword.add(obs("obs_gone", "rewrittengone"));
    runtime.vector!.add("obs_kept", "ses_r2", embedding(1));
    runtime.vector!.add("obs_gone", "ses_r2", embedding(2));
    await runtime.outbox.drainFor(10_000);

    expect(obsIds(await runtime.keyword.search("rewrittenkept"))).toEqual(["obs_kept"]);
    expect(obsIds(await runtime.keyword.search("rewrittengone"))).toEqual(["obs_gone"]);
    expect(obsIds(await runtime.keyword.search("formerlykept"))).toEqual([]);
    expect(obsIds(await runtime.vector!.search(embedding(1))).sort()).toEqual(["obs_gone", "obs_kept"]);
  }, 30_000);

  it("stamps a write that arrives without a version above what Qdrant already stores", async () => {
    const r = await rig("restart_worker");
    await seedAhead(r);

    const restarted = new SearchEngine(r.q, DEFAULT_AVGDL);
    await restarted.apply([docOp("obs_kept", "unversionedkept"), docOp("obs_gone", "unversionedgone")]);

    expect(ids(await restarted.keyword("unversionedkept", 10, "all"))).toEqual(["obs_kept"]);
    expect(ids(await restarted.keyword("unversionedgone", 10, "all"))).toEqual(["obs_gone"]);
  });
});

describe.skipIf(!QDRANT_URL)("behaviour 3: a deleted id is never returned", () => {
  // The delete follows the vector in one invocation, so both carry one version and the
  // vector's conditional write can still match the tombstone the delete left.
  async function deletedAmongLive(label: string): Promise<Rig> {
    const r = await rig(label);
    const live = docOp("obs_live", "sharedtopic liveword");
    const dead = docOp("obs_dead", "sharedtopic deadword");
    await r.engine.apply([live, dead, vecOp(live, 1), vecOp(dead, 1), { k: "del", id: "obs_dead" }]);
    return r;
  }

  it("keeps a deleted id out of a keyword search over every layer", async () => {
    const r = await deletedAmongLive("kw_all");
    expect(ids(await r.engine.keyword("sharedtopic", 20, "all"))).toEqual(["obs_live"]);
    expect(ids(await r.engine.keyword("deadword", 20, "all"))).toEqual([]);
  });

  it("keeps a deleted id out of a vector search over every layer", async () => {
    const r = await deletedAmongLive("vec_all");
    expect(ids(await r.engine.vector(float32ToBase64(embedding(1)), 20, "all", 6))).toEqual(["obs_live"]);
  });

  it("does not count a deleted id's vector in the stats", async () => {
    const r = await deletedAmongLive("stats");
    const { docs, vectors, missingVectors } = await r.engine.stats();
    expect({ docs, vectors, missingVectors }).toEqual({ docs: 1, vectors: 1, missingVectors: 0 });
  });
});

describe.skipIf(!QDRANT_URL)("behaviour 4: a vector delete that loses its claim is reported", () => {
  it("reports the id as fenced, not applied, when the point already holds a newer version", async () => {
    const r = await rig("vecdel_lost");
    const doc = docOp("obs_vd", "claimedtopic");
    await r.engine.apply([doc, vecOp(doc, 1)], 2_000);
    const result = await r.engine.apply([{ k: "vec-del", id: "obs_vd" }], 1_000);
    expect(result.fenced).toEqual(["obs_vd"]);
    expect(result.applied).toBe(0);
    expect(ids(await r.engine.vector(float32ToBase64(embedding(1)), 10, "all", 6))).toEqual(["obs_vd"]);
  });

  it("applies and does not report a vector delete that wins its claim (control)", async () => {
    const r = await rig("vecdel_won");
    const doc = docOp("obs_vd", "claimedtopic");
    await r.engine.apply([doc, vecOp(doc, 1)], 1_000);
    const result = await r.engine.apply([{ k: "vec-del", id: "obs_vd" }], 2_000);
    expect(result).toEqual({ applied: 1, fenced: [], failed: [] });
    expect(ids(await r.engine.vector(float32ToBase64(embedding(1)), 10, "all", 6))).toEqual([]);
  });
});

/** The engine's own wait for a reweighting pass, when it has one; otherwise a pause long enough for a small pass. */
async function settle(engine: SearchEngine): Promise<void> {
  const settled = (engine as unknown as { settled?: () => Promise<void> }).settled;
  if (typeof settled === "function") await settled.call(engine);
  else await sleep(700);
}

interface Hold {
  reached: Promise<void>;
  release: () => void;
}

/** Holds the first reweighting scroll after Qdrant has answered it, as a slow response would. */
function holdReweightScroll(q: Qdrant): Hold {
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  const open = new Promise<void>((resolve) => { release = resolve; });
  const original = q.call.bind(q);
  let held = false;
  q.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const result = await original<T>(method, path, body);
    const withPayload = (body as { with_payload?: unknown } | undefined)?.with_payload;
    if (!held && path.endsWith("/points/scroll") && Array.isArray(withPayload) && withPayload.includes("terms")) {
      held = true;
      signal();
      await open;
    }
    return result;
  };
  return { reached, release };
}

const shortTitle = "zebraquartz";
const longTitle = Array.from({ length: 40 }, (_, i) => `term${i}`).join(" ");

/** Five short documents, so the mean the stored weights use is small. */
async function seedShort(r: Rig): Promise<void> {
  await r.engine.apply(Array.from({ length: 5 }, (_, i) => docOp(`obs_s${i}`, shortTitle)));
  await settle(r.engine);
}

/** Five long documents: the corpus mean drifts far past the band, which starts a reweighting pass. */
async function addLong(r: Rig): Promise<void> {
  await r.engine.apply(Array.from({ length: 5 }, (_, i) => docOp(`obs_l${i}`, longTitle)));
}

async function waitFor(condition: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(100);
  }
  return condition();
}

describe.skipIf(!QDRANT_URL)("behaviour 5: a corrupt stored terms payload is skipped point by point", () => {
  it("reweights the rest of the page and completes the pass", async () => {
    const r = await rig("corrupt_terms");
    await seedShort(r);
    const before = Number((await stored(r, "obs_s1"))!.ad);
    await r.q.call("POST", `${r.q.path}/points/payload?wait=true`, { payload: { terms: [1, 2, 3] }, points: [pointId("obs_s0")] });

    await addLong(r);

    const reweighted = await waitFor(async () => Number((await stored(r, "obs_s1"))?.ad) > before * 3, 8_000);
    expect(reweighted).toBe(true);
    expect(Number((await stored(r, "obs_l0"))!.ad)).toBeGreaterThan(before * 3);
    expect(ids(await r.engine.keyword(shortTitle, 20, "all"))).toContain("obs_s1");
  }, 20_000);
});

describe.skipIf(!QDRANT_URL)("behaviour 6: clear(all) stops a running reweighting pass", () => {
  it("sends no further request for the old pass to the new collection", async () => {
    const r = await rig("clear_during_pass");
    await seedShort(r);
    const hold = holdReweightScroll(r.q);
    await addLong(r);
    await hold.reached;

    await r.engine.clear("all");
    const afterClear: string[] = [];
    const original = r.q.call.bind(r.q);
    r.q.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      afterClear.push(`${method} ${path}`);
      return original<T>(method, path, body);
    };
    hold.release();
    await settle(r.engine);
    await sleep(300);

    expect(afterClear.filter((call) => call.includes("/points/batch") || call.includes("/points/scroll"))).toEqual([]);
    expect((await r.engine.stats()).docs).toBe(0);
  }, 20_000);
});

describe.skipIf(!QDRANT_URL)("behaviour 7: a keyword search never waits on a reweighting pass", () => {
  it("returns in well under a second while a pass is held", async () => {
    const r = await rig("search_during_pass");
    await seedShort(r);
    const hold = holdReweightScroll(r.q);
    try {
      await addLong(r);
      await hold.reached;

      const started = Date.now();
      const hits = await r.engine.keyword(shortTitle, 20, "all");
      const elapsed = Date.now() - started;

      expect(ids(hits).sort()).toEqual(["obs_s0", "obs_s1", "obs_s2", "obs_s3", "obs_s4"]);
      expect(elapsed).toBeLessThan(400);
    } finally {
      hold.release();
      await settle(r.engine);
    }
  }, 20_000);
});

// TEE-1164 fix round 2, behaviour 2: the conditional shapes the version fence
// relies on, pinned against a real Qdrant (1.20.2) through SearchEngine.apply.
// Each case names a Qdrant semantic the engine depends on; a Qdrant upgrade that
// changes one fails here instead of corrupting an index. Skipped unless
// QDRANT_URL is set.
import { afterAll, describe, expect, it } from "vitest";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { pointId, type Qdrant } from "../src/fork/worker/qdrant.js";
import { contentRev, type DocOp } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import type { CompressedObservation } from "../src/types.js";
import { DIMS, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const obs = (id: string, title: string): CompressedObservation => ({
  id, sessionId: "ses_cond", timestamp: "2026-11-18T00:00:00Z", title, narrative: "", type: "discovery", facts: [], concepts: [], files: [], importance: 5,
});
const docOp = (id: string, title: string): DocOp => {
  const fields = termSourceOf(obs(id, title));
  return { k: "doc", id, sessionId: "ses_cond", ts: 1, layer: "observation", fields, rev: contentRev(fields) };
};
const embedding = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed * 3 + i));
const vecOp = (op: DocOp, seed: number) => ({ k: "vec" as const, id: op.id, rev: op.rev, f32b64: float32ToBase64(embedding(seed)) });

interface StoredPoint { payload?: Record<string, unknown>; vector?: Record<string, unknown> }

const rigs: Qdrant[] = [];
async function rig(label: string): Promise<{ q: Qdrant; engine: SearchEngine; point: (id: string) => Promise<StoredPoint | undefined>; keyword: (query: string) => Promise<string[]>; vector: (seed: number) => Promise<string[]> }> {
  const q = qdrantFor(`cond_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await q.ensure();
  rigs.push(q);
  const engine = new SearchEngine(q, DEFAULT_AVGDL);
  return {
    q,
    engine,
    point: async (id) => (await q.call<StoredPoint[]>("POST", `${q.path}/points`, { ids: [pointId(id)], with_payload: true, with_vector: true }))[0],
    keyword: async (query) => (await engine.keyword(query, 20, "all")).map((h) => h.id),
    vector: async (seed) => (await engine.vector(float32ToBase64(embedding(seed)), 20, "all", 6)).map((h) => h.id),
  };
}

afterAll(async () => {
  for (const q of rigs) await q.drop();
}, 30_000);

const OLD = 1_000;
const NEW = 2_000;

describe.skipIf(!QDRANT_URL)("Qdrant honours the conditional shapes the version fence uses", () => {
  it("a document write inserts a point that is absent", async () => {
    const r = await rig("absent");
    const result = await r.engine.apply([docOp("obs_new", "insertedalpha")], NEW);
    expect(result.failed).toEqual([]);
    expect(await r.keyword("insertedalpha")).toEqual(["obs_new"]);
    expect((await r.point("obs_new"))?.payload).toMatchObject({ doc_id: "obs_new", v: NEW, dense: false });
  });

  it("a document write replaces an older tombstone", async () => {
    const r = await rig("tombstone_older");
    await r.engine.apply([{ k: "del", id: "obs_back" }], OLD);
    expect((await r.point("obs_back"))?.payload).toMatchObject({ deleted: true, v: OLD });
    await r.engine.apply([docOp("obs_back", "revivedbeta")], NEW);
    const stored = await r.point("obs_back");
    expect(stored?.payload?.deleted).toBeUndefined();
    expect(stored?.payload?.v).toBe(NEW);
    expect(await r.keyword("revivedbeta")).toEqual(["obs_back"]);
    expect((await r.engine.lookup(["obs_back"])).map((i) => i.id)).toEqual(["obs_back"]);
  });

  it("a document write leaves a newer tombstone in place", async () => {
    const r = await rig("tombstone_newer");
    await r.engine.apply([{ k: "del", id: "obs_gone" }], NEW);
    await r.engine.apply([docOp("obs_gone", "zombiegamma")], OLD);
    expect((await r.point("obs_gone"))?.payload).toMatchObject({ deleted: true, v: NEW });
    expect(await r.keyword("zombiegamma")).toEqual([]);
    expect(await r.engine.lookup(["obs_gone"])).toEqual([]);
  });

  it("a document write to a live point keeps its dense vector", async () => {
    const r = await rig("keeps_dense");
    const first = docOp("obs_dense", "denseone");
    await r.engine.apply([first, vecOp(first, 1)], OLD);
    const before = (await r.point("obs_dense"))!;
    expect(before.vector?.dense).toBeDefined();
    await r.engine.apply([docOp("obs_dense", "densetwo")], NEW);
    const after = (await r.point("obs_dense"))!;
    expect(after.payload).toMatchObject({ v: NEW, dense: true });
    expect(after.vector?.dense).toEqual(before.vector?.dense);
    expect(await r.keyword("densetwo")).toEqual(["obs_dense"]);
    expect(await r.vector(1)).toEqual(["obs_dense"]);
  });

  it("a document write older than the stored version changes nothing", async () => {
    const r = await rig("doc_older");
    await r.engine.apply([docOp("obs_doc", "currentdelta")], NEW);
    const before = await r.point("obs_doc");
    await r.engine.apply([docOp("obs_doc", "staleepsilon")], OLD);
    expect(await r.point("obs_doc")).toEqual(before);
    expect(await r.keyword("currentdelta")).toEqual(["obs_doc"]);
    expect(await r.keyword("staleepsilon")).toEqual([]);
  });

  it("a delete older than the stored version leaves the point live", async () => {
    const r = await rig("del_older");
    await r.engine.apply([docOp("obs_live", "survivorzeta")], NEW);
    const before = await r.point("obs_live");
    await r.engine.apply([{ k: "del", id: "obs_live" }], OLD);
    expect(await r.point("obs_live")).toEqual(before);
    expect(await r.keyword("survivorzeta")).toEqual(["obs_live"]);
  });

  it("a vector write older than the stored version neither claims the point nor replaces its vector", async () => {
    const r = await rig("vec_older");
    const doc = docOp("obs_vec", "vectoreta");
    await r.engine.apply([doc, vecOp(doc, 1)], NEW);
    const before = await r.point("obs_vec");
    await r.engine.apply([vecOp(doc, 2)], OLD);
    expect(await r.point("obs_vec")).toEqual(before);
  });

  it("a vector delete older than the stored version leaves the vector and its flag", async () => {
    const r = await rig("vecdel_older");
    const doc = docOp("obs_vd", "vectortheta");
    await r.engine.apply([doc, vecOp(doc, 1)], NEW);
    const before = await r.point("obs_vd");
    await r.engine.apply([{ k: "vec-del", id: "obs_vd" }], OLD);
    expect(await r.point("obs_vd")).toEqual(before);
    expect(await r.vector(1)).toEqual(["obs_vd"]);
  });

  it("a vector delete at a newer version removes only the dense vector", async () => {
    const r = await rig("vecdel_newer");
    const doc = docOp("obs_vn", "vectoriota");
    await r.engine.apply([doc, vecOp(doc, 1)], OLD);
    await r.engine.apply([{ k: "vec-del", id: "obs_vn" }], NEW);
    const after = (await r.point("obs_vn"))!;
    expect(after.vector?.dense).toBeUndefined();
    expect(after.vector?.bm25).toBeDefined();
    expect(after.payload).toMatchObject({ v: NEW, dense: false });
    expect(await r.keyword("vectoriota")).toEqual(["obs_vn"]);
    expect(await r.vector(1)).toEqual([]);
  });
});

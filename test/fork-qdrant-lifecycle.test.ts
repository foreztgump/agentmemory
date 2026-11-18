// TEE-1161 spike S3: the point lifecycle the am-search worker needs, against a live
// Qdrant in the planned collection shape. Skipped unless QDRANT_URL is set, e.g.
//   bench/fork/qdrant/spike.sh up 1g && QDRANT_URL=http://127.0.0.1:16333 npx vitest run test/fork-qdrant-lifecycle.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCollection, DIMS, normalize, qdrant, uuidOf, type Sparse } from "../bench/fork/qdrant/lib.js";

const C = `s3_lifecycle_${process.pid}`;
const A = uuidOf(1);
const ABSENT = uuidOf(2);

interface Point {
  id: string;
  payload: Record<string, unknown>;
  vector: { dense?: number[]; bm25?: Sparse };
}

function dense(seed: number): number[] {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin(seed * 1000 + i);
  return Array.from(normalize(v));
}

const sparse = (pairs: Array<[number, number]>): Sparse => ({ indices: pairs.map(([i]) => i), values: pairs.map(([, v]) => v) });
const sorted = (s: Sparse | undefined) => (s ? s.indices.map((i, k) => [i, s.values[k]] as const).sort((a, b) => a[0] - b[0]) : undefined);

async function get(id: string): Promise<Point | undefined> {
  const [point] = await qdrant<Point[]>("POST", `/collections/${C}/points`, { ids: [id], with_vector: true, with_payload: true });
  return point;
}

// Writes one named vector, creating the point (with its payload) when absent and
// leaving every other vector and the payload alone when present. One request:
// an insert_only upsert, then update_vectors, in one ordered batch.
async function writeVector(id: string, vector: Point["vector"], payload: Record<string, unknown>): Promise<void> {
  await qdrant("POST", `/collections/${C}/points/batch?wait=true`, {
    operations: [
      { upsert: { points: [{ id, vector, payload }], update_mode: "insert_only" } },
      { update_vectors: { points: [{ id, vector }] } },
    ],
  });
}

async function denseHits(query: number[]): Promise<string[]> {
  const res = await qdrant<{ points: Array<{ id: string }> }>("POST", `/collections/${C}/points/query`, {
    query, using: "dense", limit: 10, params: { exact: true },
  });
  return res.points.map((p) => p.id);
}

async function keywordHits(query: Sparse): Promise<string[]> {
  const res = await qdrant<{ points: Array<{ id: string }> }>("POST", `/collections/${C}/points/query`, { query, using: "bm25", limit: 10 });
  return res.points.map((p) => p.id);
}

describe.skipIf(!process.env.QDRANT_URL)("Qdrant point lifecycle (spike S3)", () => {
  const payload = { doc_id: "obs_1", session_id: "ses_1", layer: "observation", ts: 1, dense: true };

  beforeAll(async () => {
    await createCollection(C);
    await qdrant("PUT", `/collections/${C}/points?wait=true`, {
      points: [
        { id: A, vector: { dense: dense(1), bm25: sparse([[10, 1.5], [20, 0.5]]) }, payload },
        { id: uuidOf(3), vector: { dense: dense(3), bm25: sparse([[30, 1]]) }, payload: { ...payload, doc_id: "obs_3" } },
      ],
    });
  });

  afterAll(async () => {
    await qdrant("DELETE", `/collections/${C}`).catch(() => {});
  });

  it("updates only the sparse vector, keeping the dense vector and payload", async () => {
    const before = (await get(A))!;
    await qdrant("PUT", `/collections/${C}/points/vectors?wait=true`, { points: [{ id: A, vector: { bm25: sparse([[40, 2]]) } }] });
    const after = (await get(A))!;
    expect(sorted(after.vector.bm25)).toEqual([[40, 2]]);
    expect(after.vector.dense).toEqual(before.vector.dense);
    expect(after.payload).toEqual(payload);
  });

  it("updates only the dense vector, keeping the sparse vector and payload", async () => {
    const before = (await get(A))!;
    await qdrant("PUT", `/collections/${C}/points/vectors?wait=true`, { points: [{ id: A, vector: { dense: dense(9) } }] });
    const after = (await get(A))!;
    expect(after.vector.dense).not.toEqual(before.vector.dense);
    expect(after.vector.dense![0]).toBeCloseTo(dense(9)[0]!, 3);
    expect(sorted(after.vector.bm25)).toEqual(sorted(before.vector.bm25));
    expect(after.payload).toEqual(payload);
  });

  it("refuses update_vectors on an absent point, so creation needs the insert_only upsert", async () => {
    await expect(
      qdrant("PUT", `/collections/${C}/points/vectors?wait=true`, { points: [{ id: ABSENT, vector: { bm25: sparse([[50, 1]]) } }] }),
    ).rejects.toThrow(/404|not found/i);
    expect(await get(ABSENT)).toBeUndefined();
  });

  it("creates the point when absent with one named vector, and leaves an existing point's other vector and payload alone", async () => {
    await writeVector(ABSENT, { bm25: sparse([[50, 1]]) }, { ...payload, doc_id: "obs_2", dense: false });
    const created = (await get(ABSENT))!;
    expect(sorted(created.vector.bm25)).toEqual([[50, 1]]);
    expect(created.vector.dense).toBeUndefined();
    expect(created.payload.doc_id).toBe("obs_2");

    const before = (await get(A))!;
    await writeVector(A, { bm25: sparse([[60, 1]]) }, { doc_id: "would-clobber" });
    const after = (await get(A))!;
    expect(sorted(after.vector.bm25)).toEqual([[60, 1]]);
    expect(after.vector.dense).toEqual(before.vector.dense);
    expect(after.payload).toEqual(payload);
  });

  it("deletes only the dense vector: keyword search still finds the point, vector search does not", async () => {
    const query = (await get(A))!.vector.dense!;
    expect((await denseHits(query))[0]).toBe(A);
    await qdrant("POST", `/collections/${C}/points/vectors/delete?wait=true`, { points: [A], vector: ["dense"] });
    const after = (await get(A))!;
    expect(after.vector.dense).toBeUndefined();
    expect(sorted(after.vector.bm25)).toEqual([[60, 1]]);
    expect(after.payload).toEqual(payload);
    expect(await keywordHits(sparse([[60, 1]]))).toEqual([A]);
    expect(await denseHits(query)).not.toContain(A);
  });
});

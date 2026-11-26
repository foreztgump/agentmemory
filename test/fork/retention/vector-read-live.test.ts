// The stored-vector read against a real Qdrant: what restore (R3) puts back is what the collection holds.
// Skipped unless QDRANT_URL is set.
import { afterAll, describe, expect, it } from "vitest";
import { DocLedger, SearchOutbox } from "../../../src/fork/search/outbox.js";
import { BackendHealth } from "../../../src/fork/search/health.js";
import { RemoteKeywordIndex, RemoteVectorStore, READ_VECTORS_BATCH, StatsCache } from "../../../src/fork/search/remote-index.js";
import { vectorReaderFor } from "../../../src/fork/retention/vectors.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import type { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { base64ToFloat32, float32ToBase64 } from "../../../src/state/vector-index.js";
import type { CompressedObservation } from "../../../src/types.js";
import { DIMS, engineClient, QDRANT_URL, qdrantFor } from "../../helpers/search-engine.js";

const obs = (id: string): CompressedObservation => ({
  id, sessionId: "ses_read", timestamp: "2026-11-26T00:00:00Z", title: `title ${id}`, narrative: "", type: "discovery", facts: [], concepts: [], files: [], importance: 5,
});

// Qdrant stores a cosine collection's vectors normalized, in float16. A unit vector of +-1/4 components
// (16 of them) is its own normalization and float16 holds it exactly, so it must come back bit for bit.
// The sign pattern is the seed's bits, so every seed below 2^16 is a different vector.
const stable = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => ((seed >> i) & 1 ? 0.25 : -0.25));
const arbitrary = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed * 3 + i));
const unit = (v: Float32Array) => {
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

const HALF_EPSILON = 2 ** -10;
const HALF_SMALLEST = 2 ** -24;

const collections: Qdrant[] = [];
afterAll(async () => {
  for (const q of collections) await q.drop();
}, 30_000);

async function rig() {
  const q = qdrantFor(`vecread_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await q.ensure();
  collections.push(q);
  const client = engineClient(new SearchEngine(q, DEFAULT_AVGDL));
  const outbox = new SearchOutbox(client, { maxOps: 5000, maxBytes: 64 << 20, flushMs: 5, batch: 256 });
  const ledger = new DocLedger();
  const stats = new StatsCache(client, outbox);
  const health = new BackendHealth();
  const keyword = new RemoteKeywordIndex(client, outbox, ledger, stats, health);
  const vector = new RemoteVectorStore(client, outbox, ledger, stats, health);
  const put = (id: string, embedding: Float32Array) => {
    keyword.add(obs(id), "observation");
    vector.add(id, "ses_read", embedding);
  };
  const settle = () => outbox.drainFor(30_000);
  return { vector, keyword, put, settle, reader: vectorReaderFor(vector) };
}

describe.skipIf(!QDRANT_URL)("vectorReaderFor over a disk-mode store", () => {
  it("returns a unit vector float16 can hold bit for bit", async () => {
    const r = await rig();
    r.put("obs_exact", stable(3));
    await r.settle();
    const read = await r.reader.read(["obs_exact"]);
    expect(read.get("obs_exact")).toBe(float32ToBase64(stable(3)));
  });

  it("returns an arbitrary embedding normalized, at float16 precision, and writing it back changes nothing", async () => {
    const r = await rig();
    const original = arbitrary(1);
    r.put("obs_a", original);
    await r.settle();
    const first = base64ToFloat32((await r.reader.read(["obs_a"])).get("obs_a")!);
    const expected = unit(original);
    expect(first).not.toEqual(expected);
    first.forEach((value, i) => expect(Math.abs(value - expected[i]!)).toBeLessThanOrEqual(Math.max(Math.abs(expected[i]!) * HALF_EPSILON, HALF_SMALLEST)));

    r.vector.add("obs_a", "ses_read", first);
    await r.settle();
    expect(base64ToFloat32((await r.reader.read(["obs_a"])).get("obs_a")!)).toEqual(first);
  });

  it("leaves out a vector that was removed, a document that was deleted and an id never stored", async () => {
    const r = await rig();
    r.put("obs_keep", stable(1));
    r.put("obs_unvec", stable(2));
    r.put("obs_deleted", stable(4));
    await r.settle();
    r.vector.remove("obs_unvec");
    r.keyword.remove("obs_deleted");
    await r.settle();
    const read = await r.reader.read(["obs_keep", "obs_unvec", "obs_deleted", "obs_never"]);
    expect([...read.keys()]).toEqual(["obs_keep"]);
  });

  it("reads more ids than one batch holds", async () => {
    const r = await rig();
    const ids = Array.from({ length: READ_VECTORS_BATCH + 20 }, (_, i) => `obs_${i}`);
    ids.forEach((id, i) => r.put(id, stable(i)));
    await r.settle();
    const read = await r.reader.read(ids);
    expect(read.size).toBe(ids.length);
    ids.forEach((id, i) => expect(read.get(id)).toBe(float32ToBase64(stable(i))));
  });
});

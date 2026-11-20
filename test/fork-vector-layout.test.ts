import { describe, expect, it } from "vitest";
import { IndexPersistence, vectorBucketScope } from "../src/state/index-persistence.js";
import { KV } from "../src/state/schema.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { BUCKET_SCOPE_PREFIX, bucketOfScope, PENDING_SCOPE, STATE_PREFIX } from "../src/fork/search/persisted-vectors.js";
import { planVectors } from "../scripts/fork/search-migrate.js";
import { FakeRedis, type Store } from "./helpers/fake-redis.js";

const DIMS = 8;
const vec = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 7 + i));

function memoryKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
    listGroups: async (): Promise<string[]> => [...store.keys()].sort(),
  };
}

/** The iii redis adapter's layout: one hash per scope, `state:<scope>`, each value its JSON. */
function asRedis(kv: ReturnType<typeof memoryKV>): FakeRedis {
  const data: Store = new Map();
  for (const [scope, rows] of kv.store) {
    data.set(STATE_PREFIX + scope, new Map([...rows].map(([key, value]) => [key, Buffer.from(JSON.stringify(value))])));
  }
  return new FakeRedis(data);
}

// A tripwire: upstream's own writer produces the store the disk migration reads.
// When upstream changes where or how it persists vectors, this fails.
describe("persisted vector layout", () => {
  it("names the bucket and pending-log scopes the migration reads", () => {
    expect(vectorBucketScope(0)).toBe("mem:index:bm25:vec:0000");
    expect(vectorBucketScope(12)).toBe("mem:index:bm25:vec:0012");
    expect(BUCKET_SCOPE_PREFIX).toBe("mem:index:bm25:vec:");
    expect(bucketOfScope(vectorBucketScope(394))).toBe(394);
    expect(bucketOfScope("mem:index:bm25:vec:pending")).toBeNull();
    expect(PENDING_SCOPE).toBe(KV.vectorPendingLog);
    expect(KV.vectorPendingLog).toBe("mem:index:vec-pending");
  });

  it("plans the same vectors upstream's own boot loads, from buckets plus the pending log", async () => {
    const kv = memoryKV();
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(kv as never, vector, { bucketSize: 2 });
    vector.add("obs_a", "ses_1", vec(1));
    vector.add("obs_b", "ses_1", vec(2));
    vector.add("mem_c", "memory", vec(3));
    await persistence.save();
    // After the checkpoint: a replaced vector and a removal that only the pending log holds.
    vector.add("obs_a", "ses_1", vec(4));
    vector.remove("obs_b");
    await persistence.flushPendingLog();
    persistence.stop();

    const buckets = [...kv.store.keys()].filter((scope) => bucketOfScope(scope) !== null);
    expect(buckets.length).toBe(2);
    for (const scope of buckets) {
      for (const row of kv.store.get(scope)!.values()) expect(Object.keys(row as object).sort()).toEqual(["e", "id", "s"]);
    }
    expect([...(kv.store.get(PENDING_SCOPE)?.keys() ?? [])].sort()).toEqual(["obs_a", "obs_b"]);

    const plan = await planVectors(asRedis(kv), DIMS, 1);
    const booted = new VectorIndex();
    const reloaded = new IndexPersistence(kv as never, booted, { bucketSize: 2 });
    const loaded = await reloaded.load();
    for (const [id, entry] of loaded.vector!.entries()) booted.loadPersisted(id, entry.sessionId, entry.embedding);
    await reloaded.replayPendingLog(DIMS);
    reloaded.stop();

    expect([...plan.winners.keys()].sort()).toEqual([...booted.entries()].map(([id]) => id).sort());
    expect(plan.winners.get("obs_a")!.source).toBe("pending");
    expect(plan.winners.has("obs_b")).toBe(false);
    expect(plan.report).toMatchObject({ bucketScopes: 2, bucketRows: 3, pendingRows: 2, malformed: 0, pendingVectors: 1, pendingDeletes: 1, docs: 2 });
  });
});

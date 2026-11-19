// TEE-1164 round 3: the findings of the Open Code Review passes that still hold at HEAD,
// each pinned by a run. Cases that fail on 915ddd3 are the proven defects; the rest pin
// the state the review checked. Qdrant cases are skipped unless QDRANT_URL is set:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-round3.test.ts
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { pointId, type Qdrant } from "../src/fork/worker/qdrant.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../src/fork/search/runtime.js";
import type { SearchWorkerClient } from "../src/fork/search/client.js";
import { SearchOutbox } from "../src/fork/search/outbox.js";
import { contentRev, type DocOp, type VecOp } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL, loadSearchWorkerSettings } from "../src/fork/search/settings.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import { createSearchRuntime, registerSearchBackend } from "../src/state/search-ports.js";
import { rebuildKeywordIndex, setEmbeddingProvider, setVectorIndex } from "../src/functions/search.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import type { CompressedObservation } from "../src/types.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import { engineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const obs = (id: string, title: string, sessionId = "ses_r3"): CompressedObservation => ({
  id, sessionId, timestamp: "2026-11-18T00:00:00Z", title, narrative: "", type: "discovery", facts: [], concepts: [], files: [], importance: 5,
});
const docOp = (id: string, title: string): DocOp => {
  const fields = termSourceOf(obs(id, title));
  return { k: "doc", id, sessionId: "ses_r3", ts: 1, layer: "observation", fields, rev: contentRev(fields) };
};
const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);
const obsIds = (hits: Array<{ obsId: string }>) => hits.map((h) => h.obsId);

interface Rig {
  q: Qdrant;
  engine: SearchEngine;
  runtime?: DiskSearchRuntime;
}
const rigs: Rig[] = [];
async function rig(label: string): Promise<Rig> {
  const q = qdrantFor(`round3_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
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
    await r.runtime?.outbox.stop(100);
    await r.q.drop();
  }
}, 60_000);

// A record that predates a field (no facts, concepts or files) reaches the worker as is:
// termSourceOf copies the field it finds, so the worker sees `fields` without the arrays.
const withoutArrays = (op: DocOp): DocOp => ({ ...op, fields: { title: "malformedfields", narrative: "", type: "discovery" } as DocOp["fields"] });

describe.skipIf(!QDRANT_URL)("ocr p1 engine.ts:106-107: a malformed doc op does not poison its batch", () => {
  it("reports the malformed doc in failed and still applies the valid ops of the batch", async () => {
    const r = await rig("poison_engine");
    const bad = withoutArrays(docOp("obs_bad", "x"));
    const good = docOp("obs_good", "goodcontent");
    const result = await r.engine.apply([bad, good]);
    expect(result.failed.map((f) => f.id)).toEqual(["obs_bad"]);
    expect(ids(await r.engine.keyword("goodcontent", 10, "all"))).toEqual(["obs_good"]);
  });

  it("delivers the valid writes queued beside a malformed observation instead of retrying the batch forever", async () => {
    const r = await rig("poison_outbox");
    const runtime = (r.runtime = createDiskSearchRuntime(engineClient(r.engine), false));
    const malformed = { ...obs("obs_bad", "x"), facts: undefined, concepts: undefined, files: undefined } as unknown as CompressedObservation;
    runtime.keyword.add(malformed);
    runtime.keyword.add(obs("obs_good", "goodcontent"));
    await runtime.outbox.drainFor(3000);
    expect(runtime.outbox.pending).toBe(0);
    expect(obsIds(await runtime.keyword.search("goodcontent"))).toEqual(["obs_good"]);
  }, 20_000);
});

describe("ocr p1 settings.ts:35: AM_SEARCH_DIMENSIONS must be a whole number", () => {
  const env = (dimensions: string) => ({ AM_QDRANT_URL: "http://qdrant:6333", AM_SEARCH_DIMENSIONS: dimensions });

  it("rejects a fractional value at boot instead of flooring it to zero", () => {
    expect(() => loadSearchWorkerSettings(env("0.4"))).toThrow(/AM_SEARCH_DIMENSIONS/);
  });

  it("rejects a fractional value above one instead of silently truncating it", () => {
    expect(() => loadSearchWorkerSettings(env("1024.5"))).toThrow(/AM_SEARCH_DIMENSIONS/);
  });

  it("accepts a whole number", () => {
    expect(loadSearchWorkerSettings(env("384")).dimensions).toBe(384);
  });
});

describe.skipIf(!QDRANT_URL)("ocr p2 remember.ts:101: memory_save supersession while the search worker is unreachable", () => {
  async function saveTwice(label: string, workerDownForSecond: boolean) {
    const r = await rig(label);
    let down = false;
    const live = engineClient(r.engine);
    const client = Object.fromEntries(
      Object.entries(live).map(([name, fn]) => [
        name,
        (...args: unknown[]) => (down ? Promise.reject(new Error("worker unreachable")) : (fn as (...a: unknown[]) => unknown)(...args)),
      ]),
    ) as unknown as SearchWorkerClient;
    const runtime = (r.runtime = createDiskSearchRuntime(client, false));
    registerSearchBackend("disk", () => runtime);
    const kv = mockKV();
    createSearchRuntime({ kv: kv as never, embeddingProvider: null }, "disk");
    await rebuildKeywordIndex(kv as never);
    const sdk = mockSdk({ looseTrigger: true });
    registerRememberFunction(sdk as never, kv as never);

    const first = (await sdk.trigger("mem::remember", {
      content: "the deploy pipeline uses blue green rollout with health gates",
      type: "architecture",
    })) as { memory: { id: string } };
    await runtime.outbox.drainFor(5000);
    await runtime.stats.refresh();
    down = workerDownForSecond;

    const second = (await sdk.trigger("mem::remember", {
      content: "the deploy pipeline uses blue green rollout with health gates always",
      type: "architecture",
    })) as { memory: { id: string; supersedes?: string[] } };
    return { first, second };
  }

  it("supersedes a near-duplicate memory while the worker is up", async () => {
    const { first, second } = await saveTwice("remember_up", false);
    expect(second.memory.supersedes).toContain(first.memory.id);
  }, 30_000);

  // Deferred to TEE-1169 (degraded status): flips to a failure once that issue fixes it.
  it.fails("still supersedes a near-duplicate memory when the worker cannot be reached", async () => {
    const { first, second } = await saveTwice("remember_outage", true);
    expect(second.memory.supersedes).toContain(first.memory.id);
  }, 30_000);
});

describe.skipIf(!QDRANT_URL)("ocr p2 ac6.ts:125: what a forgotten id leaves in Qdrant", () => {
  // bench/fork/qdrant/ac6.ts waits for `!point` after a forget. The worker deletes by
  // tombstone, so the point stays and that probe can never succeed on a healthy system.
  it("leaves a tombstone point that /points still returns, with no vectors and deleted: true", async () => {
    const r = await rig("tombstone_probe");
    await r.engine.apply([docOp("obs_forgotten", "forgottentopic")]);
    await r.engine.apply([{ k: "del", id: "obs_forgotten" }]);
    const [point] = await r.q.call<Array<{ vector?: { dense?: number[] }; payload?: Record<string, unknown> }>>("POST", `${r.q.path}/points`, {
      ids: [pointId("obs_forgotten")],
      with_vector: ["dense"],
      with_payload: ["dense", "deleted"],
    });
    expect(point).toBeDefined();
    expect(point!.payload).toMatchObject({ deleted: true, dense: false });
    expect(point!.vector?.dense).toBeUndefined();
  });
});

describe("ocr p1 outbox.ts:99-102: byte accounting after a vectors-only clear", () => {
  // Spilling is decided only while the worker is unreachable, so the leak shows only against a client that fails.
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const bigVector = float32ToBase64(new Float32Array(1000));
  const doc = (id: string): DocOp => docOp(id, "t");
  const vec = (id: string): VecOp => ({ k: "vec", id, rev: doc(id).rev, f32b64: bigVector });

  it("frees the bytes of cleared vectors on slots that keep their document, so later writes are not spilled", async () => {
    const down = async () => { throw new Error("worker unreachable"); };
    const client = { apply: down, clear: down } as unknown as SearchWorkerClient;
    const outbox = new SearchOutbox(client, { maxOps: 100, maxBytes: bigVector.length * 2 + 1500, flushMs: 1, batch: 256 });
    outbox.put(doc("a"));
    outbox.put(vec("a"));
    await sleep(30);
    outbox.put(doc("b"));
    outbox.put(vec("b"));
    outbox.clear("vectors");
    outbox.put(doc("c"));
    outbox.put(vec("c"));
    outbox.put(doc("d"));
    outbox.put(vec("d"));
    expect(outbox.counters.spilled).toBe(0);
    expect(outbox.pending).toBe(5);
    await outbox.stop(0);
  });
});

// Stage C in disk mode against a live Qdrant (R8 for demote, and un-demote without an embedding call). Skipped unless QDRANT_URL is set:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork/retention/demote-disk.test.ts
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { displace, recoverRun } from "../../../src/fork/retention/move.js";
import { restoreItems } from "../../../src/fork/retention/restore.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../../../src/fork/search/runtime.js";
import type { SearchWorkerClient } from "../../../src/fork/search/client.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import type { ServiceHooks } from "../../../src/fork/search/backend-status.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import type { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { setEmbeddingProvider, setVectorIndex, vectorIndexAddBatchGuarded } from "../../../src/functions/search.js";
import { createSearchRuntime, registerSearchBackend } from "../../../src/state/search-ports.js";
import { KV } from "../../../src/state/schema.js";
import { memoryToObservation } from "../../../src/state/memory-utils.js";
import { base64ToFloat32 } from "../../../src/state/vector-index.js";
import type { EmbeddingProvider, Memory } from "../../../src/types.js";
import { DIMS, engineClient, QDRANT_URL, qdrantFor } from "../../helpers/search-engine.js";
import { RUN, candidate, memory, openRun, rig, type Rig } from "./move-fixtures.js";
import type { DemoteRecord } from "../../../src/fork/retention/types.js";

const NO_TIMERS = { reconcileIntervalMs: 0, sweepPerPass: 3, reembedPerMinute: 6000 };
// Qdrant keeps a cosine vector normalized at float16, so a unit vector of +-1/4 components round-trips bit for bit.
const stable = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => ((seed >> i) & 1 ? 0.25 : -0.25));
let embedCalls = 0;
const provider = {
  name: "spy",
  dimensions: DIMS,
  embed: async () => { embedCalls++; return new Float32Array(DIMS).fill(0.5); },
  embedBatch: async (texts: string[]) => { embedCalls += texts.length; return texts.map(() => Float32Array.from({ length: DIMS }, (_, d) => (d === 0 ? 1 : 0.1))); },
} as unknown as EmbeddingProvider;

interface DiskRig { q: Qdrant; engine: SearchEngine; runtime: DiskSearchRuntime; r: Rig }
const rigs: DiskRig[] = [];

async function diskRig(label: string): Promise<DiskRig> {
  const q = qdrantFor(`demote_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await q.ensure();
  const engine = new SearchEngine(q, DEFAULT_AVGDL);
  const runtime = createDiskSearchRuntime(engineClient(engine) as unknown as SearchWorkerClient, true, DIMS, undefined, NO_TIMERS);
  registerSearchBackend("disk", () => runtime);
  createSearchRuntime({ kv: {} as never, embeddingProvider: provider }, "disk");
  setVectorIndex(runtime.vector);
  setEmbeddingProvider(provider);
  const r = rig(() => runtime);
  const hooks: ServiceHooks = { kv: r.kv as never, embedBatch: vectorIndexAddBatchGuarded, embeddingEnabled: () => runtime.vector !== null };
  runtime.service.start(hooks);
  const d = { q, engine, runtime, r };
  rigs.push(d);
  return d;
}

const settle = (d: DiskRig) => d.runtime.outbox.drainFor(10_000);
const keyword = async (d: DiskRig, query: string) => (await d.runtime.keyword.search(query, 10)).map((h) => h.obsId).sort();
const nearest = async (d: DiskRig, seed: number) => (await d.runtime.vector!.search(stable(seed), 10)).map((h) => h.obsId).sort();
const memoryDocIds = async (d: DiskRig) => (await d.engine.scanDocs(undefined, undefined, 1000)).items.map((x) => x.id).sort();

async function index(d: DiskRig, row: Memory, seed: number): Promise<void> {
  d.runtime.keyword.add(memoryToObservation(row), "memory");
  d.runtime.vector!.add(row.id, memoryToObservation(row).sessionId, stable(seed));
  await settle(d);
}

async function seedCold(d: DiskRig): Promise<Memory[]> {
  const rows = [memory("mem_cold", { forgetAfter: undefined }), memory("mem_warm", { forgetAfter: undefined })];
  for (const [i, row] of rows.entries()) {
    await d.r.kv.set(KV.memories, row.id, row);
    await index(d, row, i + 1);
  }
  return rows;
}

afterEach(() => {
  setEmbeddingProvider(null);
  setVectorIndex(null);
  createSearchRuntime({ kv: {} as never, embeddingProvider: null }, "memory");
});
afterAll(async () => {
  for (const d of rigs) {
    await d.runtime.service.stop();
    d.runtime.stats.stop();
    await d.runtime.outbox.stop(100);
    await d.q.drop();
  }
}, 60_000);

describe.skipIf(!QDRANT_URL)("stage C in disk mode", () => {
  it("a demoted memory leaves keyword and vector recall at once and stays in KV, and un-demote brings it back from the stored vector without an embedding call", async () => {
    const d = await diskRig("roundtrip");
    const { r } = d;
    await openRun(r);
    const [cold] = await seedCold(d);
    expect(await keyword(d, "okapi")).toEqual(["mem_cold", "mem_warm"]);
    expect(await nearest(d, 1)).toContain("mem_cold");
    embedCalls = 0;

    expect((await displace(r.deps, r.vault, RUN, await candidate(r, "C", cold!))).moved).toBe(true);
    await settle(d);

    expect(await keyword(d, "okapi")).toEqual(["mem_warm"]);
    expect(await nearest(d, 1)).not.toContain("mem_cold");
    expect(await memoryDocIds(d)).toEqual(["mem_warm"]);
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(true);
    const record = (await r.kv.get<DemoteRecord>(RETENTION_KV.demoted, "mem_cold"))!;
    expect(base64ToFloat32(record.vector!)).toEqual(stable(1));

    const result = await restoreItems(r.deps, [{ kind: "memory", id: "mem_cold" }], "test");
    await settle(d);

    expect(result).toMatchObject({ restored: 1, reembedNeeded: 0 });
    expect(await r.kv.get(KV.memories, "mem_cold")).toEqual(cold);
    expect(await keyword(d, "okapi")).toEqual(["mem_cold", "mem_warm"]);
    expect(await nearest(d, 1)).toContain("mem_cold");
    expect(await d.engine.stats()).toMatchObject({ vectors: 2, missingVectors: 0 });
    await d.runtime.reembed.step();
    await settle(d);
    expect(embedCalls).toBe(0);
    expect(d.runtime.reembed.report()).toMatchObject({ embedded: 0, failed: 0 });
  }, 60_000);

  it("R8: after a demote, reconcile passes and the re-embed loop add nothing back", async () => {
    const d = await diskRig("r8");
    const { r } = d;
    await openRun(r);
    const [cold] = await seedCold(d);
    await displace(r.deps, r.vault, RUN, await candidate(r, "C", cold!));
    await settle(d);
    embedCalls = 0;

    await d.runtime.reconciler.runPass();
    await d.runtime.reembed.step();
    await d.runtime.reconciler.runPass();
    await settle(d);

    expect(await memoryDocIds(d)).toEqual(["mem_warm"]);
    expect(await keyword(d, "okapi")).toEqual(["mem_warm"]);
    expect(d.runtime.reconciler.report()).toMatchObject({ added: 0, error: null });
    expect(d.runtime.reconciler.missing()).toEqual({ observations: 0, memories: 0 });
    expect(embedCalls).toBe(0);
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(true);
  }, 60_000);

  it("a document of a demoted memory that a lost removal left in the index is deleted by the next reconcile pass", async () => {
    const d = await diskRig("leaked");
    const { r } = d;
    await openRun(r);
    const [cold] = await seedCold(d);
    await displace(r.deps, r.vault, RUN, await candidate(r, "C", cold!));
    await index(d, cold!, 1);
    expect(await memoryDocIds(d)).toEqual(["mem_cold", "mem_warm"]);

    await d.runtime.reconciler.runPass();
    await settle(d);

    expect(await memoryDocIds(d)).toEqual(["mem_warm"]);
    expect(d.runtime.reconciler.report()).toMatchObject({ deleted: 1 });
  }, 60_000);

  it("recoverRun takes a document the crashed demote left behind out of Qdrant, and the row stays marked", async () => {
    const d = await diskRig("recover");
    const { r } = d;
    await openRun(r);
    const [cold] = await seedCold(d);
    await displace(r.deps, r.vault, RUN, await candidate(r, "C", cold!));
    await index(d, cold!, 1);

    expect(await recoverRun(r.deps, r.vault, RUN)).toMatchObject({ detachedAgain: 1 });
    await settle(d);

    expect(await memoryDocIds(d)).toEqual(["mem_warm"]);
    expect(await nearest(d, 1)).not.toContain("mem_cold");
  }, 60_000);
});

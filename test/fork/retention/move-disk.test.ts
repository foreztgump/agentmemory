// R3 and R8 in disk mode against a live Qdrant. Skipped unless QDRANT_URL is set:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork/retention/move-disk.test.ts
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { displace } from "../../../src/fork/retention/move.js";
import { restoreRun } from "../../../src/fork/retention/restore.js";
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
import type { CompressedObservation, EmbeddingProvider, Memory, Session } from "../../../src/types.js";
import { DIMS, engineClient, QDRANT_URL, qdrantFor } from "../../helpers/search-engine.js";
import { RUN, candidate, memory, observation, openRun, rig, seedSeal, seedSession, type Rig } from "./move-fixtures.js";

const NO_TIMERS = { reconcileIntervalMs: 0, sweepPerPass: 3, reembedPerMinute: 6000 };
// Qdrant keeps a cosine vector normalized, so a unit vector round-trips exactly through float16 when its
// components are +-1/4 (16 of them): what the vector read returns is then what was added.
const stable = (seed: number) => Float32Array.from({ length: DIMS }, (_, i) => ((seed >> i) & 1 ? 0.25 : -0.25));
let embedCalls = 0;
const provider = {
  name: "spy",
  dimensions: DIMS,
  embed: async () => { embedCalls++; return new Float32Array(DIMS).fill(0.5); },
  embedBatch: async (texts: string[]) => { embedCalls += texts.length; return texts.map(() => Float32Array.from({ length: DIMS }, (_, d) => (d === 0 ? 1 : 0.1))); },
} as unknown as EmbeddingProvider;

interface DiskRig { q: Qdrant; engine: SearchEngine; runtime: DiskSearchRuntime; down: { value: boolean }; r: Rig }
const rigs: DiskRig[] = [];

async function diskRig(label: string): Promise<DiskRig> {
  const q = qdrantFor(`retention_${label}_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  await q.ensure();
  const engine = new SearchEngine(q, DEFAULT_AVGDL);
  const down = { value: false };
  const live = engineClient(engine);
  const client = Object.fromEntries(Object.entries(live).map(([name, fn]) => [
    name, (...args: unknown[]) => (down.value ? Promise.reject(new Error("connect ECONNREFUSED qdrant")) : (fn as (...a: unknown[]) => unknown)(...args)),
  ])) as unknown as SearchWorkerClient;
  const runtime = createDiskSearchRuntime(client, true, DIMS, undefined, NO_TIMERS);
  registerSearchBackend("disk", () => runtime);
  createSearchRuntime({ kv: {} as never, embeddingProvider: provider }, "disk");
  setVectorIndex(runtime.vector);
  setEmbeddingProvider(provider);
  const r = rig(() => runtime);
  const hooks: ServiceHooks = { kv: r.kv as never, embedBatch: vectorIndexAddBatchGuarded, embeddingEnabled: () => runtime.vector !== null };
  runtime.service.start(hooks);
  const d = { q, engine, runtime, down, r };
  rigs.push(d);
  return d;
}

async function index(d: DiskRig, row: CompressedObservation | Memory, seed: number): Promise<void> {
  const isMemory = "content" in row;
  const doc = isMemory ? memoryToObservation(row) : row;
  d.runtime.keyword.add(doc, isMemory ? "memory" : "observation");
  d.runtime.vector!.add(row.id, doc.sessionId, stable(seed));
  await d.runtime.outbox.drainFor(10_000);
}

const settle = (d: DiskRig) => d.runtime.outbox.drainFor(10_000);
const keyword = async (d: DiskRig, query: string) => (await d.runtime.keyword.search(query, 10)).map((h) => h.obsId).sort();
const nearest = async (d: DiskRig, seed: number) => (await d.runtime.vector!.search(stable(seed), 10)).map((h) => h.obsId).sort();
/** Live doc ids of one session, or of the memories when no session is given. */
const docIds = async (d: DiskRig, sessionId?: string) => (await d.engine.scanDocs(sessionId, undefined, 1000)).items.map((x) => x.id).sort();

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

describe.skipIf(!QDRANT_URL)("disk mode", () => {
  it("R3: a soft-deleted observation and expired memory leave keyword and vector recall at once, and come back unchanged without an embedding call", async () => {
    const d = await diskRig("r3");
    const { r } = d;
    await openRun(r);
    const o1 = observation("obs_1");
    const o2 = observation("obs_2");
    const m = memory("mem_1");
    await seedSession(r, "ses_1");
    for (const o of [o1, o2]) await r.kv.set(KV.observations("ses_1"), o.id, o);
    await r.kv.set(KV.memories, m.id, m);
    const seal = await seedSeal(r, "ses_1", 2);
    await index(d, o1, 1);
    await index(d, o2, 2);
    await index(d, m, 3);
    expect(await keyword(d, "zebra")).toEqual(["obs_1", "obs_2"]);
    expect(await keyword(d, "okapi")).toEqual(["mem_1"]);
    expect(await nearest(d, 1)).toContain("obs_1");
    expect(await nearest(d, 3)).toContain("mem_1");
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(2);
    embedCalls = 0;

    for (const item of [candidate("O", o1, seal), candidate("X", m)]) expect((await displace(r.deps, r.vault, RUN, item)).moved).toBe(true);
    await settle(d);

    expect(await keyword(d, "zebra")).toEqual(["obs_2"]);
    expect(await keyword(d, "okapi")).toEqual([]);
    expect(await nearest(d, 1)).not.toContain("obs_1");
    expect(await nearest(d, 3)).not.toContain("mem_1");
    expect(await docIds(d, "ses_1")).toEqual(["obs_2"]);
    expect(await docIds(d)).toEqual([]);
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(1);
    const stored = await r.vault.get(RUN, { kind: "observation", sessionId: "ses_1", id: "obs_1" });
    expect(base64ToFloat32(stored!.satellites.vector!)).toEqual(stable(1));

    const result = await restoreRun(r.deps, RUN, "test");
    await settle(d);

    expect(result).toMatchObject({ restored: 2, keptLive: 0, reembedNeeded: 0 });
    expect(await r.kv.get(KV.observations("ses_1"), "obs_1")).toEqual(o1);
    expect(await r.kv.get(KV.memories, "mem_1")).toEqual(m);
    expect(await keyword(d, "zebra")).toEqual(["obs_1", "obs_2"]);
    expect(await keyword(d, "okapi")).toEqual(["mem_1"]);
    expect(await nearest(d, 1)).toContain("obs_1");
    expect(await nearest(d, 3)).toContain("mem_1");
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(2);

    expect(await d.engine.stats()).toMatchObject({ vectors: 3, missingVectors: 0 });
    await d.runtime.reembed.step();
    await settle(d);
    expect(embedCalls).toBe(0);
    expect(d.runtime.reembed.report()).toMatchObject({ embedded: 0, failed: 0 });
  }, 60_000);

  it("refuses to move a row while the stored vector cannot be read, and moves it once it can", async () => {
    const d = await diskRig("unreadable");
    const { r } = d;
    await openRun(r);
    const o = observation("obs_1");
    await seedSession(r, "ses_1");
    await r.kv.set(KV.observations("ses_1"), o.id, o);
    const seal = await seedSeal(r, "ses_1", 1);
    await index(d, o, 1);

    d.down.value = true;
    expect(await displace(r.deps, r.vault, RUN, candidate("O", o, seal))).toMatchObject({ moved: false, skipped: "unreadable" });
    d.down.value = false;
    expect(await r.kv.get(KV.observations("ses_1"), "obs_1")).toEqual(o);
    expect(await r.vault.get(RUN, { kind: "observation", sessionId: "ses_1", id: "obs_1" })).toBeNull();

    d.runtime.health.reportOk();
    expect((await displace(r.deps, r.vault, RUN, candidate("O", o, seal))).moved).toBe(true);
  }, 60_000);

  it("R8: after a move, a reconcile pass and the re-embed loop bring nothing back", async () => {
    const d = await diskRig("r8");
    const { r } = d;
    await openRun(r);
    const rows = [observation("obs_1"), observation("obs_2"), observation("obs_3")];
    const m = memory("mem_1");
    await seedSession(r, "ses_1");
    for (const o of rows) await r.kv.set(KV.observations("ses_1"), o.id, o);
    await r.kv.set(KV.memories, m.id, m);
    const seal = await seedSeal(r, "ses_1", 3);
    for (const [i, o] of rows.entries()) await index(d, o, i + 1);
    await index(d, m, 9);

    for (const item of [candidate("O", rows[0]!, seal), candidate("O", rows[1]!, seal), candidate("X", m)]) await displace(r.deps, r.vault, RUN, item);
    await settle(d);
    embedCalls = 0;

    await d.runtime.reconciler.runPass();
    await d.runtime.reembed.step();
    await d.runtime.reconciler.runPass();
    await settle(d);

    expect(await docIds(d, "ses_1")).toEqual(["obs_3"]);
    expect(await docIds(d)).toEqual([]);
    expect(await keyword(d, "zebra")).toEqual(["obs_3"]);
    expect(d.runtime.reconciler.report()).toMatchObject({ added: 0, error: null });
    expect(d.runtime.reconciler.missing()).toEqual({ observations: 0, memories: 0 });
    expect(embedCalls).toBe(0);
    expect(await r.kv.list(KV.observations("ses_1"))).toHaveLength(1);
    expect(await r.kv.get(KV.memories, "mem_1")).toBeNull();
  }, 60_000);

  it("leaves a doc the reconciler would otherwise have deleted as leaked in neither place after a restore", async () => {
    const d = await diskRig("leaked");
    const { r } = d;
    await openRun(r);
    const o = observation("obs_1");
    await seedSession(r, "ses_1");
    await r.kv.set(KV.observations("ses_1"), o.id, o);
    const seal = await seedSeal(r, "ses_1", 1);
    await index(d, o, 1);
    await displace(r.deps, r.vault, RUN, candidate("O", o, seal));
    await restoreRun(r.deps, RUN, "test");
    await settle(d);
    await d.runtime.reconciler.runPass();
    await settle(d);

    expect(await docIds(d, "ses_1")).toEqual(["obs_1"]);
    expect(d.runtime.reconciler.report()).toMatchObject({ added: 0, deleted: 0 });
    expect(await d.engine.stats()).toMatchObject({ vectors: 1, missingVectors: 0 });
  }, 60_000);
});

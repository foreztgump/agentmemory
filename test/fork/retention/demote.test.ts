// Stage C: a cold memory is marked and leaves both indexes, stays in mem:memories, and comes back from its stored vector.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { MEMORY_LOCK } from "../../../src/fork/retention/demote.js";
import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { displace, recoverRun } from "../../../src/fork/retention/move.js";
import { restoreItems, restoreRun } from "../../../src/fork/retention/restore.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { DemoteRecord, ItemRef } from "../../../src/fork/retention/types.js";
import { indexRecords, rebuildIndex, rebuildKeywordIndex, setEmbeddingProvider, setVectorIndex } from "../../../src/functions/search.js";
import { withKeyedLock } from "../../../src/state/keyed-mutex.js";
import { KV } from "../../../src/state/schema.js";
import { createSearchRuntime, getSearchRuntime } from "../../../src/state/search-ports.js";
import { float32ToBase64 } from "../../../src/state/vector-index.js";
import type { EmbeddingProvider, Memory } from "../../../src/types.js";
import { DIMS, NOW, RUN, candidate, keywordHits, liveRow, memory, openRun, rig, seedMemory, vec, vectorHits, type Rig } from "./move-fixtures.js";

const MEM: ItemRef = { kind: "memory", id: "mem_cold" };
const stamp = (id: string) => ({ demotedAt: NOW.toISOString(), runId: RUN, memoryId: id });
const cold = (id = "mem_cold", over: Partial<Memory> = {}) =>
  memory(id, { forgetAfter: undefined, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", ...over });
const recordOf = (r: Rig, id = "mem_cold") => r.kv.get<DemoteRecord>(RETENTION_KV.demoted, id);

const embed = vi.fn(async () => new Float32Array(DIMS).fill(0.5));
const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.5)));
const provider = { name: "spy", dimensions: DIMS, embed, embedBatch } as unknown as EmbeddingProvider;

beforeEach(() => {
  embed.mockClear();
  embedBatch.mockClear();
});

/** The search state is a module singleton, so a test that reads it back through a rebuild boots a runtime of its own. */
function boot(): Rig {
  const runtime = createSearchRuntime({ kv: {} as never, embeddingProvider: provider }, "memory");
  runtime.keyword.clear();
  setEmbeddingProvider(provider);
  setVectorIndex(runtime.vector);
  return rig(getSearchRuntime);
}

async function demoted(r: Rig = rig()) {
  await openRun(r);
  const row = await seedMemory(r, cold(), { seed: 7 });
  await seedMemory(r, cold("mem_warm"), { seed: 8 });
  const result = await displace(r.deps, r.vault, RUN, await candidate(r, "C", row));
  expect(result).toMatchObject({ moved: true });
  return { r, row };
}

describe("demote", () => {
  it("marks the row, keeps it in mem:memories, and takes it out of both indexes at once", async () => {
    const r = rig();
    await openRun(r);
    const row = await seedMemory(r, cold(), { seed: 7 });
    await seedMemory(r, cold("mem_warm"), { seed: 8 });
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold", "mem_warm"]);
    expect(await vectorHits(r, 7)).toContain("mem_cold");

    expect(await displace(r.deps, r.vault, RUN, await candidate(r, "C", row))).toMatchObject({ moved: true });

    const marked = await liveRow<Memory>(r, KV.memories, "mem_cold");
    expect(marked).toEqual({ ...row, retention: stamp("mem_cold") });
    expect(hiddenFromIndex(marked)).toBe(true);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_warm"]);
    expect(await vectorHits(r, 7)).not.toContain("mem_cold");
    expect(await vectorHits(r, 8)).toContain("mem_warm");
    expect(await liveRow<Memory>(r, KV.memories, "mem_warm")).toEqual(cold("mem_warm"));
  });

  it("keeps the vector in the demote record, and nothing in the vault, the locator or the run's held count", async () => {
    const { r } = await demoted();

    expect(await recordOf(r)).toEqual({
      memoryId: "mem_cold", runId: RUN, demotedAt: NOW.toISOString(), reason: { stage: "C", ageActiveDays: 200, note: "aged" }, vector: float32ToBase64(vec(7)),
    });
    expect(await r.kv.listKeys(RETENTION_KV.vault(RUN))).toEqual([]);
    expect(await r.vault.locate(MEM)).toBeNull();
    expect(await r.vault.runsHolding()).toEqual([]);
    expect((await r.runs.get(RUN))!.held).toBe(0);
  });

  it("holds mem:remember: a held lock keeps the row unmarked and indexed until it is released", async () => {
    const r = rig();
    await openRun(r);
    const row = await seedMemory(r, cold(), { seed: 7 });
    const cleared = await candidate(r, "C", row);
    let release!: () => void;
    const held = withKeyedLock(MEMORY_LOCK, () => new Promise<void>((resolve) => { release = resolve; }));
    const moving = displace(r.deps, r.vault, RUN, cleared);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(await liveRow(r, KV.memories, "mem_cold")).toEqual(row);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold"]);
    release();
    await held;
    expect((await moving).moved).toBe(true);
    expect(hiddenFromIndex(await liveRow<Memory>(r, KV.memories, "mem_cold"))).toBe(true);
  });

  it("skips a row that was rewritten after the plan read it, and a row that is already marked", async () => {
    const r = rig();
    await openRun(r);
    const row = await seedMemory(r, cold(), { seed: 7 });
    const cleared = await candidate(r, "C", row);
    await r.kv.set(KV.memories, "mem_cold", { ...row, content: "rewritten okapi" });
    expect(await displace(r.deps, r.vault, RUN, cleared)).toMatchObject({ moved: false, skipped: "row-changed" });
    expect(await recordOf(r)).toBeNull();

    const marked = { ...row, retention: stamp("mem_cold") };
    await r.kv.set(KV.memories, "mem_cold", marked);
    expect(await displace(r.deps, r.vault, RUN, await candidate(r, "C", marked))).toMatchObject({ moved: false, skipped: "already-demoted" });
    expect(await recordOf(r)).toBeNull();
  });
});

describe("R8: nothing re-adds a demoted memory", () => {
  it("a boot rebuild, the keyword rebuild and an import pass leave it out of the indexes and out of the embedding jobs", async () => {
    const r = boot();
    const { row } = await demoted(r);
    const marked = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!;
    embed.mockClear();
    embedBatch.mockClear();

    expect(await rebuildIndex(r.kv)).toBe(1);
    expect(r.runtime.keyword.has("mem_cold")).toBe(false);
    expect(r.runtime.keyword.has("mem_warm")).toBe(true);

    const keyword = await rebuildKeywordIndex(r.kv);
    expect(keyword.documents).toBe(1);
    expect(r.runtime.keyword.has("mem_cold")).toBe(false);
    expect(r.runtime.keyword.has("mem_warm")).toBe(true);

    expect(await indexRecords([], [marked])).toBe(0);
    expect(r.runtime.keyword.has("mem_cold")).toBe(false);
    const embedded = [...embedBatch.mock.calls.flatMap(([texts]) => texts), ...embed.mock.calls.map(([text]) => String(text))];
    expect(embedded.filter((text) => text.includes("mem_cold"))).toEqual([]);
    expect(embedded.some((text) => text.includes("mem_warm"))).toBe(true);
    expect(await liveRow(r, KV.memories, "mem_cold")).toEqual({ ...row, retention: stamp("mem_cold") });
  });
});

describe("un-demote", () => {
  it("puts the row back in both indexes from the stored vector, with no embedding call and no mark", async () => {
    const r = boot();
    const { row } = await demoted(r);
    embed.mockClear();
    embedBatch.mockClear();

    const result = await restoreItems(r.deps, [MEM], "test");

    expect(result).toMatchObject({ restored: 1, keptLive: 0, reembedNeeded: 0 });
    const live = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!;
    expect(live).toEqual(row);
    expect("retention" in live).toBe(false);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold", "mem_warm"]);
    expect(r.runtime.vector.readVectors(["mem_cold"]).get("mem_cold")).toEqual(vec(7));
    expect(await vectorHits(r, 7)).toContain("mem_cold");
    expect(await recordOf(r)).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect((await r.runs.get(RUN))!.held).toBe(0);
  });

  it("restores a whole run's demotes, and leaves the run's held count alone", async () => {
    const r = rig();
    await openRun(r, RUN, 1);
    for (const [id, seed] of [["mem_a", 1], ["mem_b", 2]] as const) {
      const row = await seedMemory(r, cold(id), { seed });
      await displace(r.deps, r.vault, RUN, await candidate(r, "C", row));
    }
    expect(await keywordHits(r, "okapi")).toEqual([]);

    expect(await restoreRun(r.deps, RUN, "recall lost")).toMatchObject({ restored: 2, reembedNeeded: 0 });

    expect(await keywordHits(r, "okapi")).toEqual(["mem_a", "mem_b"]);
    expect(await vectorHits(r, 1)).toContain("mem_a");
    expect(await r.kv.listKeys(RETENTION_KV.demoted)).toEqual([]);
    expect((await r.runs.get(RUN))!.held).toBe(1);
  });

  it("a demote alone does not lower the held count of a run that also holds vault entries", async () => {
    const r = rig();
    await openRun(r, RUN, 1);
    await displace(r.deps, r.vault, RUN, await candidate(r, "C", await seedMemory(r, cold(), { seed: 7 })));
    await restoreItems(r.deps, [MEM], "test");
    expect((await r.runs.get(RUN))!.held).toBe(1);
  });

  it("does nothing for a memory that is not demoted", async () => {
    const r = rig();
    await seedMemory(r, cold(), { seed: 7 });
    expect(await restoreItems(r.deps, [MEM], "test")).toEqual({ restored: 0, keptLive: 0, reembedNeeded: 0, deferred: 0 });
  });

  it("drops a record whose row is live and unmarked, and indexes the row", async () => {
    const r = rig();
    await openRun(r);
    const row = await seedMemory(r, cold(), { seed: 7 });
    await r.kv.set<DemoteRecord>(RETENTION_KV.demoted, "mem_cold", { memoryId: "mem_cold", runId: RUN, demotedAt: NOW.toISOString(), reason: { stage: "C", ageActiveDays: 1, note: "x" }, vector: float32ToBase64(vec(7)) });
    r.runtime.keyword.remove("mem_cold");
    r.runtime.vector.remove("mem_cold");

    expect(await restoreItems(r.deps, [MEM], "test")).toMatchObject({ restored: 0, keptLive: 1 });

    expect(await recordOf(r)).toBeNull();
    expect(await liveRow(r, KV.memories, "mem_cold")).toEqual(row);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold"]);
    expect(await vectorHits(r, 7)).toContain("mem_cold");
  });

  it("restores a marked row that has no record (an export imported from another stack), and asks for a re-embed", async () => {
    const r = rig();
    const row = cold();
    await r.kv.set(KV.memories, "mem_cold", { ...row, retention: { demotedAt: "2026-05-01T00:00:00.000Z", runId: "ret_other", memoryId: "mem_cold" } });

    expect(await restoreItems(r.deps, [MEM], "test")).toMatchObject({ restored: 1, reembedNeeded: 1 });

    expect(await liveRow(r, KV.memories, "mem_cold")).toEqual(row);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold"]);
    expect(await vectorHits(r, 7)).not.toContain("mem_cold");
    expect(await r.kv.listKeys(RETENTION_KV.demoted)).toEqual([]);
  });

  it("holds mem:remember", async () => {
    const { r } = await demoted();
    let release!: () => void;
    const held = withKeyedLock(MEMORY_LOCK, () => new Promise<void>((resolve) => { release = resolve; }));
    const restoring = restoreItems(r.deps, [MEM], "test");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(hiddenFromIndex(await liveRow<Memory>(r, KV.memories, "mem_cold"))).toBe(true);
    release();
    await held;
    expect(await restoring).toMatchObject({ restored: 1 });
    expect(hiddenFromIndex(await liveRow<Memory>(r, KV.memories, "mem_cold"))).toBe(false);
  });

  it("a demoted memory that was then soft deleted comes back live, indexed and unmarked from one restore", async () => {
    const { r } = await demoted();
    const marked = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!;
    await r.kv.set(KV.memories, "mem_cold", { ...marked, forgetAfter: "2026-02-01T00:00:00.000Z" });
    const expired = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!;
    await displace(r.deps, r.vault, RUN, await candidate(r, "X", expired));
    expect(await liveRow(r, KV.memories, "mem_cold")).toBeNull();

    expect(await restoreItems(r.deps, [MEM], "test")).toMatchObject({ restored: 2, reembedNeeded: 0 });

    const live = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!;
    expect(hiddenFromIndex(live)).toBe(false);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold", "mem_warm"]);
    expect(r.runtime.vector.readVectors(["mem_cold"]).get("mem_cold")).toEqual(vec(7));
    expect(await recordOf(r)).toBeNull();
  });
});

describe("recoverRun settles stage C", () => {
  it("leaves a finished demote alone, and runs a second recovery over it with nothing to change", async () => {
    const { r } = await demoted();
    const before = JSON.stringify([...r.h.store].map(([scope, rows]) => [scope, [...rows]]));
    expect(await recoverRun(r.deps, r.vault, RUN)).toMatchObject({ finished: 0 });
    expect(await recoverRun(r.deps, r.vault, RUN)).toMatchObject({ finished: 0 });
    expect(JSON.stringify([...r.h.store].map(([scope, rows]) => [scope, [...rows]]))).toBe(before);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_warm"]);
  });

  it("takes a memory that is still in the indexes out of them when its mark landed", async () => {
    const { r } = await demoted();
    r.runtime.keyword.add({ id: "mem_cold", sessionId: "ses_1", timestamp: NOW.toISOString(), type: "file_read", title: "memory mem_cold", facts: [], narrative: "content of mem_cold okapi", concepts: [], files: [], importance: 5 }, "memory");
    r.runtime.vector.add("mem_cold", "ses_1", vec(7));

    expect(await recoverRun(r.deps, r.vault, RUN)).toMatchObject({ detachedAgain: 1 });

    expect(await keywordHits(r, "okapi")).toEqual(["mem_warm"]);
    expect(await vectorHits(r, 7)).not.toContain("mem_cold");
  });
});

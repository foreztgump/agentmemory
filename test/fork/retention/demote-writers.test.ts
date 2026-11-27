// G3 and D6: a demoted memory stays in mem:memories, so export, supersede lookups and the viewer still see it, and the
// writers that copy or rewrite a memory neither lose the mark nor pass it on to a new version (open risk 4).
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { displace } from "../../../src/fork/retention/move.js";
import { registerConsolidateFunction } from "../../../src/functions/consolidate.js";
import { registerExportImportFunction } from "../../../src/functions/export-import.js";
import { registerRelationsFunction } from "../../../src/functions/relations.js";
import { registerRememberFunction } from "../../../src/functions/remember.js";
import { rebuildKeywordIndex, setEmbeddingProvider, setVectorIndex } from "../../../src/functions/search.js";
import { KV } from "../../../src/state/schema.js";
import { createSearchRuntime, getSearchRuntime } from "../../../src/state/search-ports.js";
import { VERSION } from "../../../src/version.js";
import type { CompressedObservation, EmbeddingProvider, ExportData, Memory, MemoryProvider, Session } from "../../../src/types.js";
import { DIMS, NOW, RUN, candidate, keywordHits, liveRow, memory, openRun, rig, seedMemory, type Rig } from "./move-fixtures.js";

const stamp = { demotedAt: NOW.toISOString(), runId: RUN, memoryId: "mem_cold" };
const cold = (over: Partial<Memory> = {}) =>
  memory("mem_cold", { forgetAfter: undefined, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", project: "app", ...over });

const provider = {
  name: "stub", dimensions: DIMS, embed: async () => new Float32Array(DIMS).fill(0.5), embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.5)),
} as unknown as EmbeddingProvider;

function boot(): Rig {
  const runtime = createSearchRuntime({ kv: {} as never, embeddingProvider: provider }, "memory");
  runtime.keyword.clear();
  setEmbeddingProvider(provider);
  setVectorIndex(runtime.vector);
  return rig(getSearchRuntime);
}

async function demotedRig(): Promise<{ r: Rig; marked: Memory }> {
  const r = boot();
  await openRun(r);
  const row = await seedMemory(r, cold(), { seed: 7 });
  await displace(r.deps, r.vault, RUN, await candidate(r, "C", row));
  const marked = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!;
  expect(hiddenFromIndex(marked)).toBe(true);
  return { r, marked };
}

describe("what still sees a demoted memory", () => {
  it("the memory list the viewer reads, and an export, contain it with its mark", async () => {
    const { r, marked } = await demotedRig();
    registerExportImportFunction(r.h.sdk as never, r.kv);

    expect((await r.kv.list<Memory>(KV.memories)).map((m) => m.id)).toEqual(["mem_cold"]);
    const exported = (await r.h.call("mem::export", {})) as ExportData;

    expect(exported.memories).toEqual([marked]);
    expect(exported.memories[0]?.retention).toEqual(stamp);
  });

  it("an export imported into another stack keeps the mark and the memory out of that stack's indexes", async () => {
    const { r } = await demotedRig();
    registerExportImportFunction(r.h.sdk as never, r.kv);
    const exported = (await r.h.call("mem::export", {})) as ExportData;
    const other = boot();
    registerExportImportFunction(other.h.sdk as never, other.kv);

    const result = (await other.h.call("mem::import", { exportData: { ...exported, version: VERSION }, strategy: "replace" })) as { success: boolean; memories: number };

    expect(result).toMatchObject({ success: true, memories: 1 });
    const imported = (await liveRow<Memory>(other, KV.memories, "mem_cold"))!;
    expect(imported.retention).toEqual(stamp);
    expect(other.runtime.keyword.has("mem_cold")).toBe(false);
    expect(await keywordHits(other, "okapi")).toEqual([]);
  });

  it("a save of the same content with nothing indexed scans the memories, finds the demoted one and supersedes it: the old version keeps its mark and stays out of the indexes", async () => {
    const { r } = await demotedRig();
    registerRememberFunction(r.h.sdk as never, r.kv);

    const saved = (await r.h.call("mem::remember", { content: "content of mem_cold okapi again", type: "fact", project: "app" })) as { memory: Memory };

    expect(saved.memory).toMatchObject({ supersedes: ["mem_cold"], parentId: "mem_cold", version: 2 });
    const old = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!;
    expect(old).toMatchObject({ isLatest: false, retention: stamp });
    expect(old.updatedAt).not.toBe(cold().updatedAt);
    expect(hiddenFromIndex(saved.memory)).toBe(false);
    expect(await keywordHits(r, "okapi")).toEqual([saved.memory.id]);
  });

  it("consolidation that supersedes a demoted head keeps the mark on it and indexes nothing for it", async () => {
    const { r } = await demotedRig();
    const session: Session = { id: "ses_c", project: "app", cwd: "/w", startedAt: "2026-01-01T00:00:00.000Z", status: "completed", observationCount: 3 };
    await r.kv.set(KV.sessions, "ses_c", session);
    for (let i = 0; i < 3; i++) {
      const obs: CompressedObservation = {
        id: `obs_c${i}`, sessionId: "ses_c", timestamp: session.startedAt, type: "decision", title: `auth ${i}`, narrative: `Evidence ${i}`, facts: [], concepts: ["auth"], files: [], importance: 8,
      };
      await r.kv.set(KV.observations("ses_c"), obs.id, obs);
    }
    const title = (await liveRow<Memory>(r, KV.memories, "mem_cold"))!.title;
    const compress = vi.fn(async () => `<memory><type>fact</type><title>${title}</title><content>fresh content</content><concepts><concept>auth</concept></concepts><files></files><strength>8</strength></memory>`);
    registerConsolidateFunction(r.h.sdk as never, r.kv, { compress } as unknown as MemoryProvider);

    expect(await r.h.call("mem::consolidate", { project: "app", minObservations: 1 })).toMatchObject({ consolidated: 1 });

    const rows = await r.kv.list<Memory>(KV.memories);
    expect(rows).toHaveLength(2);
    expect(rows.find((m) => m.id === "mem_cold")).toMatchObject({ isLatest: false, retention: stamp });
    const fresh = rows.find((m) => m.id !== "mem_cold")!;
    expect(fresh).toMatchObject({ isLatest: true, parentId: "mem_cold", supersedes: ["mem_cold"] });
    expect(hiddenFromIndex(fresh)).toBe(false);
  });

  it("evolving a demoted memory gives a live new version: the copy carries the old mark, which names another memory", async () => {
    const { r } = await demotedRig();
    registerRelationsFunction(r.h.sdk as never, r.kv);

    const evolved = (await r.h.call("mem::evolve", { memoryId: "mem_cold", newContent: "content rewritten about okapi" })) as { success: boolean; memory: Memory };

    expect(evolved.success).toBe(true);
    expect(evolved.memory.retention).toEqual(stamp);
    expect(hiddenFromIndex(evolved.memory)).toBe(false);
    expect(await liveRow(r, KV.memories, "mem_cold")).toMatchObject({ isLatest: false, retention: stamp });
    expect(await keywordHits(r, "okapi")).toEqual([evolved.memory.id]);

    await rebuildKeywordIndex(r.kv);
    expect(await keywordHits(r, "okapi")).toEqual([evolved.memory.id]);
  });

  it("with other memories indexed, a duplicate save finds its candidates through the index, so it is saved beside the demoted one", async () => {
    const { r, marked } = await demotedRig();
    await seedMemory(r, memory("mem_warm", { forgetAfter: undefined, project: "app" }), { seed: 8 });
    await rebuildKeywordIndex(r.kv);
    registerRememberFunction(r.h.sdk as never, r.kv);

    const saved = (await r.h.call("mem::remember", { content: "content of mem_cold okapi again", type: "fact", project: "app" })) as { memory: Memory };

    expect(saved.memory).toMatchObject({ supersedes: [], version: 1 });
    expect(await liveRow(r, KV.memories, "mem_cold")).toEqual(marked);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_warm", saved.memory.id].sort());
  });
});

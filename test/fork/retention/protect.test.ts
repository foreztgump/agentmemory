import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { createProtector, type Candidate } from "../../../src/fork/retention/protect.js";
import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { RETENTION_IMPORTANCE_FLOOR, RETENTION_SPILL_IDS } from "../../../src/fork/retention/settings.js";
import { KV } from "../../../src/state/schema.js";
import type { Memory } from "../../../src/types.js";
import { memory, NOW, observation, openRun, RUN, rig, seedMemory, seedSession } from "./move-fixtures.js";
import { candidatesOf, clockOf, judgeAll, pin, planAll, sealedSession, ZERO } from "./plan-fixtures.js";
import { displace } from "../../../src/fork/retention/move.js";

const access = (r: ReturnType<typeof rig>, id: string, lastAt: string) =>
  r.kv.set(KV.accessLog, id, { memoryId: id, count: 1, lastAt, recent: [] });

const planned = async (r: ReturnType<typeof rig>, windows = ZERO): Promise<Candidate[]> => candidatesOf(await planAll(r, windows));

describe("RETENTION_IMPORTANCE_FLOOR", () => {
  it("protects a row at the floor and not below it", async () => {
    const r = rig();
    await sealedSession(r, "ses_a", 0, { rows: [observation("at", "ses_a", { importance: RETENTION_IMPORTANCE_FLOOR }), observation("below", "ses_a", { importance: RETENTION_IMPORTANCE_FLOOR - 1 })] });
    const { protectedBy } = await judgeAll(r, ZERO, await planned(r));
    expect(protectedBy).toEqual({ "obs:5:ses_a:at": "importance" });
  });
});

describe("the retrieved signal reads project-active days", () => {
  async function project() {
    const r = rig();
    for (const [id, startedAt] of [["s1", "2026-03-01T08:00:00.000Z"], ["s2", "2026-03-02T08:00:00.000Z"], ["s3", "2026-03-03T08:00:00.000Z"]] as const) {
      await seedSession(r, id, { startedAt });
    }
    await seedMemory(r, memory("m_x", { project: "proj" }));
    return r;
  }
  const verdictFor = async (r: ReturnType<typeof rig>, coldDays: number) => {
    const windows = { ...ZERO, coldDays };
    const { protectedBy } = await judgeAll(r, windows, await planned(r, windows));
    return protectedBy["memory:m_x"] ?? "clear";
  };

  it("protects an access inside the last N active days even when the wall clock is months past it", async () => {
    const r = await project();
    await access(r, "m_x", "2026-03-02T12:00:00.000Z");
    expect(await verdictFor(r, 2)).toBe("retrieved");
  });

  it("does not protect an access before the Nth most recent active day", async () => {
    const r = await project();
    await access(r, "m_x", "2026-03-01T23:00:00.000Z");
    expect(await verdictFor(r, 2)).toBe("clear");
  });

  it("protects any access of a project with fewer active days than the window, and never an absent one", async () => {
    const r = await project();
    expect(await verdictFor(r, 10)).toBe("clear");
    await access(r, "m_x", "2025-01-01T00:00:00.000Z");
    expect(await verdictFor(r, 10)).toBe("retrieved");
  });

  it("counts a wall-clock 90 day old access as inside a 3 active day window of an idle project", async () => {
    const r = await project();
    await access(r, "m_x", "2026-06-01T00:00:00.000Z");
    expect(await verdictFor(r, 3)).toBe("retrieved");
    expect(NOW.getTime() - Date.parse("2026-06-01T00:00:00.000Z")).toBeGreaterThan(3 * 86_400_000);
  });

  it("protects an observation by its access too", async () => {
    const r = rig();
    await sealedSession(r, "ses_a", 1);
    await access(r, "ses_a_o0", "2026-03-30T00:00:00.000Z");
    const { protectedBy } = await judgeAll(r, { ...ZERO, coldDays: 1 }, await planned(r, { ...ZERO, coldDays: 1 }));
    expect(protectedBy).toEqual({ "obs:5:ses_a:ses_a_o0": "retrieved" });
  });
});

describe("cited-by-memory", () => {
  it("protects both rows that share a bare id", async () => {
    const r = rig();
    await sealedSession(r, "ses_a", 0, { rows: [observation("shared", "ses_a"), observation("own_a", "ses_a")] });
    await sealedSession(r, "ses_b", 0, { rows: [observation("shared", "ses_b")] });
    await seedMemory(r, memory("m_cites", { forgetAfter: undefined, sourceObservationIds: ["shared"] }));
    const { protectedBy, cleared } = await judgeAll(r, ZERO, await planned(r));
    expect(protectedBy).toEqual({ "obs:5:ses_a:shared": "cited-by-memory", "obs:5:ses_b:shared": "cited-by-memory" });
    expect(cleared.map((c) => c.ref.id)).toEqual(["own_a"]);
  });

  it("counts a superseded memory only inside its window", async () => {
    const r = rig();
    await seedSession(r, "s_a", { startedAt: "2026-03-20T08:00:00.000Z" });
    await seedSession(r, "s_b", { startedAt: "2026-04-01T08:00:00.000Z" });
    await sealedSession(r, "ses_a", 0, { rows: [observation("o_1", "ses_a")] });
    await seedMemory(r, memory("m_old", { forgetAfter: undefined, isLatest: false, updatedAt: "2026-03-25T00:00:00.000Z", sourceObservationIds: ["o_1"], project: "proj" }));
    const verdict = async (supersededDays: number) => {
      const windows = { ...ZERO, supersededDays };
      return (await judgeAll(r, windows, (await planned(r, windows)).filter((c) => c.ref.kind === "observation"))).protectedBy;
    };
    expect(await verdict(2)).toEqual({ "obs:5:ses_a:o_1": "cited-by-memory" });
    expect(await verdict(1)).toEqual({});
    expect(await verdict(0)).toEqual({});
  });

  it("spills the cited set to the sweep scratch scope above the threshold, protects the same rows and empties it on release", async () => {
    const r = rig();
    await sealedSession(r, "ses_a", 0, { rows: ["a", "b", "c", "d", "e", "f"].map((id) => observation(id, "ses_a")) });
    await seedMemory(r, memory("m_1", { forgetAfter: undefined, sourceObservationIds: ["a", "b", "c"] }));
    await seedMemory(r, memory("m_2", { forgetAfter: undefined, sourceObservationIds: ["d", "e"] }));
    await r.kv.set(RETENTION_KV.sweepScratch, "stale", 1);
    const protector = await createProtector(r.kv, ZERO, await clockOf(r), { spillIds: 2 });
    expect((await r.kv.listKeys(RETENTION_KV.sweepScratch)).sort()).toEqual(["a", "b", "c", "d", "e"]);
    const { protectedBy, cleared } = await judgeAll(r, ZERO, await planned(r), protector);
    expect(Object.keys(protectedBy)).toHaveLength(5);
    expect(cleared.map((c) => c.ref.id)).toEqual(["f"]);
    await protector.release();
    expect(await r.kv.listKeys(RETENTION_KV.sweepScratch)).toEqual([]);
  });

  it("leaves the scratch scope alone while the set fits in memory", async () => {
    const r = rig();
    await seedMemory(r, memory("m_1", { forgetAfter: undefined, sourceObservationIds: ["a"] }));
    await r.kv.set(RETENTION_KV.sweepScratch, "other", 1);
    const protector = await createProtector(r.kv, ZERO, await clockOf(r));
    await protector.release();
    expect(await r.kv.listKeys(RETENTION_KV.sweepScratch)).toEqual(["other"]);
    expect(RETENTION_SPILL_IDS).toBe(500_000);
  });
});

describe("memory signals", () => {
  it("protects a memory an insight cites, and not one it does not", async () => {
    const r = rig();
    await seedMemory(r, memory("m_cited"));
    await seedMemory(r, memory("m_free"));
    await r.kv.set(KV.insights, "ins_1", { id: "ins_1", title: "t", content: "c", confidence: 1, reinforcements: 1, sourceConceptCluster: [], sourceMemoryIds: ["m_cited"], sourceLessonIds: [], sourceCrystalIds: [], tags: [], createdAt: "", updatedAt: "", decayRate: 0 });
    await r.kv.set(KV.insights, "ins_2", { id: "ins_2", title: "t", content: "c", confidence: 1, reinforcements: 1, sourceConceptCluster: [], sourceMemoryIds: ["m_free"], sourceLessonIds: [], sourceCrystalIds: [], tags: [], createdAt: "", updatedAt: "", decayRate: 0, deleted: true });
    const { protectedBy } = await judgeAll(r, ZERO, await planned(r));
    expect(protectedBy).toEqual({ "memory:m_cited": "cited-by-insight" });
  });

  it("protects a pinned memory, and the pin outranks every other signal", async () => {
    const r = rig();
    await seedMemory(r, memory("m_pinned", { type: "architecture" }));
    await pin(r, { kind: "memory", id: "m_pinned" });
    expect((await judgeAll(r, ZERO, await planned(r))).protectedBy).toEqual({ "memory:m_pinned": "pin" });
  });

  it("does not let a deliberate save outlive its own expiry (stage X)", async () => {
    const r = rig();
    await seedMemory(r, memory("m_ttl", { origin: { channel: "agent", capturedAt: "2026-01-01T00:00:00.000Z" } }));
    const { cleared } = await judgeAll(r, ZERO, await planned(r));
    expect(cleared.map((c) => [c.stage, c.ref.id])).toEqual([["X", "m_ttl"]]);
  });

  it("counts live lessons for the report and leaves deleted ones out", async () => {
    const r = rig();
    const lesson = (id: string, deleted?: true) => ({ id, content: "c", context: "", confidence: 1, reinforcements: 1, source: "manual", sourceIds: [], tags: [], createdAt: "", updatedAt: "", decayRate: 0, ...(deleted ? { deleted } : {}) });
    await r.kv.set(KV.lessons, "l1", lesson("l1"));
    await r.kv.set(KV.lessons, "l2", lesson("l2", true));
    expect((await createProtector(r.kv, ZERO, await clockOf(r))).hits().lesson).toBe(1);
  });
});

describe("recheck", () => {
  it("sees a pin and a citation that arrived during grace, and clears an entry nothing protects", async () => {
    const r = rig();
    await openRun(r);
    const rows = await sealedSession(r, "ses_a", 3);
    const { cleared } = await judgeAll(r, ZERO, await planned(r));
    for (const item of cleared) await displace(r.deps, r.vault, RUN, item);
    const entries = await Promise.all(rows.map((row) => r.vault.get(RUN, { kind: "observation", sessionId: "ses_a", id: row.id })));
    expect(entries.every(Boolean)).toBe(true);

    await pin(r, { kind: "observation", sessionId: "ses_a", id: rows[0]!.id });
    await seedMemory(r, memory("m_late", { forgetAfter: undefined, sourceObservationIds: [rows[1]!.id] }));
    const protector = await createProtector(r.kv, ZERO, await clockOf(r));
    expect(await Promise.all(entries.map((entry) => protector.recheck(entry!)))).toEqual([
      { kind: "protected", signal: "pin" }, { kind: "protected", signal: "cited-by-memory" }, { kind: "clear" },
    ]);
    expect(protector.hits()).toMatchObject({ pin: 1, "cited-by-memory": 1 });
  });

  it("rechecks a memory entry on its access", async () => {
    const r = rig();
    await openRun(r);
    const m: Memory = memory("m_x");
    await seedMemory(r, m);
    const { cleared } = await judgeAll(r, ZERO, await planned(r));
    await displace(r.deps, r.vault, RUN, cleared[0]!);
    const entry = (await r.vault.get(RUN, { kind: "memory", id: "m_x" }))!;
    await access(r, "m_x", "2026-08-30T00:00:00.000Z");
    const windows = { ...ZERO, coldDays: 1 };
    expect(await (await createProtector(r.kv, windows, await clockOf(r))).recheck(entry)).toEqual({ kind: "protected", signal: "retrieved" });
    expect(itemKey(entry.ref)).toBe("memory:m_x");
  });
});

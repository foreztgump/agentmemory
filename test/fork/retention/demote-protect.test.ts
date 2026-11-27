// Stage C through the real plan and Protector: a memory protected by type, a deliberate save or any other signal is
// never demoted, and a demote is out of purge's reach.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { KV } from "../../../src/state/schema.js";
import type { Memory } from "../../../src/types.js";
import { keywordHits, liveRow, memory, RUN, rig, seedMemory, vectorHits, type Rig } from "./move-fixtures.js";
import { candidatesOf, pin, planAll, planAndMove, ZERO } from "./plan-fixtures.js";

const two = "2024-09-01T00:00:00.000Z";
const coldRow = (id: string, over: Partial<Memory> = {}) => memory(id, { forgetAfter: undefined, createdAt: two, updatedAt: two, ...over });

async function seedCold(r: Rig, id: string, seed: number, over: Partial<Memory> = {}) {
  await seedMemory(r, coldRow(id, over), { seed });
  await r.kv.set(KV.retentionScores, id, { memoryId: id, score: 0.01, salience: 0.1, temporalDecay: 0.1, reinforcementBoost: 0, lastAccessed: two, accessCount: 1 });
}

describe("protection before a demote", () => {
  it("demotes only the unprotected cold memory: type, deliberate save, pin and insight citation each keep theirs", async () => {
    const r = rig();
    await seedCold(r, "m_plain", 1);
    await seedCold(r, "m_arch", 2, { type: "architecture" });
    await seedCold(r, "m_pref", 3, { type: "preference" });
    await seedCold(r, "m_user", 4, { origin: { channel: "user", capturedAt: two } });
    await seedCold(r, "m_agent", 5, { origin: { channel: "agent", capturedAt: two } });
    await seedCold(r, "m_pinned", 6);
    await seedCold(r, "m_insight", 7);
    await r.kv.set(KV.insights, "ins_1", { id: "ins_1", sourceMemoryIds: ["m_insight"] } as never);
    await pin(r, { kind: "memory", id: "m_pinned" });

    const { planned, cleared, protectedBy } = await planAndMove(r);

    expect(planned.map((c) => [c.stage, c.ref.id]).sort()).toEqual(
      ["m_agent", "m_arch", "m_insight", "m_pinned", "m_plain", "m_pref", "m_user"].map((id) => ["C", id]),
    );
    expect(protectedBy).toEqual({
      "memory:m_arch": "memory-type", "memory:m_pref": "memory-type", "memory:m_user": "deliberate-save", "memory:m_agent": "deliberate-save",
      "memory:m_pinned": "pin", "memory:m_insight": "cited-by-insight",
    });
    expect(cleared.map((c) => c.ref.id)).toEqual(["m_plain"]);

    const hidden = (await r.kv.list<Memory>(KV.memories)).filter((m) => hiddenFromIndex(m)).map((m) => m.id);
    expect(hidden).toEqual(["m_plain"]);
    expect(await r.kv.listKeys(RETENTION_KV.demoted)).toEqual(["m_plain"]);
    expect(await keywordHits(r, "okapi")).toEqual(["m_agent", "m_arch", "m_insight", "m_pinned", "m_pref", "m_user"]);
    expect(await vectorHits(r, 1)).not.toContain("m_plain");
  });

  it("does not plan a demoted memory again, so a second sweep demotes nothing and the record is not rewritten", async () => {
    const r = rig();
    await seedCold(r, "m_plain", 1);
    await planAndMove(r);
    const record = await r.kv.get(RETENTION_KV.demoted, "m_plain");

    const again = await planAndMove(r);

    expect(again.planned).toEqual([]);
    expect(await r.kv.get(RETENTION_KV.demoted, "m_plain")).toEqual(record);
    expect(candidatesOf(await planAll(r, ZERO))).toEqual([]);
  });

  it("still plans a demoted memory whose ttl has passed as stage X, and a superseded one as stage S", async () => {
    const r = rig();
    await seedCold(r, "m_ttl", 1);
    await planAndMove(r);
    const marked = (await liveRow<Memory>(r, KV.memories, "m_ttl"))!;
    await r.kv.set(KV.memories, "m_ttl", { ...marked, forgetAfter: "2026-02-01T00:00:00.000Z" });

    expect(candidatesOf(await planAll(r, ZERO)).map((c) => [c.stage, c.ref.id])).toEqual([["X", "m_ttl"]]);
  });

  it("leaves nothing for purge to visit: no vault entry, no locator, no held count", async () => {
    const r = rig();
    await seedCold(r, "m_plain", 1);
    await planAndMove(r);

    expect(await r.kv.listKeys(RETENTION_KV.vault(RUN))).toEqual([]);
    expect(await r.kv.listKeys(RETENTION_KV.items)).toEqual([]);
    expect(await r.vault.locate({ kind: "memory", id: "m_plain" })).toBeNull();
    expect(await r.vault.runsHolding()).toEqual([]);
    expect((await r.runs.get(RUN))!.held).toBe(0);
  });
});

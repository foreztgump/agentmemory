// Slice 10, D3: a pin is a protection signal the Protector already reads. This writes it, audits it, and un-demotes a demoted memory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { displace } from "../../../src/fork/retention/move.js";
import { pinItem, unpinItem } from "../../../src/fork/retention/pin.js";
import { itemKey, RETENTION_KV, type Pin } from "../../../src/fork/retention/scopes.js";
import type { ItemRef } from "../../../src/fork/retention/types.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import { KV } from "../../../src/state/schema.js";
import type { Memory } from "../../../src/types.js";
import { createSearchRuntime } from "../../../src/state/search-ports.js";
import type { EmbeddingProvider } from "../../../src/types.js";
import { candidate, DIMS, keywordHits, memory, NOW, observation, openRun, rig, RUN, seedMemory, seedObservation, seedSeal, vectorHits } from "./move-fixtures.js";
import { at, clocked, closedRun, done, purge } from "./purge-fixtures.js";
import { liveIds, sealedSession } from "./plan-fixtures.js";
import { auditEntries, done as swept, indexHarness, sweep } from "./sweep-fixtures.js";
import { anchor } from "./api-fixtures.js";

const embed = vi.fn(async () => new Float32Array(DIMS).fill(0.5));
const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.5)));
const provider = { name: "spy", dimensions: DIMS, embed, embedBatch } as unknown as EmbeddingProvider;

const obs = (sessionId: string, id: string): ItemRef => ({ kind: "observation", sessionId, id });
const mem = (id: string): ItemRef => ({ kind: "memory", id });

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => {
  resetSummarizeVeto();
  vi.restoreAllMocks();
});

describe("pinItem", () => {
  it("writes the pin the Protector reads, with who, reason and time, and audits it", async () => {
    const r = rig();
    await seedObservation(r, observation("o1", "ses_a"));
    const result = await pinItem(r.deps, { ref: obs("ses_a", "o1"), who: "dana", reason: "runbook" });
    const expected: Pin = { ref: obs("ses_a", "o1"), who: "dana", reason: "runbook", pinnedAt: NOW.toISOString() };
    expect(result).toEqual({ kind: "pinned", pin: expected, vaulted: false, undemoted: false });
    expect(await r.kv.get(RETENTION_KV.pins, itemKey(obs("ses_a", "o1")))).toEqual(expected);
    const entries = auditEntries(r).filter((entry) => entry.operation === "retention_pin");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ functionId: "mem::retention-pin", targetIds: ["o1"], details: { pinned: true, who: "dana", reason: "runbook", session: "ses_a" } });
  });

  it("pins a live memory", async () => {
    const r = rig();
    await seedMemory(r, memory("m1"));
    expect(await pinItem(r.deps, { ref: mem("m1"), who: "a", reason: "b" })).toMatchObject({ kind: "pinned", vaulted: false });
    expect(await r.kv.get(RETENTION_KV.pins, itemKey(mem("m1")))).toMatchObject({ who: "a", reason: "b" });
  });

  it("answers not-found for an item that is neither live nor held, and writes no pin and no audit", async () => {
    const r = rig();
    await seedObservation(r, observation("o1", "ses_a"));
    for (const ref of [obs("ses_a", "nope"), obs("ses_other", "o1"), mem("nope")]) {
      expect(await pinItem(r.deps, { ref, who: "a", reason: "b" })).toEqual({ kind: "not-found" });
    }
    expect(await r.kv.listKeys(RETENTION_KV.pins)).toEqual([]);
    expect(auditEntries(r)).toEqual([]);
  });

  it("keys an observation pin by its session, so the same id in another session is not pinned", async () => {
    const r = rig();
    await seedObservation(r, observation("same", "ses_a"));
    await seedObservation(r, observation("same", "ses_b"));
    await pinItem(r.deps, { ref: obs("ses_a", "same"), who: "a", reason: "b" });
    expect(await r.kv.listKeys(RETENTION_KV.pins)).toEqual([itemKey(obs("ses_a", "same"))]);
  });

  it("re-pinning replaces the reason and keeps one pin", async () => {
    const r = rig();
    await seedMemory(r, memory("m1"));
    await pinItem(r.deps, { ref: mem("m1"), who: "a", reason: "first" });
    await pinItem(r.deps, { ref: mem("m1"), who: "b", reason: "second" });
    expect(await r.kv.listKeys(RETENTION_KV.pins)).toHaveLength(1);
    expect(await r.kv.get(RETENTION_KV.pins, itemKey(mem("m1")))).toMatchObject({ who: "b", reason: "second" });
  });

  it("unpins, and says whether there was a pin", async () => {
    const r = rig();
    await seedMemory(r, memory("m1"));
    await pinItem(r.deps, { ref: mem("m1"), who: "a", reason: "b" });
    expect(await unpinItem(r.deps, mem("m1"), "dana")).toEqual({ kind: "unpinned", existed: true });
    expect(await r.kv.listKeys(RETENTION_KV.pins)).toEqual([]);
    expect(await unpinItem(r.deps, mem("m1"), "dana")).toEqual({ kind: "unpinned", existed: false });
    const entries = auditEntries(r).filter((entry) => entry.operation === "retention_pin");
    expect(entries.map((entry) => entry.details["pinned"])).toEqual([true, false]);
  });

  it("unpins an item whose row is gone, so a stale pin can be cleared", async () => {
    const r = rig();
    await r.kv.set(RETENTION_KV.pins, itemKey(mem("gone")), { ref: mem("gone"), who: "a", reason: "b", pinnedAt: NOW.toISOString() });
    expect(await unpinItem(r.deps, mem("gone"), "a")).toEqual({ kind: "unpinned", existed: true });
  });
});

describe("a pinned item survives", () => {
  it("a sweep: its rows stay live and indexed while the others move, and the report names the pin", async () => {
    const r = rig();
    await sealedSession(r, "ses_a", 3);
    const cases = await anchor(r);
    expect(await pinItem(r.deps, { ref: obs("ses_a", "ses_a_o1"), who: "owner", reason: "keep" })).toMatchObject({ kind: "pinned" });
    const result = swept(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(await liveIds(r, "ses_a")).toEqual(["ses_a_o1"]);
    expect(r.runtime.keyword.has("ses_a_o1")).toBe(true);
    expect(result.report.protectedSamples.pin).toContain("ses_a/ses_a_o1");
  });

  it("a sweep of memories: a pinned expired memory is not moved", async () => {
    const r = rig();
    await seedMemory(r, memory("m_expired"));
    await seedMemory(r, memory("m_other"));
    const cases = await anchor(r);
    await pinItem(r.deps, { ref: mem("m_expired"), who: "owner", reason: "keep" });
    swept(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(await r.kv.get(KV.memories, "m_expired")).not.toBeNull();
    expect(await r.kv.get(KV.memories, "m_other")).toBeNull();
  });

  it("a purge: pinned during grace, an item in the vault goes back instead of being deleted", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    const rows = [await seedObservation(r, observation("p1", "ses_p"), { seed: 1 }), await seedObservation(r, observation("p2", "ses_p"), { seed: 2 })];
    const seal = await seedSeal(r, "ses_p", 2);
    await closedRun(r, RUN, await Promise.all(rows.map((row) => candidate(r, "O", row, seal))), { graceDays: 1 });
    expect(await liveIds(r, "ses_p")).toEqual([]);

    const pinned = await pinItem(deps, { ref: obs("ses_p", "p1"), who: "owner", reason: "wanted it back" });
    expect(pinned).toMatchObject({ kind: "pinned", vaulted: true });
    expect(await r.vault.locate(obs("ses_p", "p1"))).not.toBeNull();

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, restoredBack: 1 });
    expect(await liveIds(r, "ses_p")).toEqual(["p1"]);
    expect(r.runtime.keyword.has("p1")).toBe(true);
    expect(await vectorHits(r, 1)).toContain("p1");
    expect(await r.kv.get(RETENTION_KV.tombstones, itemKey(obs("ses_p", "p1")))).toBeNull();
    expect(await r.kv.get(RETENTION_KV.tombstones, itemKey(obs("ses_p", "p2")))).not.toBeNull();
  });
});

describe("pinning a demoted memory", () => {
  async function demoted() {
    const runtime = createSearchRuntime({ kv: {} as never, embeddingProvider: provider }, "memory");
    const r = rig(() => runtime);
    await openRun(r);
    const row = await seedMemory(r, memory("mem_cold", { forgetAfter: undefined, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }), { seed: 7 });
    expect(await displace(r.deps, r.vault, RUN, await candidate(r, "C", row))).toMatchObject({ moved: true });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(true);
    expect(r.runtime.keyword.has("mem_cold")).toBe(false);
    return r;
  }

  it("un-demotes it from the stored vector with no embedding call, and keeps the pin", async () => {
    const r = await demoted();
    embed.mockClear();
    embedBatch.mockClear();
    const result = await pinItem(r.deps, { ref: mem("mem_cold"), who: "owner", reason: "needed" });
    expect(result).toMatchObject({ kind: "pinned", undemoted: true, vaulted: false });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(false);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold"]);
    expect(await vectorHits(r, 7)).toEqual(["mem_cold"]);
    expect(await r.kv.get(RETENTION_KV.demoted, "mem_cold")).toBeNull();
    expect(await r.kv.get(RETENTION_KV.pins, itemKey(mem("mem_cold")))).not.toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it("a later sweep does not demote it again", async () => {
    const r = await demoted();
    await pinItem(r.deps, { ref: mem("mem_cold"), who: "owner", reason: "needed" });
    await r.kv.set(KV.retentionScores, "mem_cold", { memoryId: "mem_cold", score: 0.05 });
    const cases = await anchor(r);
    const result = swept(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(result.report.perStage.C.moved).toBe(0);
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(false);
  });

  it("a memory that is not demoted is pinned with no restore and no restore audit", async () => {
    const r = rig();
    await seedMemory(r, memory("m1"));
    expect(await pinItem(r.deps, { ref: mem("m1"), who: "a", reason: "b" })).toMatchObject({ undemoted: false });
    expect(auditEntries(r).map((entry) => entry.operation)).toEqual(["retention_pin"]);
  });
});

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
import { restoreItems, restoreRun } from "../../../src/fork/retention/restore.js";
import { itemKey, RETENTION_KV, type Pin } from "../../../src/fork/retention/scopes.js";
import type { ItemRef, RunId } from "../../../src/fork/retention/types.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import { KV } from "../../../src/state/schema.js";
import type { Memory } from "../../../src/types.js";
import { createSearchRuntime } from "../../../src/state/search-ports.js";
import type { EmbeddingProvider } from "../../../src/types.js";
import { candidate, DIMS, keywordHits, memory, NOW, observation, openRun, rig, RUN, seedMemory, seedObservation, seedSeal, vectorHits } from "./move-fixtures.js";
import { at, clocked, closedRun, done, purge } from "./purge-fixtures.js";
import { liveIds, sealedSession } from "./plan-fixtures.js";
import { auditEntries, done as swept, indexHarness, sweep } from "./sweep-fixtures.js";
import { anchor, ENFORCE, liveRoutes } from "./api-fixtures.js";

const embed = vi.fn(async () => new Float32Array(DIMS).fill(0.5));
const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.5)));
const provider = { name: "spy", dimensions: DIMS, embed, embedBatch } as unknown as EmbeddingProvider;

const obs = (sessionId: string, id: string): ItemRef => ({ kind: "observation", sessionId, id });
const mem = (id: string): ItemRef => ({ kind: "memory", id });
const X_RUN = "ret_x" as RunId;

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

describe("a pin needs something restore can bring back", () => {
  const ref = obs("ses_t", "tt1");
  const TRIM_RUN = "ret_trim_old" as RunId;
  const OBS_RUN = "ret_obs_new" as RunId;

  /** Run TRIM_RUN trims the row, then OBS_RUN soft deletes it; OBS_RUN's grace ends first and the purge takes the row. */
  async function trimOnly() {
    const r = rig();
    const row = await seedObservation(r, observation("tt1", "ses_t"), { seed: 1 });
    const seal = await seedSeal(r, "ses_t", 1);
    await closedRun(r, TRIM_RUN, [await candidate(r, "T", row, seal)], { closedAt: NOW });
    const trimmed = (await r.kv.get<typeof row>(KV.observations("ses_t"), "tt1"))!;
    await closedRun(r, OBS_RUN, [await candidate(r, "O", trimmed, seal)], { closedAt: at(-48) });
    const cases = await anchor(r);
    const clock = { now: at(1) };
    const { call } = liveRoutes(r, clock, { env: { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases } });
    expect(await call("purge", { body: { dryRun: false } })).toMatchObject({ status_code: 200, body: { purged: 1 } });
    expect(await r.vault.get(TRIM_RUN, ref)).not.toBeNull();
    return { r, clock, call };
  }

  it("a trim entry whose row is gone everywhere is not found: nothing could be restored, so no pin is written", async () => {
    const { r, clock, call } = await trimOnly();
    expect(await call("pin", { body: { ref, reason: "the raw source must survive", who: "dana" } })).toMatchObject({ status_code: 404 });
    expect(await r.kv.get(RETENTION_KV.pins, itemKey(ref))).toBeNull();
    clock.now = at(25);
    expect(await call("purge", { body: { dryRun: false } })).toMatchObject({ status_code: 200, body: { purged: 1 } });
    expect(await r.vault.get(TRIM_RUN, ref)).toBeNull();
  });

  it("an entry purge has committed is not found either: the purge finishes it whatever a pin says", async () => {
    const r = rig();
    const row = await seedObservation(r, observation("p1", "ses_p"), { seed: 1 });
    await closedRun(r, RUN, [await candidate(r, "O", row, await seedSeal(r, "ses_p", 1))]);
    await r.vault.update({ ...(await r.vault.get(RUN, obs("ses_p", "p1")))!, purging: true });
    expect(await pinItem(r.deps, { ref: obs("ses_p", "p1"), who: "a", reason: "b" })).toEqual({ kind: "not-found" });
  });
});

describe("a pin that lands after the Protector judged the item and before the move", () => {
  it("a sweep's demote: the pin wins, the memory stays live and indexed, and a second sweep leaves it", async () => {
    const r = rig();
    await seedMemory(r, memory("mem_cold", { forgetAfter: undefined, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" }), { seed: 7 });
    await r.kv.set(KV.retentionScores, "mem_cold", { memoryId: "mem_cold", score: 0.05 });
    const cases = await anchor(r);
    const key = itemKey(mem("mem_cold"));
    const get = r.kv.get.bind(r.kv);
    let pinReads = 0;
    let pinned: unknown = null;
    (r.kv as { get: unknown }).get = async (scope: string, k: string) => {
      const value = await get(scope, k);
      if (scope === RETENTION_KV.pins && k === key && ++pinReads === 2) pinned = await pinItem(r.deps, { ref: mem("mem_cold"), who: "owner", reason: "keep it" });
      return value;
    };
    const first = swept(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(pinned).toMatchObject({ kind: "pinned", undemoted: false });
    expect(first.report.perStage.C.moved).toBe(0);
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(false);
    expect(r.runtime.keyword.has("mem_cold")).toBe(true);
    expect(swept(await sweep(r, indexHarness(r, await anchor(r)), { dryRun: false })).report.perStage.C.moved).toBe(0);
    expect(await r.kv.get(RETENTION_KV.demoted, "mem_cold")).toBeNull();
  });

  async function judgedThenPinned(stage: "T" | "O" | "S" | "X" | "C") {
    const r = rig();
    await openRun(r);
    if (stage === "T" || stage === "O") {
      const row = await seedObservation(r, observation("o1", "ses_a"), { seed: 1 });
      const item = await candidate(r, stage, row, await seedSeal(r, "ses_a", 1));
      await pinItem(r.deps, { ref: obs("ses_a", "o1"), who: "owner", reason: "keep" });
      return { r, item, ref: obs("ses_a", "o1") };
    }
    const row = await seedMemory(r, memory("m1", { forgetAfter: stage === "X" ? "2026-02-01T00:00:00.000Z" : undefined }), { seed: 1 });
    const item = await candidate(r, stage, row);
    await pinItem(r.deps, { ref: mem("m1"), who: "owner", reason: "keep" });
    return { r, item, ref: mem("m1") };
  }

  it.each(["T", "O", "S", "X", "C"] as const)("stage %s: displace sees the pin under the item lock and moves nothing", async (stage) => {
    const { r, item, ref } = await judgedThenPinned(stage);
    const before = await r.kv.get(ref.kind === "memory" ? KV.memories : KV.observations(ref.sessionId), ref.id);
    expect(await displace(r.deps, r.vault, RUN, item)).toEqual({ moved: false, bytes: 0, skipped: "pinned" });
    expect(await r.kv.get(ref.kind === "memory" ? KV.memories : KV.observations(ref.sessionId), ref.id)).toEqual(before);
    expect(await r.vault.locate(ref)).toBeNull();
    expect(r.runtime.keyword.has(ref.id)).toBe(true);
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

  /** Demoted by RUN, then soft deleted by a stage X run during the demote: the row is only in X's vault, still marked. */
  async function demotedThenExpired() {
    const r = await demoted();
    const marked = (await r.kv.get<Memory>(KV.memories, "mem_cold"))!;
    await closedRun(r, X_RUN, [await candidate(r, "X", marked)], { graceDays: 1 });
    expect(await r.kv.get(KV.memories, "mem_cold")).toBeNull();
    embed.mockClear();
    embedBatch.mockClear();
    return r;
  }

  it("pinned while its row is only in a vault, it keeps its demote record and purge brings it back un-demoted, with no embedding call", async () => {
    const r = await demotedThenExpired();
    const { clock, deps } = clocked(r);
    expect(await pinItem(deps, { ref: mem("mem_cold"), who: "owner", reason: "keep" })).toMatchObject({ kind: "pinned", vaulted: true, undemoted: false });
    expect(await r.kv.get(RETENTION_KV.demoted, "mem_cold")).not.toBeNull();
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ restoredBack: 1, purged: 0 });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(false);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_cold"]);
    expect(await vectorHits(r, 7)).toEqual(["mem_cold"]);
    expect(await r.kv.get(RETENTION_KV.demoted, "mem_cold")).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it("restoring the run that soft deleted it, with no pin, brings it back still demoted, mark and record together", async () => {
    const r = await demotedThenExpired();
    expect(await restoreRun(r.deps, X_RUN, "test")).toMatchObject({ restored: 1 });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(true);
    expect(await r.kv.get(RETENTION_KV.demoted, "mem_cold")).not.toBeNull();
    expect(r.runtime.keyword.has("mem_cold")).toBe(false);
  });

  it("restoring the demoting run while the row is in another vault defers the un-demote and keeps the record", async () => {
    const r = await demotedThenExpired();
    expect(await restoreRun(r.deps, RUN, "test")).toMatchObject({ restored: 0, keptLive: 0, deferred: 1 });
    expect(await r.kv.get(RETENTION_KV.demoted, "mem_cold")).not.toBeNull();
    expect(await restoreItems(r.deps, [mem("mem_cold")], "test")).toMatchObject({ restored: 2 });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "mem_cold"))).toBe(false);
    expect(await vectorHits(r, 7)).toEqual(["mem_cold"]);
    expect(embed).not.toHaveBeenCalled();
  });

  it("a memory that is not demoted is pinned with no restore and no restore audit", async () => {
    const r = rig();
    await seedMemory(r, memory("m1"));
    expect(await pinItem(r.deps, { ref: mem("m1"), who: "a", reason: "b" })).toMatchObject({ undemoted: false });
    expect(auditEntries(r).map((entry) => entry.operation)).toEqual(["retention_pin"]);
  });
});

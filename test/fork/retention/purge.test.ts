// Slice 7: purge. R4 (grace and purge), protection re-checked at purge, tombstones, demote records, R13 (purge half), off and dry run.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { loadActiveClock } from "../../../src/fork/retention/clock.js";
import { createProtector } from "../../../src/fork/retention/protect.js";
import { purgeExpired } from "../../../src/fork/retention/purge.js";
import { registerRetention } from "../../../src/fork/retention/register.js";
import { restoreItems } from "../../../src/fork/retention/restore.js";
import { LEASE_STALE_MS, RunStore } from "../../../src/fork/retention/run-store.js";
import { parseRetentionSettings } from "../../../src/fork/retention/settings.js";
import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import type { DemoteRecord, ItemRef, ObservationTombstone, RunId } from "../../../src/fork/retention/types.js";
import { Vault } from "../../../src/fork/retention/vault.js";
import type { RetentionDeps } from "../../../src/fork/retention/satellites.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation, Insight, Memory } from "../../../src/types.js";
import { NOW, candidate, memory, observation, rig, seedMemory, seedObservation, seedSeal, vec, type Rig } from "./move-fixtures.js";
import { pin, sealedSession } from "./plan-fixtures.js";
import { at, clocked, closedRun, DAY, done, purge, purgeSettings, snapshot, writeCount } from "./purge-fixtures.js";
import { auditEntries, goldenCase, indexHarness, sweep, uncapped, vaultKeys, writeCases } from "./sweep-fixtures.js";

const obs = (sessionId: string, id: string): ItemRef => ({ kind: "observation", sessionId, id });
const mem = (id: string): ItemRef => ({ kind: "memory", id });
const QUOKKA = (id: string, session: string) => observation(id, session, { title: "quokka migration plan", narrative: `quokka ${id} narrative` });
const A = "ret_a" as RunId;
const B = "ret_b" as RunId;

afterEach(() => {
  resetSummarizeVeto();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Everything except retention's bookkeeping that a dry run may touch (the lease, the active-day cache). */
const stable = (r: Rig): string =>
  JSON.stringify(JSON.parse(snapshot(r)).filter(([scope, rows]: [string, unknown[]]) => rows.length > 0 && scope !== RETENTION_KV.control && scope !== RETENTION_KV.activeDays));

/** `stable` without the audit log. */
const withoutAudit = (r: Rig): string => JSON.stringify(JSON.parse(stable(r)).filter(([scope]: [string]) => !scope.startsWith("mem:audit")));

async function movedObservations(r: Rig, ids: readonly string[], opts: { session?: string; closedAt?: Date; graceDays?: number; runId?: RunId } = {}): Promise<CompressedObservation[]> {
  const session = opts.session ?? "ses_p";
  const rows = [];
  for (const [n, id] of ids.entries()) rows.push(await seedObservation(r, observation(id, session), { seed: n + 1 }));
  const seal = await seedSeal(r, session, rows.length);
  const items = await Promise.all(rows.map((row) => candidate(r, "O", row, seal)));
  await closedRun(r, opts.runId ?? A, items, opts);
  return rows;
}

describe("R4: hard delete only after the grace period", () => {
  async function world() {
    const r = rig();
    const { clock, deps } = clocked(r);
    await sealedSession(r, "ses_q", 0, { rows: [QUOKKA("q1", "ses_q"), QUOKKA("q2", "ses_q")] });
    await sealedSession(r, "ses_keep", 0, { rows: [QUOKKA("k1", "ses_keep")] });
    await pin(r, obs("ses_keep", "k1"));
    r.runtime.vector.add("q1", "ses_q", vec(1));
    r.runtime.vector.add("q2", "ses_q", vec(2));
    await seedMemory(r, memory("m_expired"), { seed: 3 });
    await seedMemory(r, memory("m_old", { isLatest: false, forgetAfter: undefined, updatedAt: "2026-01-01T00:00:00.000Z" }), { seed: 4 });
    await seedMemory(r, memory("m_next", { version: 2, supersedes: ["m_old"], parentId: "m_old", forgetAfter: undefined }));
    await uncapped(r);
    const cases = writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] });
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false, graceDaysOverride: 1 }, deps));
    return { r, clock, deps, runId: result.runId };
  }

  it("is restorable at 23 hours, and gone from KV, the vault, the locator and both indexes at 25 hours", async () => {
    const { r, clock, deps, runId } = await world();
    expect((await r.runs.get(runId))).toMatchObject({ outcome: "kept", held: 4, graceDays: 1 });
    expect(await vaultKeys(r, runId)).toHaveLength(4);

    clock.now = at(23);
    expect(done(await purge(deps))).toMatchObject({ purged: 0, restoredBack: 0 });
    expect(await vaultKeys(r, runId)).toHaveLength(4);
    expect(await restoreItems(deps, [obs("ses_q", "q2")], "changed my mind")).toMatchObject({ restored: 1 });
    expect(await r.kv.get(KV.observations("ses_q"), "q2")).not.toBeNull();
    expect(r.runtime.keyword.has("q2")).toBe(true);
    expect(r.runtime.vector.has("q2")).toBe(true);

    clock.now = at(25);
    const result = done(await purge(deps));
    expect(result).toMatchObject({ purged: 3, restoredBack: 0, runsEmptied: 1 });

    expect(await r.kv.get(KV.observations("ses_q"), "q1")).toBeNull();
    expect(await r.kv.get(KV.memories, "m_expired")).toBeNull();
    expect(await r.kv.get(KV.memories, "m_old")).toBeNull();
    expect(await vaultKeys(r, runId)).toEqual([]);
    expect(await r.kv.listKeys(RETENTION_KV.items)).toEqual([]);
    for (const id of ["q1", "m_expired", "m_old"]) {
      expect(r.runtime.keyword.has(id)).toBe(false);
      expect(r.runtime.vector.has(id)).toBe(false);
    }
    expect(await restoreItems(deps, [obs("ses_q", "q1"), mem("m_expired"), mem("m_old")], "too late")).toMatchObject({ restored: 0 });
    expect(await r.kv.get(KV.observations("ses_q"), "q2")).not.toBeNull();
    expect(await r.kv.get(KV.observations("ses_keep"), "k1")).not.toBeNull();
  });

  it("brings `held` to 0 and marks the run purged", async () => {
    const { r, clock, deps, runId } = await world();
    clock.now = at(25);
    await purge(deps);
    expect(await r.runs.get(runId)).toMatchObject({ held: 0, phase: "done", outcome: "kept", purgedAt: at(25).toISOString() });
  });

  it("takes the grace from the run's own snapshot, not from today's settings", async () => {
    const { r, clock, deps, runId } = await world();
    await r.runs.save({ ...(await r.runs.get(runId))!, graceDays: 3 });
    clock.now = at(25);
    expect(done(await purge(deps, {}, purgeSettings(1)))).toMatchObject({ purged: 0 });
    clock.now = at(72);
    expect(done(await purge(deps, {}, purgeSettings(30)))).toMatchObject({ purged: 4 });
  });

  it("writes a tombstone for each purged observation, and none for a memory", async () => {
    const { r, clock, deps, runId } = await world();
    clock.now = at(25);
    await purge(deps);
    expect(await r.kv.get<ObservationTombstone>(RETENTION_KV.tombstones, itemKey(obs("ses_q", "q1")))).toEqual({
      sessionId: "ses_q", runId, deletedAt: at(25).toISOString(), summarySessionId: "ses_q",
    });
    expect(await r.kv.listKeys(RETENTION_KV.tombstones)).toHaveLength(2);
  });

  it("audits one retention_purge entry per run with counts, run id and reason (R13)", async () => {
    const { r, clock, deps, runId } = await world();
    clock.now = at(25);
    await purge(deps);
    const entries = auditEntries(r).filter((e) => e.operation === "retention_purge");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.functionId).toBe("mem::retention-purge");
    expect(entries[0]!.details).toMatchObject({ runId, purged: 4, restoredBack: 0, dropped: 0, remaining: 0, graceDays: 1, reason: "grace period of 1 day(s) elapsed" });
  });

  it("a second purge changes nothing, not even the lease", async () => {
    const { r, clock, deps } = await world();
    clock.now = at(25);
    await purge(deps);
    const before = snapshot(r);
    const writes = writeCount(r);
    expect(done(await purge(deps))).toMatchObject({ purged: 0, restoredBack: 0, runsEmptied: 0 });
    expect(snapshot(r)).toBe(before);
    expect(writeCount(r)).toBe(writes);
  });

  it("never touches a run that has not finished, a dry run, or a run whose vault is empty", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    const rows = await movedObservations(r, ["u1", "u2"]);
    expect(rows).toHaveLength(2);
    const run = (await r.runs.get(A))!;
    await r.runs.save({ ...run, phase: "apply", outcome: "running" });
    clock.now = at(24 * 40);
    expect(done(await purge(deps))).toMatchObject({ purged: 0 });
    await r.runs.save({ ...run, dryRun: true });
    expect(done(await purge(deps))).toMatchObject({ purged: 0 });
    expect(await vaultKeys(r, A)).toHaveLength(2);
  });
});

describe("stage T: purge drops only the vaulted source", () => {
  async function trimmed(ids: readonly string[], opts: { closedAt?: Date; graceDays?: number; runId?: RunId } = {}) {
    const r = rig();
    const clocks = clocked(r);
    const rows = [];
    for (const [n, id] of ids.entries()) rows.push(await seedObservation(r, observation(id, "ses_t"), { seed: n + 1 }));
    const seal = await seedSeal(r, "ses_t", rows.length);
    await closedRun(r, opts.runId ?? A, await Promise.all(rows.map((row) => candidate(r, "T", row, seal))), opts);
    return { r, ...clocks };
  }

  it("keeps the live row, indexed, with its truncated source, and empties the vault", async () => {
    const { r, clock, deps } = await trimmed(["t1", "t2"]);
    const live = await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "t1");
    expect(live!.source).toMatchObject({ truncated: true });
    expect(await vaultKeys(r, A)).toHaveLength(2);

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 2, runsEmptied: 1 });

    expect(await vaultKeys(r, A)).toEqual([]);
    expect(await r.kv.listKeys(RETENTION_KV.items)).toEqual([]);
    expect(await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "t1")).toEqual(live);
    expect(r.runtime.keyword.has("t1")).toBe(true);
    expect(r.runtime.vector.has("t1")).toBe(true);
    expect(await r.kv.listKeys(RETENTION_KV.tombstones)).toEqual([]);
    expect(await restoreItems(deps, [obs("ses_t", "t1")], "late")).toMatchObject({ restored: 0 });
    expect((await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "t1"))!.source).toMatchObject({ truncated: true });
  });

  it("restores the source of a trimmed row that became important during grace, and purges the others", async () => {
    const { r, clock, deps } = await trimmed(["t1", "t2"]);
    const live = (await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "t1"))!;
    await r.kv.set(KV.observations("ses_t"), "t1", { ...live, importance: 9 });
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, restoredBack: 1 });
    expect((await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "t1"))!.source).toMatchObject({ truncated: false, toolOutput: expect.any(String) });
    expect((await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "t2"))!.source).toMatchObject({ truncated: true });
    expect(await vaultKeys(r, A)).toEqual([]);
  });
});

describe("the T-then-O two-claim locator", () => {
  async function stacked(a: { graceDays: number; closedAt: Date }, b: { graceDays: number; closedAt: Date }) {
    const r = rig();
    const clocks = clocked(r);
    const row = await seedObservation(r, observation("x1", "ses_x"), { seed: 1 });
    const seal = await seedSeal(r, "ses_x", 1);
    await closedRun(r, A, [await candidate(r, "T", row, seal)], a);
    const trimmedRow = (await r.kv.get<CompressedObservation>(KV.observations("ses_x"), "x1"))!;
    await closedRun(r, B, [await candidate(r, "O", trimmedRow, seal)], b);
    const ref = obs("ses_x", "x1");
    expect(await r.vault.locate(ref)).toMatchObject({ runId: B, stage: "O", under: { runId: A, stage: "T" } });
    return { r, ref, ...clocks };
  }

  it("purging the trim first leaves the stage O claim whole, and restore gives the trimmed row", async () => {
    const { r, ref, clock, deps } = await stacked({ graceDays: 1, closedAt: NOW }, { graceDays: 1, closedAt: at(12) });
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, runsEmptied: 1 });
    expect(await r.vault.locate(ref)).toEqual({ runId: B, stage: "O" });
    expect(await vaultKeys(r, A)).toEqual([]);
    expect(await vaultKeys(r, B)).toHaveLength(1);
    expect(await restoreItems(deps, [ref], "test")).toMatchObject({ restored: 1 });
    expect((await r.kv.get<CompressedObservation>(KV.observations("ses_x"), "x1"))!.source).toMatchObject({ truncated: true });
  });

  it("purging the observation first leaves the trim claim as the head, and purging it later empties both", async () => {
    const { r, ref, clock, deps } = await stacked({ graceDays: 10, closedAt: NOW }, { graceDays: 1, closedAt: NOW });
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, runsEmptied: 1 });
    expect(await r.kv.get(KV.observations("ses_x"), "x1")).toBeNull();
    expect(await r.vault.locate(ref)).toEqual({ runId: A, stage: "T" });
    expect(await r.kv.get(RETENTION_KV.tombstones, itemKey(ref))).toMatchObject({ runId: B, sessionId: "ses_x" });

    clock.now = at(24 * 11);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, runsEmptied: 1 });
    expect(await r.vault.locate(ref)).toBeNull();
    expect(await vaultKeys(r, A)).toEqual([]);
    expect(await vaultKeys(r, B)).toEqual([]);
    expect(await r.kv.get(RETENTION_KV.tombstones, itemKey(ref))).toMatchObject({ runId: B });
    expect(await r.kv.get(KV.observations("ses_x"), "x1")).toBeNull();
  });

  it("a protected trim entry whose row was purged by the later run has nothing to restore into, and is purged", async () => {
    const { r, ref, clock, deps } = await stacked({ graceDays: 30, closedAt: NOW }, { graceDays: 1, closedAt: NOW });
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, runsEmptied: 1 });
    await pin(r, ref);
    clock.now = at(24 * 31);
    expect(done(await purge(deps, { dryRun: true }))).toMatchObject({ purged: 1, deferred: 0, runsEmptied: 1 });
    expect(done(await purge(deps))).toMatchObject({ purged: 1, restoredBack: 0, deferred: 0, runsEmptied: 1 });
    expect(await r.runs.get(A)).toMatchObject({ held: 0, purgedAt: at(24 * 31).toISOString() });
    expect(await vaultKeys(r, A)).toEqual([]);
    expect(await r.vault.locate(ref)).toBeNull();
    expect(await r.kv.get(KV.observations("ses_x"), "x1")).toBeNull();
  });

  it("a protected trim entry whose row sits in another run's vault is deferred, stays held, and each pass audits only the deferral", async () => {
    const { r, ref, clock, deps } = await stacked({ graceDays: 1, closedAt: NOW }, { graceDays: 30, closedAt: NOW });
    await pin(r, ref);
    clock.now = at(25);
    const before = withoutAudit(r);
    expect(done(await purge(deps))).toMatchObject({ purged: 0, restoredBack: 0, deferred: 1, runsEmptied: 0 });
    expect(withoutAudit(r)).toBe(before);
    expect(await vaultKeys(r, A)).toHaveLength(1);
    expect(await r.runs.get(A)).toMatchObject({ held: 1 });
    expect((await r.runs.get(A))!.purgedAt).toBeUndefined();
    done(await purge(deps));
    expect(withoutAudit(r)).toBe(before);
    const audited = auditEntries(r).filter((e) => e.operation === "retention_purge");
    expect(audited.map((e) => e.details)).toEqual([0, 1].map(() => expect.objectContaining({ runId: A, purged: 0, deferred: 1, remaining: 1, heldBefore: 1 })));
  });

  it("audits every due run a pass visits, the one that only deferred as well as the one it emptied", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["a1"], { session: "ses_a", runId: "ret_plain" as RunId });
    const row = await seedObservation(r, observation("x1", "ses_x"), { seed: 2 });
    const seal = await seedSeal(r, "ses_x", 1);
    await closedRun(r, A, [await candidate(r, "T", row, seal)]);
    const trimmedRow = (await r.kv.get<CompressedObservation>(KV.observations("ses_x"), "x1"))!;
    await closedRun(r, B, [await candidate(r, "O", trimmedRow, seal)], { graceDays: 30 });
    await pin(r, obs("ses_x", "x1"));
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, deferred: 1, runsEmptied: 1 });
    const audited = auditEntries(r).filter((e) => e.operation === "retention_purge").map((e) => e.details as { runId: string; deferred: number });
    expect(audited.map(({ runId, deferred }) => ({ runId, deferred })).sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      { runId: A, deferred: 1 },
      { runId: "ret_plain", deferred: 0 },
    ]);
  });
});

describe("protection is re-checked at purge", () => {
  async function world() {
    const r = rig();
    const clocks = clocked(r);
    const rows = await movedObservations(r, ["o_plain", "o_pin", "o_cited", "o_hit"], { closedAt: NOW });
    await seedMemory(r, memory("m_x"), { seed: 8 });
    await seedMemory(r, memory("m_y"), { seed: 9 });
    const x = await candidate(r, "X", (await r.kv.get<Memory>(KV.memories, "m_x"))!);
    const y = await candidate(r, "X", (await r.kv.get<Memory>(KV.memories, "m_y"))!);
    await closedRun(r, B, [x, y], { closedAt: NOW });
    return { r, rows, ...clocks };
  }

  it("restores what was pinned, cited by a latest memory, cited by an insight or accessed during grace, and purges the rest", async () => {
    const { r, clock, deps } = await world();
    await pin(r, obs("ses_p", "o_pin"));
    await seedMemory(r, memory("m_cites", { forgetAfter: undefined, sourceObservationIds: ["o_cited"] }));
    await r.kv.set(KV.accessLog, "o_hit", { memoryId: "o_hit", count: 1, lastAt: at(24).toISOString(), recent: [] });
    await r.kv.set(KV.insights, "ins_1", { id: "ins_1", title: "t", content: "c", confidence: 0.5, sourceMemoryIds: ["m_y"], deleted: false } as unknown as Insight);

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 2, restoredBack: 4, runsEmptied: 2 });

    for (const id of ["o_pin", "o_cited", "o_hit"]) {
      expect(await r.kv.get(KV.observations("ses_p"), id)).not.toBeNull();
      expect(r.runtime.keyword.has(id)).toBe(true);
      expect(r.runtime.vector.has(id)).toBe(true);
    }
    expect(await r.kv.get(KV.memories, "m_y")).not.toBeNull();
    expect(r.runtime.keyword.has("m_y")).toBe(true);
    expect(await r.kv.get(KV.observations("ses_p"), "o_plain")).toBeNull();
    expect(await r.kv.get(KV.memories, "m_x")).toBeNull();
    expect(await vaultKeys(r, A)).toEqual([]);
    expect(await vaultKeys(r, B)).toEqual([]);
    expect(await r.kv.listKeys(RETENTION_KV.items)).toEqual([]);
    expect(await r.kv.listKeys(RETENTION_KV.tombstones)).toEqual([itemKey(obs("ses_p", "o_plain"))]);
    expect(await r.kv.get(KV.accessLog, "o_hit")).not.toBeNull();
    expect(await r.runs.get(A)).toMatchObject({ held: 0 });
  });

  it("builds its Protector from the current settings' windows: an access older than the cold window protects only under a wide one", async () => {
    const stale = at(-24 * 400).toISOString();
    for (const [windows, expected] of [["trim:45,obs:180,sup:180,cold:1", { purged: 6, restoredBack: 0 }], ["trim:45,obs:180,sup:180,cold:365", { purged: 5, restoredBack: 1 }]] as const) {
      const { r, clock, deps } = await world();
      await r.kv.set(KV.accessLog, "o_hit", { memoryId: "o_hit", count: 1, lastAt: stale, recent: [] });
      clock.now = at(25);
      expect(done(await purge(deps, {}, purgeSettings(1, windows)))).toMatchObject(expected);
    }
  });

  it("counts a protected entry in the report of a dry run and writes nothing", async () => {
    const { r, clock, deps } = await world();
    await pin(r, obs("ses_p", "o_pin"));
    clock.now = at(25);
    const before = stable(r);
    expect(done(await purge(deps, { dryRun: true }))).toMatchObject({ dryRun: true, purged: 5, restoredBack: 1 });
    expect(stable(r)).toBe(before);
    expect(await vaultKeys(r, A)).toHaveLength(4);
    expect(auditEntries(r).filter((e) => e.operation === "retention_purge")).toEqual([]);
  });
});

describe("demote records", () => {
  it("deletes mem:retention:demoted for a purged memory and leaves another memory's record", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await seedMemory(r, memory("m_dem", { forgetAfter: "2026-02-01T00:00:00.000Z" }), { seed: 1 });
    await seedMemory(r, memory("m_other", { forgetAfter: undefined }), { seed: 2 });
    await closedRun(r, A, [await candidate(r, "C", (await r.kv.get<Memory>(KV.memories, "m_other"))!)]);
    await r.kv.set<DemoteRecord>(RETENTION_KV.demoted, "m_dem", { memoryId: "m_dem", runId: A, demotedAt: NOW.toISOString(), reason: { stage: "C", ageActiveDays: 400, note: "cold" } });
    await closedRun(r, B, [await candidate(r, "X", (await r.kv.get<Memory>(KV.memories, "m_dem"))!)]);
    expect(await r.kv.get(RETENTION_KV.demoted, "m_dem")).not.toBeNull();
    expect(await r.kv.get(RETENTION_KV.demoted, "m_other")).not.toBeNull();

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });
    expect(await r.kv.get(RETENTION_KV.demoted, "m_dem")).toBeNull();
    expect(await r.kv.get(RETENTION_KV.demoted, "m_other")).toMatchObject({ memoryId: "m_other" });
  });
});

describe("the lease", () => {
  it("returns busy and does nothing while a sweep holds the lease", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["b1"]);
    clock.now = at(25);
    const owner = new RunStore(r.kv, deps.now);
    expect(await owner.acquireLease("sweep-other")).toEqual({ held: true });
    const before = snapshot(r);
    expect(await purge(deps)).toEqual({ kind: "busy", heldBy: "sweep-other" });
    expect(snapshot(r)).toBe(before);
    await owner.releaseLease("sweep-other");
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });
  });

  it("takes over a lease whose heartbeat is stale, and releases its own when done", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["b1"]);
    const owner = new RunStore(r.kv, deps.now);
    await owner.acquireLease("sweep-dead");
    clock.now = new Date(at(25).getTime() + LEASE_STALE_MS + 1);
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });
    expect(await r.kv.listKeys(RETENTION_KV.control)).toEqual([]);
  });

  it("takes no lease when no run is due", async () => {
    const r = rig();
    const { deps } = clocked(r);
    await movedObservations(r, ["b1"]);
    const writes = writeCount(r);
    expect(done(await purge(deps))).toMatchObject({ purged: 0 });
    expect(writeCount(r)).toBe(writes);
  });

  it("heartbeats once per page of a run's vault and once before each commit", async () => {
    const r = rig();
    const ids = Array.from({ length: 201 }, (_, i) => `h${i}`);
    for (const id of ids) await seedObservation(r, observation(id, "ses_h"), { indexed: false });
    const seal = await seedSeal(r, "ses_h", ids.length);
    const protectors = await createProtector(r.kv, { supersededDays: 0, coldDays: 0 }, await loadActiveClock(r.kv, () => NOW));
    const items = [];
    for (const id of ids) items.push(await candidate(r, "O", (await r.kv.get<CompressedObservation>(KV.observations("ses_h"), id))!, seal));
    await closedRun(r, A, items);
    const beat = vi.fn(async () => {});
    const result = await purgeExpired(r.deps, protectors, at(25), { beat, pauseMs: 0 });
    expect(result).toMatchObject({ purged: 201, runsEmptied: 1 });
    expect(beat).toHaveBeenCalledTimes(2 + 201);
  });

  it("stops with lease-lost when the heartbeat finds the lease taken, and leaves every entry restorable", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["b1", "b2"]);
    clock.now = at(25);
    vi.spyOn(RunStore.prototype, "heartbeat").mockResolvedValue(false);
    expect(await purge(deps)).toEqual({ kind: "lease-lost" });
    expect(await vaultKeys(r, A)).toHaveLength(2);
    expect((await r.vault.get(A, obs("ses_p", "b1")))!.purging).toBeUndefined();
  });

  it("releases a spilled Protector's scratch when the pass ends, and when it fails", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["s1", "s2"]);
    await seedMemory(r, memory("m_cites", { forgetAfter: undefined, sourceObservationIds: ["s1", "unrelated"] }));
    clock.now = at(25);
    const spy = vi.spyOn(Vault.prototype, "update");
    spy.mockRejectedValueOnce(new Error("disk full"));
    await expect(purge(deps, { spillIds: 0 })).rejects.toThrow("disk full");
    expect(await r.kv.listKeys(RETENTION_KV.sweepScratch)).toEqual([]);
    expect(await r.kv.listKeys(RETENTION_KV.control)).toEqual([]);
    expect(done(await purge(deps, { spillIds: 0 }))).toMatchObject({ purged: 1, restoredBack: 1 });
    expect(await r.kv.listKeys(RETENTION_KV.sweepScratch)).toEqual([]);
  });
});

describe("off and dry run", () => {
  it("is a no-op with zero reads and writes when retention is off", async () => {
    const r = rig();
    await movedObservations(r, ["o1"]);
    const { clock, deps } = clocked(r);
    clock.now = at(24 * 400);
    const ops = r.h.stateOps.length;
    const before = snapshot(r);
    expect(await purge(deps, {}, parseRetentionSettings({}))).toEqual({ kind: "off", why: expect.any(String) });
    expect(r.h.stateOps.length).toBe(ops);
    expect(snapshot(r)).toBe(before);
  });

  it("mem::retention-purge is off by default, defaults to a dry run, and purges with dryRun false", async () => {
    const r = rig();
    registerRetention(r.h.sdk as never, r.kv);
    const ops = r.h.stateOps.length;
    expect(await r.h.call("mem::retention-purge")).toMatchObject({ kind: "off" });
    expect(r.h.stateOps.length).toBe(ops);

    vi.stubEnv("AM_RETENTION", "enforce");
    vi.stubEnv("AM_RETENTION_WINDOWS", "trim:45,obs:180,sup:180,cold:365");
    vi.stubEnv("AM_RETENTION_GRACE_DAYS", "1");
    const live = rig();
    resetSummarizeVeto();
    registerRetention(live.h.sdk as never, live.kv);
    await movedObservations(live, ["o1", "o2"], { closedAt: new Date(Date.now() - 2 * DAY) });
    const before = stable(live);
    expect(await live.h.call("mem::retention-purge")).toMatchObject({ kind: "done", dryRun: true, purged: 2 });
    expect(await live.h.call("mem::retention-purge", { dryRun: true })).toMatchObject({ dryRun: true, purged: 2 });
    expect(stable(live)).toBe(before);
    expect(await live.h.call("mem::retention-purge", { dryRun: false })).toMatchObject({ kind: "done", dryRun: false, purged: 2, runsEmptied: 1 });
    expect(await vaultKeys(live, A)).toEqual([]);
  });
});

describe("a dry run reports what the enforcing pass then does", () => {
  /** Dry run first, then the real pass on the same state: same counts, and the dry run wrote nothing outside retention's bookkeeping. */
  async function both(r: Rig, deps: RetentionDeps) {
    const before = stable(r);
    const dry = done(await purge(deps, { dryRun: true }));
    expect(stable(r)).toBe(before);
    const real = done(await purge(deps));
    return { dry, real };
  }

  it("a recaptured row: both drop the vault copy", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    const [row] = await movedObservations(r, ["rc1"]);
    await r.kv.set(KV.observations("ses_p"), "rc1", { ...row!, title: "recaptured" });
    clock.now = at(25);
    const { dry, real } = await both(r, deps);
    expect(real).toMatchObject({ purged: 0, dropped: 1, deferred: 0, runsEmptied: 1 });
    expect(dry).toEqual({ ...real, dryRun: true });
  });

  it("an entry mid-restore: both finish the restore", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["rs1"]);
    const entry = (await r.vault.get(A, obs("ses_p", "rs1")))!;
    await r.vault.update({ ...entry, restoring: true });
    clock.now = at(25);
    const { dry, real } = await both(r, deps);
    expect(real).toMatchObject({ purged: 0, restoredBack: 1, deferred: 0, runsEmptied: 1 });
    expect(dry).toEqual({ ...real, dryRun: true });
  });

  it("a protected trim entry whose live row was rewritten: both drop it", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    const row = await seedObservation(r, observation("rt1", "ses_t"), { seed: 1 });
    await closedRun(r, A, [await candidate(r, "T", row, await seedSeal(r, "ses_t", 1))]);
    const trimmed = (await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "rt1"))!;
    await r.kv.set(KV.observations("ses_t"), "rt1", { ...trimmed, title: "rewritten after the trim" });
    await pin(r, obs("ses_t", "rt1"));
    clock.now = at(25);
    const { dry, real } = await both(r, deps);
    expect(real).toMatchObject({ purged: 0, restoredBack: 0, dropped: 1, runsEmptied: 1 });
    expect(dry).toEqual({ ...real, dryRun: true });
  });
});

describe("entries that must not be purged", () => {
  it("does not purge an entry whose live row came back by recapture, and drops its vault copy", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    const [row] = await movedObservations(r, ["rc1"]);
    await r.kv.set(KV.observations("ses_p"), "rc1", { ...row!, title: "recaptured under the same id" });
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 0, dropped: 1, runsEmptied: 1 });
    expect((await r.kv.get<CompressedObservation>(KV.observations("ses_p"), "rc1"))!.title).toBe("recaptured under the same id");
    expect(await r.kv.listKeys(RETENTION_KV.tombstones)).toEqual([]);
  });

  it("finishes a restore that crashed after its mark instead of purging the entry", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["rs1"]);
    const entry = (await r.vault.get(A, obs("ses_p", "rs1")))!;
    await r.vault.update({ ...entry, restoring: true });
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 0, restoredBack: 1 });
    expect(await r.kv.get(KV.observations("ses_p"), "rs1")).not.toBeNull();
    expect(r.runtime.keyword.has("rs1")).toBe(true);
  });

  it("is never restorable once purge has marked it, even when it is protected afterwards", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await movedObservations(r, ["pg1"]);
    const entry = (await r.vault.get(A, obs("ses_p", "pg1")))!;
    await r.vault.update({ ...entry, purging: true });
    await pin(r, obs("ses_p", "pg1"));
    expect(await restoreItems(deps, [obs("ses_p", "pg1")], "late")).toMatchObject({ restored: 0, deferred: 1 });
    expect(await r.kv.get(KV.observations("ses_p"), "pg1")).toBeNull();
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, restoredBack: 0 });
    expect(await r.kv.get(KV.observations("ses_p"), "pg1")).toBeNull();
  });
});

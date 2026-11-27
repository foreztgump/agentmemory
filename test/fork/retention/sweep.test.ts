import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { RecallHarness } from "../../../src/fork/retention/recall-check.js";
import { LEASE_STALE_MS } from "../../../src/fork/retention/run-store.js";
import type { RunId, RunRow } from "../../../src/fork/retention/types.js";
import { KV } from "../../../src/state/schema.js";
import { memory, NOW, observation, rig, seedMemory, vec, type Rig } from "./move-fixtures.js";
import { liveIds, pin, sealedSession } from "./plan-fixtures.js";
import { auditEntries, done, goldenCase, indexHarness, indexSizes, sweep, uncapped, userData, vaultKeys, writeCases } from "./sweep-fixtures.js";

const QUOKKA = (id: string, session: string) => observation(id, session, { title: "quokka migration plan", narrative: `quokka ${id} narrative` });

async function dryRunWorld(): Promise<Rig> {
  const r = rig();
  const rows = Array.from({ length: 25 }, (_, i) => observation(`a${i}`, "ses_a", i === 0 ? { importance: 9 } : i === 1 ? { source: { hookType: "post_tool_use", originalBytes: 90, truncated: false, toolOutput: "<agentmemory-context>recalled</agentmemory-context>" } } : {}));
  await sealedSession(r, "ses_a", 0, { rows });
  await sealedSession(r, "ses_none", 3, { summary: "none" });
  await sealedSession(r, "ses_active", 3, { status: "active" });
  await sealedSession(r, "ses_b", 2, { project: "other" });
  for (const [n, row] of rows.slice(0, 6).entries()) r.runtime.vector.add(row.id, "ses_a", vec(n));
  await pin(r, { kind: "observation", sessionId: "ses_a", id: "a2" });
  await seedMemory(r, memory("m_expired"));
  await seedMemory(r, memory("m_old", { isLatest: false, forgetAfter: undefined, updatedAt: "2026-01-01T00:00:00.000Z" }));
  await seedMemory(r, memory("m_next", { version: 2, supersedes: ["m_old"], parentId: "m_old", forgetAfter: undefined }));
  await seedMemory(r, memory("m_cold", { forgetAfter: undefined }));
  await r.kv.set(KV.retentionScores, "m_cold", { memoryId: "m_cold", score: 0.05 });
  return r;
}

describe("R1: a dry run changes nothing and reports the plan", () => {
  it("leaves every user collection and both index sizes as they were", async () => {
    const r = await dryRunWorld();
    const harness = indexHarness(r);
    const before = { data: userData(r), sizes: indexSizes(r) };
    const result = done(await sweep(r, harness, { dryRun: true }));
    expect(result.outcome).toBe("dry-run");
    expect(userData(r)).toEqual(before.data);
    expect(indexSizes(r)).toEqual(before.sizes);
    expect(before.sizes.keyword).toBeGreaterThan(0);
    expect(before.sizes.vector).toBeGreaterThan(0);
    expect(harness.saves()).toBe(0);
  });

  it("reports counts and bytes per stage and per project", async () => {
    const r = await dryRunWorld();
    const { report } = done(await sweep(r, indexHarness(r), { dryRun: true }));
    expect(report.dryRun).toBe(true);
    expect(report.perStage.O.count).toBe(27);
    expect(report.perStage.O.bytes).toBeGreaterThan(0);
    expect(report.perStage.X.count).toBe(1);
    expect(report.perStage.S.count).toBe(1);
    expect(report.perStage.C.count).toBe(1);
    expect(report.perStage.T.count).toBe(0);
    expect(report.perProject["proj"]?.O.count).toBe(25);
    expect(report.perProject["other"]?.O.count).toBe(2);
    expect(Object.values(report.perStage).every((stage) => stage.moved === 0)).toBe(true);
  });

  it("holds at most 20 samples per stage, each with a reason", async () => {
    const r = await dryRunWorld();
    const { report } = done(await sweep(r, indexHarness(r), { dryRun: true }));
    expect(report.samples.O).toHaveLength(20);
    expect(report.samples.X).toHaveLength(1);
    for (const sample of Object.values(report.samples).flat()) expect(sample.reason).toMatch(/active days|forgetAfter/);
    expect(report.samples.X[0]!.id).toBe("m_expired");
  });

  it("lists protection hits per signal and the items each one held back", async () => {
    const r = await dryRunWorld();
    const { report } = done(await sweep(r, indexHarness(r), { dryRun: true }));
    expect(report.protectionHits.pin).toBe(1);
    expect(report.protectionHits.importance).toBe(1);
    expect(report.protectionHits["cited-by-memory"]).toBe(0);
    expect(report.protectedSamples.pin).toEqual(["ses_a/a2"]);
    expect(report.protectedSamples.importance).toEqual(["ses_a/a0"]);
  });

  it("reports the undigested backlog by reason", async () => {
    const r = await dryRunWorld();
    const { report } = done(await sweep(r, indexHarness(r), { dryRun: true }));
    expect(report.undigested["no-summary"]).toBe(1);
    expect(report.undigested.active).toBe(1);
    expect(report.undigested["summary-out-of-date"]).toBe(0);
    expect(report.sealed).toBe(2);
  });

  it("counts planned observations that carry an injected-context block, out of those it could read", async () => {
    const r = await dryRunWorld();
    const { report } = done(await sweep(r, indexHarness(r), { dryRun: true }));
    expect(report.injectedContext).toBe(1);
    expect(report.injectedContextScanned).toBe(27);
  });

  it("is stored with the run, and the run row ends done with the dry-run outcome", async () => {
    const r = await dryRunWorld();
    const result = done(await sweep(r, indexHarness(r), { dryRun: true }));
    const row = (await r.runs.get(result.runId))!;
    expect(row).toMatchObject({ phase: "done", outcome: "dry-run", dryRun: true });
    expect(await r.kv.get(RETENTION_KV.reports, result.runId)).toMatchObject({ runId: result.runId, outcome: "dry-run" });
  });

  it("does not need a recall harness: no golden case is read for a dry run", async () => {
    const r = await dryRunWorld();
    const throwing: RecallHarness = { cases: async () => { throw new Error("read"); }, settle: async () => { throw new Error("settle"); }, score: async () => { throw new Error("score"); } };
    expect(done(await sweep(r, throwing, { dryRun: true })).outcome).toBe("dry-run");
  });
});

describe("an enforcing run", () => {
  async function world(): Promise<{ r: Rig; cases: string }> {
    const r = rig();
    await sealedSession(r, "ses_q", 0, { rows: [QUOKKA("q1", "ses_q"), observation("q2", "ses_q")] });
    await sealedSession(r, "ses_keep", 0, { rows: [QUOKKA("k1", "ses_keep")] });
    await pin(r, { kind: "observation", sessionId: "ses_keep", id: "k1" });
    await seedMemory(r, memory("m_expired"));
    await seedMemory(r, memory("m_cold", { forgetAfter: undefined }));
    await r.kv.set(KV.retentionScores, "m_cold", { memoryId: "m_cold", score: 0.05 });
    await uncapped(r);
    return { r, cases: writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] }) };
  }

  it("is refused and reports only when there are no golden cases", async () => {
    const { r } = await world();
    const none = writeCases({ cases: [goldenCase("soft", "quokka", ["q1"], false)] });
    const result = done(await sweep(r, indexHarness(r, none), { dryRun: false }));
    expect(result.outcome).toBe("refused");
    expect(result.report.why).toMatch(/golden/);
    expect(result.report.perStage.O.count).toBe(3);
    expect(await liveIds(r, "ses_q")).toEqual(["q1", "q2"]);
    expect(await r.kv.get(KV.memories, "m_expired")).not.toBeNull();
    expect(await r.runs.get(result.runId)).toMatchObject({ phase: "done", outcome: "refused", held: 0 });
  });

  it("is refused when the recall cases file cannot be read, never run unmeasured", async () => {
    const { r } = await world();
    const result = done(await sweep(r, indexHarness(r, "/nonexistent/cases.json"), { dryRun: false }));
    expect(result.outcome).toBe("refused");
    expect(result.report.why).toMatch(/recall cases/);
    expect(await liveIds(r, "ses_q")).toEqual(["q1", "q2"]);
  });

  it("moves what is cleared, keeps what recall still finds, and flushes the index once at settle", async () => {
    const { r, cases } = await world();
    const harness = indexHarness(r, cases);
    const result = done(await sweep(r, harness, { dryRun: false }));
    expect(result.outcome).toBe("kept");
    expect(await liveIds(r, "ses_q")).toEqual([]);
    expect(await liveIds(r, "ses_keep")).toEqual(["k1"]);
    expect(await r.kv.get(KV.memories, "m_expired")).toBeNull();
    expect(result.report.perStage.O.moved).toBe(2);
    expect(result.report.perStage.X.moved).toBe(1);
    expect(result.report.recall).toMatchObject({ verdict: "keep" });
    expect(harness.saves()).toBe(1);
    const row = (await r.runs.get(result.runId))!;
    expect(row.held).toBe(3);
    expect((await vaultKeys(r, result.runId)).length).toBe(3);
    expect(row.cursor).not.toBeNull();
  });

  it("leaves stage C alone and counts it in the report", async () => {
    const { r, cases } = await world();
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(result.report.perStage.C).toMatchObject({ count: 1, moved: 0 });
    expect(result.report.demoteSkipped).toBe(1);
    expect(await r.kv.get(KV.memories, "m_cold")).not.toBeNull();
  });

  it("increments RunRow.held itself and keeps it equal to the entries the run holds", async () => {
    const { r, cases } = await world();
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect((await r.vault.runsHolding()).map((run) => run.id)).toEqual([result.runId]);
  });
});

describe("R9: a run that hurts recall undoes itself", () => {
  async function world() {
    const r = rig();
    await sealedSession(r, "ses_q", 0, { rows: [QUOKKA("q1", "ses_q"), observation("q2", "ses_q"), observation("q3", "ses_q")] });
    await seedMemory(r, memory("m_expired", { title: "okapi memory", content: "okapi" }));
    await uncapped(r);
    await r.kv.set(KV.sessions, "ses_q", { ...(await r.kv.get<object>(KV.sessions, "ses_q")), observationCount: 3 });
    return { r, cases: writeCases({ cases: [goldenCase("quokka-plan", "quokka", ["q1"])] }) };
  }

  it("restores every item when a golden case loses its evidence", async () => {
    const { r, cases } = await world();
    const harness = indexHarness(r, cases);
    const sizes = indexSizes(r);
    const data = userData(r);
    const result = done(await sweep(r, harness, { dryRun: false }));
    expect(result.outcome).toBe("restored");
    expect(await liveIds(r, "ses_q")).toEqual(["q1", "q2", "q3"]);
    expect(await r.kv.get(KV.memories, "m_expired")).not.toBeNull();
    expect(userData(r)).toEqual(data);
    expect(indexSizes(r)).toEqual(sizes);
    expect(await r.runtime.keyword.search("quokka", 10)).not.toEqual([]);
    expect(await vaultKeys(r, result.runId)).toEqual([]);
    expect(harness.saves()).toBe(2);
  });

  it("records the restore and its reason in the report, the run row and the audit log", async () => {
    const { r, cases } = await world();
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    const why = result.report.why!;
    expect(why).toMatch(/quokka-plan/);
    expect(result.report.recall).toMatchObject({ verdict: "restore" });
    expect(result.report.restored).toMatchObject({ why, restored: 4 });
    expect(await r.runs.get(result.runId)).toMatchObject({ outcome: "restored", restoredBecause: why, held: 0 });
    const restores = auditEntries(r).filter((entry) => entry.operation === "retention_restore");
    expect(restores).toHaveLength(1);
    expect(restores[0]!.details).toMatchObject({ runId: result.runId, why, restored: 4 });
    const stages = auditEntries(r).filter((entry) => entry.operation === "retention_soft_delete" && entry.details["stage"] === "O");
    expect(stages[0]!.details).toMatchObject({ runId: result.runId, restored: true, reason: why, moved: 3 });
  });

  it("restores when the after-check itself fails, since an unmeasured delete is not kept", async () => {
    const { r, cases } = await world();
    const real = indexHarness(r, cases);
    let scored = 0;
    const flaky: RecallHarness = { ...real, score: async (c) => { if (++scored === 2) throw new Error("search is down"); return real.score(c); } };
    const result = done(await sweep(r, flaky, { dryRun: false }));
    expect(result.outcome).toBe("restored");
    expect(result.report.why).toMatch(/search is down/);
    expect(await liveIds(r, "ses_q")).toEqual(["q1", "q2", "q3"]);
  });
});

describe("R13, sweep half: one audit entry per run and stage", () => {
  it("writes a seal entry and one entry for each of the five stages, with counts, run id and reason", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 0, { rows: [QUOKKA("q1", "ses_q"), observation("q2", "ses_q")] });
    await sealedSession(r, "ses_keep", 0, { rows: [QUOKKA("k1", "ses_keep")] });
    await pin(r, { kind: "observation", sessionId: "ses_keep", id: "k1" });
    await uncapped(r);
    const cases = writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] });
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    const entries = auditEntries(r).filter((entry) => entry.targetIds.includes(result.runId));
    expect(entries.filter((entry) => entry.operation === "retention_seal")).toHaveLength(1);
    const stages = entries.filter((entry) => entry.operation === "retention_soft_delete" || entry.operation === "retention_demote");
    expect(stages.map((entry) => entry.details["stage"]).sort()).toEqual(["C", "O", "S", "T", "X"]);
    expect(entries.filter((entry) => entry.operation === "retention_demote").map((entry) => entry.details["stage"])).toEqual(["C"]);
    const o = stages.find((entry) => entry.details["stage"] === "O")!;
    expect(o.details).toMatchObject({ runId: result.runId, dryRun: false, planned: 3, moved: 2, protectedHits: 1, reason: expect.any(String) });
    expect(o.functionId).toBe("mem::retention-sweep");
  });

  it("audits a dry run too, marked as one, with nothing moved", async () => {
    const r = await dryRunWorld();
    const result = done(await sweep(r, indexHarness(r), { dryRun: true }));
    const stages = auditEntries(r).filter((entry) => entry.targetIds.includes(result.runId) && entry.operation === "retention_soft_delete");
    expect(stages).toHaveLength(4);
    for (const entry of stages) expect(entry.details).toMatchObject({ dryRun: true, moved: 0, reason: expect.stringMatching(/dry run/) });
  });
});

describe("the first enforcing run is capped at 10% of observations", () => {
  async function world() {
    const r = rig();
    const okapi = observation("ses_1_o0", "ses_1", { title: "okapi grazing", narrative: "okapi" });
    await sealedSession(r, "ses_1", 0, { rows: [okapi, ...Array.from({ length: 9 }, (_, i) => observation(`ses_1_o${i + 1}`, "ses_1"))] });
    await sealedSession(r, "ses_2", 10);
    await sealedSession(r, "ses_keep", 0, { rows: [QUOKKA("k1", "ses_keep")] });
    await pin(r, { kind: "observation", sessionId: "ses_keep", id: "k1" });
    return { r, cases: writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] }) };
  }
  const total = async (r: Rig) => (await liveIds(r, "ses_1")).length + (await liveIds(r, "ses_2")).length;

  it("moves at most 10% of the stack's observations, then lifts the cap once a run is kept", async () => {
    const { r, cases } = await world();
    const first = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(first.outcome).toBe("kept");
    expect(first.report.observationCap).toBe(2);
    expect(first.report.perStage.O.moved).toBe(2);
    expect(await total(r)).toBe(18);
    const second = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(second.report.observationCap).toBeNull();
    expect(await total(r)).toBe(0);
  });

  it("keeps the cap for the next run when the first was restored", async () => {
    const { r } = await world();
    const bad = writeCases({ cases: [goldenCase("quokka", "quokka", ["k1"]), goldenCase("lost", "okapi", ["ses_1_o0"])] });
    const lost = indexHarness(r, bad);
    const first = done(await sweep(r, lost, { dryRun: false }));
    expect(first.outcome).toBe("restored");
    const ok = writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] });
    const second = done(await sweep(r, indexHarness(r, ok), { dryRun: false }));
    expect(second.report.observationCap).toBe(2);
  });
});

describe("R12, resume half", () => {
  const SESSIONS = ["ses_a", "ses_b", "ses_c"];

  async function stack(r: Rig) {
    for (const id of SESSIONS) await sealedSession(r, id, 4);
    await sealedSession(r, "ses_keep", 0, { rows: [QUOKKA("k1", "ses_keep")] });
    await pin(r, { kind: "observation", sessionId: "ses_keep", id: "k1" });
    await seedMemory(r, memory("m_expired"));
    await uncapped(r);
    return writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] });
  }

  const items = SESSIONS.flatMap((session) => [0, 1, 2, 3].map((i) => ({ session, id: `${session}_o${i}` })));

  async function vaultHolds(r: Rig, runId: RunId, key: string): Promise<boolean> {
    return (await r.kv.get(RETENTION_KV.vault(runId), key)) !== null;
  }

  async function neverNeither(r: Rig, runId: RunId): Promise<void> {
    for (const { session, id } of items) {
      const live = (await r.kv.get(KV.observations(session), id)) !== null;
      const held = await vaultHolds(r, runId, itemKey({ kind: "observation", sessionId: session, id }));
      expect(live || held, `${id} is in neither place`).toBe(true);
    }
    const memoryLive = (await r.kv.get(KV.memories, "m_expired")) !== null;
    expect(memoryLive || (await vaultHolds(r, runId, itemKey({ kind: "memory", id: "m_expired" }))), "m_expired is in neither place").toBe(true);
  }

  async function neverBoth(r: Rig, runId: RunId): Promise<void> {
    for (const { session, id } of items) {
      const live = (await r.kv.get(KV.observations(session), id)) !== null;
      const held = await vaultHolds(r, runId, itemKey({ kind: "observation", sessionId: session, id }));
      expect(live && held, `${id} is live and in the vault`).toBe(false);
    }
    const memoryLive = (await r.kv.get(KV.memories, "m_expired")) !== null;
    expect(memoryLive && (await vaultHolds(r, runId, itemKey({ kind: "memory", id: "m_expired" }))), "m_expired is live and in the vault").toBe(false);
  }

  it("resumes a sweep killed at any write from its progress record, and no item is both live and in the vault", async () => {
    const { crashingAt, crashed } = await import("./crash.js");
    let resumed = 0;
    for (let n = 1; ; n += 4) {
      const r = rig();
      const cases = await stack(r);
      const clock = { now: NOW };
      const live = { ...r.deps, now: () => clock.now };
      if (!(await crashed(() => sweep(r, indexHarness(r, cases), { dryRun: false }, crashingAt(live, n).deps)))) break;
      const [open] = await r.runs.unfinished();
      if (!open) continue;
      resumed++;
      await neverNeither(r, open.id);
      clock.now = new Date(NOW.getTime() + LEASE_STALE_MS + 60_000);
      const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }, live));
      expect(result.runId).toBe(open.id);
      expect(result.outcome).toBe("kept");
      expect(result.report.resumed).toBe(true);
      await neverBoth(r, open.id);
      for (const session of SESSIONS) expect(await liveIds(r, session)).toEqual([]);
      expect(await liveIds(r, "ses_keep")).toEqual(["k1"]);
      const row = (await r.runs.get(open.id))!;
      expect(row.held).toBe((await vaultKeys(r, open.id)).length);
      expect(row).toMatchObject({ held: 13, counters: { O: { moved: 12 }, X: { moved: 1 } } });
      expect(await r.runs.unfinished()).toEqual([]);
    }
    expect(resumed).toBeGreaterThan(20);
  }, 120_000);

  it("keeps the cursor of the last applied batch, so a resumed run continues from it", async () => {
    const { crashingAt, crashed } = await import("./crash.js");
    for (let n = 20; ; n += 3) {
      const r = rig();
      const cases = await stack(r);
      expect(await crashed(() => sweep(r, indexHarness(r, cases), { dryRun: false }, crashingAt(r.deps, n).deps))).toBe(true);
      const [open] = await r.runs.unfinished();
      if (open?.phase !== "apply" || !open.cursor?.after) continue;
      expect(open.cursor).toMatchObject({ unit: "sessions", after: expect.stringMatching(/^ses_/) });
      const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }, { ...r.deps, now: () => new Date(NOW.getTime() + LEASE_STALE_MS + 60_000) }));
      expect(result.outcome).toBe("kept");
      return;
    }
  }, 120_000);
});


describe("the lease", () => {
  it("answers busy while another sweep holds a fresh lease, and moves nothing", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 2);
    await r.kv.set(RETENTION_KV.control, "lease", { owner: "other", heartbeatAt: NOW.toISOString() });
    const result = await sweep(r, indexHarness(r), { dryRun: false });
    expect(result).toEqual({ kind: "busy", heldBy: "other" });
    expect(await liveIds(r, "ses_q")).toHaveLength(2);
  });

  it("takes over a stale lease and releases its own when it finishes", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 2);
    await r.kv.set(RETENTION_KV.control, "lease", { owner: "dead", heartbeatAt: new Date(NOW.getTime() - LEASE_STALE_MS - 1).toISOString() });
    expect(done(await sweep(r, indexHarness(r), { dryRun: true })).outcome).toBe("dry-run");
    expect(await r.kv.get(RETENTION_KV.control, "lease")).toBeNull();
  });

  it("releases its lease when it throws, leaving the run open for the next sweep to resume", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 2);
    await uncapped(r);
    const cases = writeCases({ cases: [goldenCase("c", "title", ["ses_q_o0"], true)] });
    const real = indexHarness(r, cases);
    const broken: RecallHarness = { ...real, settle: async () => { throw new Error("settle failed"); } };
    await expect(sweep(r, broken, { dryRun: false })).rejects.toThrow("settle failed");
    expect(await r.kv.get(RETENTION_KV.control, "lease")).toBeNull();
    const [open] = await r.runs.unfinished();
    expect(open).toMatchObject({ phase: "settle", dryRun: false });
  });

  it("stops when the heartbeat finds the lease lost, before it moves anything", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 3);
    await uncapped(r);
    const cases = writeCases({ cases: [goldenCase("c", "title", ["ses_q_o0"], true)] });
    const real = indexHarness(r, cases);
    const stealing: RecallHarness = {
      ...real,
      score: async (c) => {
        await r.kv.set(RETENTION_KV.control, "lease", { owner: "usurper", heartbeatAt: NOW.toISOString() });
        return real.score(c);
      },
    };
    expect(await sweep(r, stealing, { dryRun: false })).toEqual({ kind: "lease-lost" });
    expect(await liveIds(r, "ses_q")).toHaveLength(3);
    expect(await r.kv.get(RETENTION_KV.control, "lease")).toMatchObject({ owner: "usurper" });
  });
});

describe("recovery on resume", () => {
  it("clears the sweep scratch a crashed run left behind", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 2);
    await uncapped(r);
    const cases = writeCases({ cases: [goldenCase("c", "title", ["ses_q_o0"], true)] });
    const real = indexHarness(r, cases);
    const broken: RecallHarness = { ...real, settle: async () => { throw new Error("killed"); } };
    await expect(sweep(r, broken, { dryRun: false })).rejects.toThrow("killed");
    await r.kv.set(RETENTION_KV.sweepScratch, "left_over", 1);
    done(await sweep(r, real, { dryRun: false }));
    expect(await r.kv.listKeys(RETENTION_KV.sweepScratch)).toEqual([]);
  });

  it("closes an unfinished dry run instead of resuming it", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 2);
    await uncapped(r);
    const stuck = { id: "ret_stuck" as RunId, dryRun: true, phase: "plan", outcome: "running", startedAt: NOW.toISOString() } as unknown as RunRow;
    await r.runs.save(stuck);
    const first = done(await sweep(r, indexHarness(r), { dryRun: true }));
    expect(first.runId).not.toBe("ret_stuck");
    const second = done(await sweep(r, indexHarness(r, writeCases([goldenCase("c", "title", ["ses_q_o0"])])), { dryRun: false }));
    expect(second.runId).not.toBe("ret_stuck");
    expect(await r.runs.get("ret_stuck" as RunId)).toMatchObject({ phase: "done", outcome: "dry-run" });
  });
});

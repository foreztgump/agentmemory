import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { logger } from "../../../src/logger.js";
import { restoreLeased } from "../../../src/fork/retention/admin.js";
import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { RecallHarness } from "../../../src/fork/retention/recall-check.js";
import { LEASE_STALE_MS } from "../../../src/fork/retention/run-store.js";
import type { RunId, RunRow } from "../../../src/fork/retention/types.js";
import type { RetentionDeps } from "../../../src/fork/retention/satellites.js";
import type { StateKV } from "../../../src/state/kv.js";
import { setEmbeddingProvider } from "../../../src/functions/search.js";
import { KV } from "../../../src/state/schema.js";
import type { EmbeddingProvider, Memory } from "../../../src/types.js";
import { DIMS, memory, NOW, observation, RECENT, rig, seedMemory, vec, type Rig } from "./move-fixtures.js";
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
  await seedMemory(r, memory("m_next", { ...RECENT, version: 2, supersedes: ["m_old"], parentId: "m_old", forgetAfter: undefined }));
  await seedMemory(r, memory("m_cold", { forgetAfter: undefined }));
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

  it("is refused when a case repeats an evidence id, which would inflate its recall", async () => {
    const { r } = await world();
    const repeated = writeCases({ cases: [goldenCase("pinned", "quokka", ["k1", "k1"])] });
    const result = done(await sweep(r, indexHarness(r, repeated), { dryRun: false }));
    expect(result.outcome).toBe("refused");
    expect(result.report.why).toMatch(/evidence id "k1" is repeated/);
    expect(await liveIds(r, "ses_q")).toEqual(["q1", "q2"]);
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

  it("demotes the cold memory through displace and counts it in stage C", async () => {
    const { r, cases } = await world();
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(result.report.perStage.C).toMatchObject({ count: 1, moved: 1 });
    expect(result.report).not.toHaveProperty("demoteSkipped");
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "m_cold"))).toBe(true);
  });

  it("increments RunRow.held itself and keeps it equal to the entries the run holds", async () => {
    const { r, cases } = await world();
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect((await r.vault.runsHolding()).map((run) => run.id)).toEqual([result.runId]);
  });
});

describe("stage C: an enforcing run demotes a cold memory in place", () => {
  const GLACIER = (over: Partial<Memory> = {}) => memory("m_cold", { forgetAfter: undefined, title: "glacier memory", content: "glacier retreat notes", ...over });

  async function world(): Promise<{ r: Rig; protectedCases: string }> {
    const r = rig();
    await sealedSession(r, "ses_q", 0, { rows: [QUOKKA("q1", "ses_q"), observation("q2", "ses_q")] });
    await sealedSession(r, "ses_keep", 0, { rows: [QUOKKA("k1", "ses_keep")] });
    await pin(r, { kind: "observation", sessionId: "ses_keep", id: "k1" });
    await seedMemory(r, memory("m_expired"));
    await seedMemory(r, GLACIER(), { seed: 7 });
    return { r, protectedCases: writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] }) };
  }

  it("marks it, takes it out of both indexes, counts it as moved and leaves held to the vault", async () => {
    const { r, protectedCases } = await world();
    await uncapped(r);
    expect(await r.runtime.keyword.search("glacier", 10)).not.toEqual([]);
    expect(r.runtime.vector.readVectors(["m_cold"]).size).toBe(1);
    const result = done(await sweep(r, indexHarness(r, protectedCases), { dryRun: false }));
    expect(result.outcome).toBe("kept");
    const row = await r.kv.get<Memory>(KV.memories, "m_cold");
    expect(hiddenFromIndex(row)).toBe(true);
    expect(row).toMatchObject({ id: "m_cold", retention: { runId: result.runId, memoryId: "m_cold" } });
    expect(await r.runtime.keyword.search("glacier", 10)).toEqual([]);
    expect(r.runtime.vector.readVectors(["m_cold"]).size).toBe(0);
    expect(await r.kv.get(RETENTION_KV.demoted, "m_cold")).toMatchObject({ runId: result.runId, memoryId: "m_cold" });
    expect(result.report.perStage.C).toMatchObject({ count: 1, moved: 1 });
    const run = (await r.runs.get(result.runId))!;
    expect(run.counters.C.moved).toBe(1);
    expect(run.counters.C.bytes).toBeGreaterThan(0);
    expect(run.held).toBe(3);
    expect((await vaultKeys(r, result.runId)).length).toBe(3);
    expect(await vaultKeys(r, result.runId)).not.toContain(itemKey({ kind: "memory", id: "m_cold" }));
  });

  it("audits stage C as retention_demote with the real counts", async () => {
    const { r, protectedCases } = await world();
    await uncapped(r);
    const result = done(await sweep(r, indexHarness(r, protectedCases), { dryRun: false }));
    const demotes = auditEntries(r).filter((entry) => entry.targetIds.includes(result.runId) && entry.operation === "retention_demote");
    expect(demotes).toHaveLength(1);
    expect(demotes[0]!.details).toMatchObject({ stage: "C", runId: result.runId, dryRun: false, planned: 1, moved: 1, protectedHits: 0, restored: false });
    expect(demotes[0]!.details["bytes"]).toBe((await r.runs.get(result.runId))!.counters.C.bytes);
    expect(demotes[0]!.details["bytes"]).toBeGreaterThan(0);
  });

  it("is not held back by the first run's cap on observations", async () => {
    const { r, protectedCases } = await world();
    const result = done(await sweep(r, indexHarness(r, protectedCases), { dryRun: false }));
    expect(result.report.observationCap).toBe(0);
    expect(result.report.perStage.O.moved).toBe(0);
    expect(result.report.perStage.C.moved).toBe(1);
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "m_cold"))).toBe(true);
  });

  it("leaves a protected cold memory live", async () => {
    const { r, protectedCases } = await world();
    await uncapped(r);
    await seedMemory(r, GLACIER({ id: "m_saved", origin: { channel: "user" } as Memory["origin"] }), { seed: 9 });
    const result = done(await sweep(r, indexHarness(r, protectedCases), { dryRun: false }));
    expect(result.report.perStage.C).toMatchObject({ count: 2, moved: 1 });
    expect((await r.runs.get(result.runId))!.counters.C).toMatchObject({ planned: 2, moved: 1, protectedHits: 1 });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "m_saved"))).toBe(false);
  });

  it("un-demotes it from its stored vector when a golden case loses its evidence, with no embedding call", async () => {
    const { r } = await world();
    await uncapped(r);
    const provider = { name: "spy", dimensions: DIMS, embed: vi.fn(async () => new Float32Array(DIMS)), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DIMS))) };
    setEmbeddingProvider(provider as unknown as EmbeddingProvider);
    const data = userData(r);
    const sizes = indexSizes(r);
    const cases = writeCases({ cases: [goldenCase("glacier", "glacier", ["m_cold"]), goldenCase("pinned", "quokka", ["k1"])] });
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    setEmbeddingProvider(null);
    expect(result.outcome).toBe("restored");
    expect(result.report.why).toMatch(/glacier/);
    const row = await r.kv.get<Memory>(KV.memories, "m_cold");
    expect(hiddenFromIndex(row)).toBe(false);
    expect(row).not.toHaveProperty("retention");
    expect((await r.runtime.keyword.search("glacier", 10)).map((hit) => hit.obsId)).toEqual(["m_cold"]);
    expect(r.runtime.vector.readVectors(["m_cold"]).get("m_cold")).toEqual(vec(7));
    expect(await r.kv.listKeys(RETENTION_KV.demoted)).toEqual([]);
    expect(userData(r)).toEqual(data);
    expect(indexSizes(r)).toEqual(sizes);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(await r.runs.get(result.runId)).toMatchObject({ outcome: "restored", held: 0 });
  });

  it("changes nothing in a dry run, whatever is cold", async () => {
    const { r } = await world();
    const before = { data: userData(r), sizes: indexSizes(r) };
    const result = done(await sweep(r, indexHarness(r), { dryRun: true }));
    expect(result.report.perStage.C).toMatchObject({ count: 1, moved: 0 });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "m_cold"))).toBe(false);
    expect(await r.kv.listKeys(RETENTION_KV.demoted)).toEqual([]);
    expect(userData(r)).toEqual(before.data);
    expect(indexSizes(r)).toEqual(before.sizes);
    expect(r.runtime.vector.readVectors(["m_cold"]).size).toBe(1);
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

  /** Run E on staging: the after-check lost recall, then the in-sweep restore died at its start. */
  async function failedInSweepRestore() {
    const { r, cases } = await world();
    let armed = false;
    let failed = false;
    r.h.hooks.beforeTrigger = (req) => {
      const p = req.payload as { scope?: string; value?: { restoredBecause?: string } };
      if (req.function_id === "state::set" && p.scope === RETENTION_KV.runs && p.value?.restoredBecause) armed = true;
      if (armed && !failed && req.function_id === "state::list_keys" && p.scope?.startsWith("mem:retention:vault:")) {
        failed = true;
        throw new Error("engine connection reset");
      }
    };
    await expect(sweep(r, indexHarness(r, cases), { dryRun: false })).rejects.toThrow("engine connection reset");
    const [open] = await r.runs.unfinished();
    expect(open).toMatchObject({ phase: "check-after", restoredBecause: expect.stringMatching(/quokka-plan/) });
    return { r, open: open!, why: open!.restoredBecause! };
  }

  it("logs the error that ends an in-sweep restore, with its message", async () => {
    const { open, why } = await failedInSweepRestore();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "retention: the in-sweep restore failed",
      expect.objectContaining({ runId: open.id, why, error: "engine connection reset" }),
    );
  });

  it("a later restore of a run whose in-sweep restore died keeps the recall loss as its reason", async () => {
    const { r, open, why } = await failedInSweepRestore();
    expect(await restoreLeased(r.deps, { runId: open.id })).toMatchObject({ kind: "done", restored: 4 });
    expect(await r.runs.get(open.id)).toMatchObject({ phase: "done", outcome: "restored", restoredBecause: why, held: 0 });
    expect(await r.kv.get(RETENTION_KV.reports, open.id)).toMatchObject({ outcome: "restored", why, restored: { why, restored: 4 } });
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
    await seedMemory(r, memory("m_cold", { forgetAfter: undefined, title: "glacier memory", content: "glacier retreat notes" }), { seed: 7 });
    await uncapped(r);
    return writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] });
  }

  /** A demote is whole or not there: marked, recorded and out of both indexes, or unmarked, unrecorded and in both. */
  async function demoteIsWhole(r: Rig, runId: RunId): Promise<"demoted" | "live"> {
    const marked = hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "m_cold"));
    const recorded = (await r.kv.get(RETENTION_KV.demoted, "m_cold")) !== null;
    const inKeyword = (await r.runtime.keyword.search("glacier", 10)).length > 0;
    const inVector = r.runtime.vector.readVectors(["m_cold"]).size > 0;
    expect(await r.kv.get(RETENTION_KV.demoted, "m_cold")).toSatisfy((record: { runId?: string } | null) => record === null || record.runId === runId);
    if (marked) {
      expect({ recorded, inKeyword, inVector }, "a marked memory is half-demoted").toEqual({ recorded: true, inKeyword: false, inVector: false });
      return "demoted";
    }
    expect({ recorded, inKeyword, inVector }, "an unmarked memory is half-demoted").toEqual({ recorded: false, inKeyword: true, inVector: true });
    return "live";
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
      expect(row).toMatchObject({ held: 13, counters: { O: { moved: 12 }, X: { moved: 1 }, C: { moved: 1 } } });
      expect(await demoteIsWhole(r, open.id)).toBe("demoted");
      expect(result.report.perStage.C.moved).toBe(1);
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

interface KvOp {
  readonly op: "get" | "listKeys" | "iterate";
  readonly scope: string;
  readonly key?: string;
}

/** The rig's deps, except that the first state-store read `when` matches first hands the sweep lease to another process. */
function stealingDeps(r: Rig, when: (op: KvOp) => boolean): RetentionDeps {
  let stolen = false;
  const steal = async (op: KvOp): Promise<void> => {
    if (stolen || !when(op)) return;
    stolen = true;
    await r.kv.set(RETENTION_KV.control, "lease", { owner: "usurper", heartbeatAt: NOW.toISOString() });
  };
  const kv = Object.create(r.kv) as StateKV;
  kv.get = (async (scope: string, key: string) => {
    const row = await r.kv.get(scope, key);
    await steal({ op: "get", scope, key });
    return row;
  }) as StateKV["get"];
  kv.listKeys = async (scope: string) => {
    await steal({ op: "listKeys", scope });
    return r.kv.listKeys(scope);
  };
  kv.iterate = async function* (scope: string, opts?: { pageSize?: number }) {
    await steal({ op: "iterate", scope });
    yield* r.kv.iterate(scope, opts);
  } as StateKV["iterate"];
  return { ...r.deps, kv };
}

describe("the lease, in the stretches between batches", () => {
  async function crashedAtSettle(): Promise<{ r: Rig; cases: string; open: RunRow }> {
    const r = rig();
    await sealedSession(r, "ses_q", 3);
    await uncapped(r);
    const cases = writeCases({ cases: [goldenCase("c", "title", ["ses_q_o0"], true)] });
    const real = indexHarness(r, cases);
    await expect(sweep(r, { ...real, settle: async () => { throw new Error("killed"); } }, { dryRun: false })).rejects.toThrow("killed");
    const [open] = await r.runs.unfinished();
    expect(await vaultKeys(r, open!.id)).toHaveLength(3);
    return { r, cases, open: open! };
  }

  it.each([
    ["the scratch scope is cleared", (op: KvOp) => op.op === "listKeys" && op.scope === RETENTION_KV.sweepScratch],
    ["the run's vault is first paged", (op: KvOp) => op.op === "iterate" && op.scope.startsWith("mem:retention:vault")],
  ])("recovery stops with lease-lost, and never saves the run row, once the lease is lost as %s", async (_name, when) => {
    const { r, cases, open } = await crashedAtSettle();
    const stored = await r.kv.get<RunRow>(RETENTION_KV.runs, open.id);
    const harness = indexHarness(r, cases);
    const settle = vi.spyOn(harness, "settle");
    expect(await sweep(r, harness, { dryRun: false }, stealingDeps(r, when))).toEqual({ kind: "lease-lost" });
    expect(await r.kv.get(RETENTION_KV.control, "lease")).toMatchObject({ owner: "usurper" });
    expect(await r.kv.get(RETENTION_KV.runs, open.id)).toEqual(stored);
    expect(settle).not.toHaveBeenCalled();
    expect(await vaultKeys(r, open.id)).toHaveLength(3);
  });

  it("the first run's cap scan stops with lease-lost, and the run row stays at check-before", async () => {
    const r = rig();
    await sealedSession(r, "ses_q", 3);
    const cases = writeCases({ cases: [goldenCase("c", "title", ["ses_q_o0"], true)] });
    const deps = stealingDeps(r, (op) => op.op === "get" && op.scope === RETENTION_KV.control && op.key === "enforced-runs");
    expect(await sweep(r, indexHarness(r, cases), { dryRun: false }, deps)).toEqual({ kind: "lease-lost" });
    expect(await r.kv.get(RETENTION_KV.control, "lease")).toMatchObject({ owner: "usurper" });
    expect(await liveIds(r, "ses_q")).toHaveLength(3);
    const [open] = await r.runs.unfinished();
    expect(open).toMatchObject({ phase: "check-before", observationCap: null, held: 0 });
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

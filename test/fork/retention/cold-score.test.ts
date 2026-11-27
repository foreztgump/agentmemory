import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { registerRetentionFunctions } from "../../../src/functions/retention.js";
import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { RETENTION_COLD_SCORE } from "../../../src/fork/retention/settings.js";
import { KV } from "../../../src/state/schema.js";
import type { Memory, RetentionScore } from "../../../src/types.js";
import { memory, NOW, observation, rig, seedMemory, type Rig } from "./move-fixtures.js";
import { candidatesOf, pin, planAll, sealedSession, ZERO } from "./plan-fixtures.js";
import { done, goldenCase, indexHarness, sweep, uncapped, writeCases } from "./sweep-fixtures.js";

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const coldIds = async (r: Rig) => candidatesOf(await planAll(r, ZERO)).filter((c) => c.stage === "C").map((c) => c.ref.id).sort();

afterEach(() => vi.useRealTimers());

describe("stage C scores each memory itself, so it needs no stored mem:retention score", () => {
  async function world(): Promise<{ r: Rig; cases: string }> {
    const r = rig();
    await sealedSession(r, "ses_keep", 0, { rows: [observation("k1", "ses_keep", { title: "quokka plan", narrative: "quokka k1" })] });
    await pin(r, { kind: "observation", sessionId: "ses_keep", id: "k1" });
    await seedMemory(r, memory("m_cold", { forgetAfter: undefined, title: "glacier memory", content: "glacier retreat notes" }), { seed: 7 });
    await uncapped(r);
    return { r, cases: writeCases({ cases: [goldenCase("pinned", "quokka", ["k1"])] }) };
  }

  it("an enforcing sweep demotes an old, never-scored memory with no manual score call", async () => {
    const { r, cases } = await world();
    expect(await r.kv.listKeys(KV.retentionScores)).toEqual([]);
    const result = done(await sweep(r, indexHarness(r, cases), { dryRun: false }));
    expect(result.outcome).toBe("kept");
    expect(result.report.perStage.C).toMatchObject({ count: 1, moved: 1 });
    expect(hiddenFromIndex(await r.kv.get<Memory>(KV.memories, "m_cold"))).toBe(true);
  });

  it("a dry run plans the same stage C as the enforcing run", async () => {
    const dry = await world();
    const wet = await world();
    const planned = done(await sweep(dry.r, indexHarness(dry.r, dry.cases), { dryRun: true })).report;
    const enforced = done(await sweep(wet.r, indexHarness(wet.r, wet.cases), { dryRun: false })).report;
    expect(planned.perStage.C.count).toBe(1);
    expect(planned.perStage.C.count).toBe(enforced.perStage.C.count);
    expect(planned.samples.C.map((s) => s.id)).toEqual(enforced.samples.C.map((s) => s.id));
    expect(await dry.r.kv.listKeys(KV.retentionScores)).toEqual([]);
  });

  it("ignores a stale stored score: a fresh memory stored as cold is warm, an old one stored as warm is cold", async () => {
    const r = rig();
    await seedMemory(r, memory("m_fresh", { forgetAfter: undefined, createdAt: daysAgo(1), updatedAt: daysAgo(1) }));
    await seedMemory(r, memory("m_old", { forgetAfter: undefined }));
    await r.kv.set(KV.retentionScores, "m_fresh", { memoryId: "m_fresh", score: 0.01 });
    await r.kv.set(KV.retentionScores, "m_old", { memoryId: "m_old", score: 0.9 });
    expect(await coldIds(r)).toEqual(["m_old"]);
  });

  it("calls a memory cold exactly when mem::retention-score would score it below the cold tier", async () => {
    const r = rig();
    const ages = [30, 60, 90, 100, 110, 120, 130, 150, 200, 400];
    const types: Memory["type"][] = ["fact", "bug", "workflow", "pattern"];
    for (const [i, age] of ages.entries()) {
      for (const type of types) {
        const id = `m_${type}_${age}`;
        await seedMemory(r, memory(id, { forgetAfter: undefined, type, createdAt: daysAgo(age), updatedAt: daysAgo(age) }));
        if (i % 3 === 0) await r.kv.set(KV.accessLog, id, { memoryId: id, count: i + 1, lastAt: daysAgo(age - 5), recent: [Date.parse(daysAgo(age - 5)), Date.parse(daysAgo(age - 20))] });
      }
    }
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    registerRetentionFunctions(r.h.sdk as never, r.kv);
    const scored = (await r.h.call("mem::retention-score", {})) as { scores: RetentionScore[] };
    vi.useRealTimers();
    const expected = scored.scores.filter((s) => s.score < RETENTION_COLD_SCORE).map((s) => s.memoryId).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(ages.length * types.length);
    for (const id of await r.kv.listKeys(KV.retentionScores)) await r.kv.delete(KV.retentionScores, id);
    expect(await coldIds(r)).toEqual(expected);
  });
});

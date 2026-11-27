import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRecallHarness, judgeRecall, loadRecallCases, scoreCases, type RecallScore } from "../../../src/fork/retention/recall-check.js";
import { writeCases } from "./sweep-fixtures.js";

const score = (recallAt10: number, golden: string[] = []): RecallScore => ({ recallAt10, goldenHit: new Set(golden) });

describe("judgeRecall", () => {
  it("keeps a run whose recall held or fell by no more than the stop threshold", () => {
    expect(judgeRecall(score(80, ["g"]), score(80, ["g"]), 2)).toEqual({ kind: "keep" });
    expect(judgeRecall(score(80, ["g"]), score(78, ["g"]), 2)).toEqual({ kind: "keep" });
    expect(judgeRecall(score(80), score(90), 2)).toEqual({ kind: "keep" });
  });

  it("restores when recall@10 falls by more than the stop threshold, saying by how much", () => {
    const verdict = judgeRecall(score(80, ["g"]), score(77.5, ["g"]), 2);
    expect(verdict).toMatchObject({ kind: "restore" });
    expect(verdict.kind === "restore" && verdict.why).toMatch(/recall@10.*2\.5/);
  });

  it("restores when any golden case loses its evidence, even if the average held, and names the case", () => {
    const verdict = judgeRecall(score(80, ["a", "b"]), score(85, ["a"]), 2);
    expect(verdict.kind === "restore" && verdict.why).toContain("b");
  });

  it("does not blame the run for a golden case that was already missing before", () => {
    expect(judgeRecall(score(80, ["a"]), score(80, ["a"]), 2)).toEqual({ kind: "keep" });
  });
});

describe("loadRecallCases", () => {
  it("reads { cases: [...] } and a bare array, a case being golden unless it says otherwise", async () => {
    const wrapped = await loadRecallCases(writeCases({ cases: [{ id: "a", query: "q", evidence: ["o1"] }] }));
    expect(wrapped).toEqual([{ id: "a", query: "q", evidence: ["o1"], golden: true }]);
    const bare = await loadRecallCases(writeCases([{ id: "b", query: "q", evidence: ["o1", "o2"], golden: false }]));
    expect(bare[0]).toMatchObject({ id: "b", golden: false, evidence: ["o1", "o2"] });
  });

  it("returns no cases when no path is configured", async () => {
    expect(await loadRecallCases(null)).toEqual([]);
  });

  it.each([
    ["a string, not a case list", "{"],
    ["no cases key", { other: [] }],
    ["a case without evidence", { cases: [{ id: "a", query: "q", evidence: [] }] }],
    ["a case without a query", { cases: [{ id: "a", query: " ", evidence: ["o"] }] }],
    ["a repeated id", { cases: [{ id: "a", query: "q", evidence: ["o"] }, { id: "a", query: "r", evidence: ["o"] }] }],
    ["a non-boolean golden", { cases: [{ id: "a", query: "q", evidence: ["o"], golden: "yes" }] }],
  ])("rejects %s, so a broken file never reads as a passing check", async (_name, body) => {
    await expect(loadRecallCases(writeCases(body))).rejects.toThrow(/recall cases/);
  });

  it("rejects text that is not JSON", async () => {
    const file = writeCases({});
    writeFileSync(file, "{ not json");
    await expect(loadRecallCases(file)).rejects.toThrow(/recall cases/);
  });

  it("rejects a missing file", async () => {
    await expect(loadRecallCases("/nonexistent/cases.json")).rejects.toThrow(/recall cases/);
  });
});

describe("scoreCases and the real harness", () => {
  const sdk = (answers: Record<string, string[]>) => ({
    trigger: async (req: { function_id: string; payload: { query: string; limit: number } }) => {
      expect(req.function_id).toBe("mem::smart-search");
      expect(req.payload.limit).toBe(10);
      return { mode: "compact", results: (answers[req.payload.query] ?? []).map((obsId) => ({ obsId })) };
    },
  });

  it("counts evidence found in the top 10 per case and marks golden cases that hit", async () => {
    const cases = [
      { id: "g1", query: "a", evidence: ["x", "y"], golden: true },
      { id: "g2", query: "b", evidence: ["z"], golden: true },
      { id: "n1", query: "c", evidence: ["w"], golden: false },
    ];
    const result = await scoreCases(sdk({ a: ["x"], b: [], c: ["w"] }) as never, cases);
    expect([...result.goldenHit]).toEqual(["g1"]);
    expect(result.recallAt10).toBeCloseTo(((0.5 + 0 + 1) / 3) * 100, 6);
  });

  it("ignores hits past rank 10", async () => {
    const ranks = Array.from({ length: 12 }, (_, i) => `o${i}`);
    const result = await scoreCases(sdk({ q: ranks }) as never, [{ id: "g", query: "q", evidence: ["o11"], golden: true }]);
    expect(result.goldenHit.size).toBe(0);
  });

  it("settles by saving the index once, which drains the disk outbox and flushes the memory index", async () => {
    let saves = 0;
    const search = () => ({ openPersistence: () => ({ save: async () => { saves++; } }) });
    const harness = createRecallHarness({ sdk: sdk({}) as never, search: search as never }, null);
    await harness.settle();
    expect(saves).toBe(1);
    expect(await harness.cases()).toEqual([]);
  });
});

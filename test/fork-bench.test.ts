import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregate, checkLimits, scoreCase } from "../bench/fork/lib/score.js";
import { sampleQuantile } from "../bench/fork/lib/stats.js";
import { indexObservationSession } from "../src/state/obs-index.js";
import type { StateKV } from "../src/state/kv.js";
import { Generator, obsIndexShard, plant, pseudoWord, resp, type Profile } from "../bench/fork/lib/synthetic.js";

const profile = JSON.parse(readFileSync(new URL("../bench/fork/profiles/buddy-2026-11-16.json", import.meta.url), "utf8")) as Profile;

describe("recall scoring", () => {
  const c = { id: "c", kind: "keyword", query: "q", expected: ["b", "z"] };

  it("ranks the first expected id in the top 10", () => {
    expect(scoreCase(c, ["a", "b", "z"])).toEqual({ id: "c", kind: "keyword", rank: 2, recall: 1, pass: true });
  });

  it("misses when the expected id is below the top 10", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `x${i}`).concat("b");
    expect(scoreCase(c, ids)).toMatchObject({ rank: null, recall: 0, pass: false });
  });

  it("aggregates recall@10, MRR and graph passes per kind", () => {
    const scores = aggregate([
      { id: "1", kind: "keyword", rank: 1, recall: 1, pass: true },
      { id: "2", kind: "keyword", rank: 4, recall: 1, pass: true },
      { id: "3", kind: "graph", rank: null, recall: 0, pass: false },
      { id: "4", kind: "graph", rank: 2, recall: 1, pass: true },
    ]);
    expect(scores).toMatchObject({ cases: 4, recallAt10: 0.75, mrr: 0.4375, graphPassed: 1, graphCases: 2 });
    expect(scores.byKind.keyword).toEqual({ cases: 2, recallAt10: 1, mrr: 0.625 });
  });
});

describe("ceiling check", () => {
  const limits = [{ metric: "boot.seconds", max: 60 }, { metric: "recall.x.recallAt10", min: 0.8 }];

  it("passes when every number is inside its limit", () => {
    expect(checkLimits({ "boot.seconds": 60, "recall.x.recallAt10": 0.8 }, limits)).toEqual([]);
  });

  it("fails a ceiling and a floor", () => {
    expect(checkLimits({ "boot.seconds": 61, "recall.x.recallAt10": 0.79 }, limits)).toEqual([
      { metric: "boot.seconds", measured: 61, limit: "<= 60" },
      { metric: "recall.x.recallAt10", measured: 0.79, limit: ">= 0.8" },
    ]);
  });

  it("fails a limit whose metric was not measured", () => {
    expect(checkLimits({ "boot.seconds": 1, "recall.x.recallAt10": NaN }, limits)).toEqual([
      { metric: "recall.x.recallAt10", measured: NaN, limit: "must be measured" },
    ]);
  });
});

describe("synthetic generator", () => {
  it("plants the committed eval cases for any corpus size", () => {
    const committed = JSON.parse(readFileSync(new URL("../bench/fork/eval/synthetic-cases.json", import.meta.url), "utf8"));
    expect(plant(new Generator(profile, profile.indexable, committed.seed)).cases).toEqual(committed.cases);
  });

  it("keeps graph-case answers out of reach of the keyword index", () => {
    const planted = plant(new Generator(profile, profile.indexable, 1155));
    for (const c of planted.cases.filter((x) => x.kind === "graph")) {
      const hidden = planted.observations.find((o) => o.id === c.expected[0])!;
      const indexed = [hidden.title, hidden.subtitle ?? "", hidden.narrative, ...hidden.concepts, ...hidden.files, hidden.type].join(" ").toLowerCase();
      const entity = c.query.replaceAll('"', "").toLowerCase();
      expect(indexed).not.toContain(entity);
      const anchor = planted.observations.find((o) => o.concepts.some((n) => n.toLowerCase() === entity))!;
      expect(anchor.files).toEqual(hidden.files);
    }
  });

  it("matches the profile's mean stored size within 15%", () => {
    const gen = new Generator(profile, 100_000, 7);
    const session = gen.session(0);
    let bytes = 0;
    for (let i = 0; i < 5000; i++) bytes += Buffer.byteLength(JSON.stringify(gen.observation(session, i)));
    const mean = (profile as Profile & { jsonBytes: { mean: number } }).jsonBytes.mean;
    expect(Math.abs(bytes / 5000 - mean) / mean).toBeLessThan(0.15);
  });

  it("shards observation ids like the obs-session index", async () => {
    const gen = new Generator(profile, 1000, 3);
    const session = gen.session(0);
    for (let i = 0; i < 200; i++) {
      const id = gen.observation(session, i).id;
      let scope = "";
      await indexObservationSession({ set: async (s: string) => { scope = s; } } as unknown as StateKV, id, session.id);
      expect(`mem:idx:obs:${obsIndexShard(id)}`).toBe(scope);
    }
  });

  it("encodes RESP commands with byte lengths", () => {
    expect(resp(["HSET", "k", "é"])).toBe("*3\r\n$4\r\nHSET\r\n$1\r\nk\r\n$2\r\né\r\n");
  });

  it("never emits planted-word letters in ordinary words", () => {
    for (let i = 0; i < 5000; i++) expect(pseudoWord(i)).not.toMatch(/[qx]/);
  });

  it("samples quantiles without the maximum", () => {
    expect(sampleQuantile([1, 2, 1000], 1)).toBe(2);
    expect(sampleQuantile([1, 3, 1000], 0.5)).toBe(2);
  });
});

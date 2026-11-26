import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { KV } from "../../../src/state/schema.js";
import { observationStatsOf, withObservationStats } from "../../../src/fork/kv/observation-stats.js";
import { registerObserveFunction } from "../../../src/functions/observe.js";
import { getSearchIndex, setEmbeddingProvider, setVectorIndex } from "../../../src/functions/search.js";
import { buildSyntheticCompression } from "../../../src/functions/compress-synthetic.js";
import type { CompressedObservation, RawObservation } from "../../../src/types.js";
import { retentionHarness } from "./harness.js";

const CAP = 5000;
type Captured = { observationId?: string; success?: boolean; error?: string };

function setup() {
  const h = retentionHarness();
  const kv = withObservationStats(h.kv);
  registerObserveFunction(h.sdk as never, kv, undefined, CAP);
  const capture = (sessionId: string, i: number) =>
    h.call("mem::observe", {
      sessionId,
      project: "proj",
      cwd: "/tmp/proj",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file: `${sessionId}-${i}.ts` }, tool_output: "x".repeat(200) },
    }) as Promise<Captured>;
  const seed = async (sessionId: string, rows: number) => {
    for (let i = 0; i < rows; i++) {
      const id = `obs_seed_${sessionId}_${i}`;
      await kv.set(KV.observations(sessionId), id, {
        ...buildSyntheticCompression({ id, sessionId, timestamp: new Date().toISOString(), hookType: "post_tool_use", raw: {} } as RawObservation),
        title: `seed ${i}`,
      } as CompressedObservation);
    }
  };
  return { ...h, kv, capture, seed, rows: (sessionId: string) => h.store.get(KV.observations(sessionId))?.size ?? 0 };
}

beforeEach(() => {
  vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
  getSearchIndex().clear();
  setVectorIndex(null);
  setEmbeddingProvider(null);
});

describe("per-session cap of 5000 (R14, D9)", () => {
  it("is what MAX_OBS_PER_SESSION=5000 configures, with no import-ceiling warning", async () => {
    vi.stubEnv("MAX_OBS_PER_SESSION", "5000");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (writes.push(String(chunk)), true));
    vi.resetModules();
    const { loadConfig } = await import("../../../src/config.js");
    expect(loadConfig().maxObservationsPerSession).toBe(CAP);
    expect(writes.filter((w) => w.includes("MAX_OBS_PER_SESSION"))).toEqual([]);
    vi.restoreAllMocks();
  });

  it("stores all 1,000 observations of a session and refuses none", async () => {
    const h = setup();
    const results: Captured[] = [];
    for (let i = 0; i < 1000; i++) results.push(await h.capture("ses_long", i));

    expect(results.filter((r) => r.success === false)).toEqual([]);
    expect(results.every((r) => typeof r.observationId === "string")).toBe(true);
    expect(new Set(results.map((r) => r.observationId)).size).toBe(1000);
    expect(h.rows("ses_long")).toBe(1000);
    expect(await observationStatsOf(h.kv)!.totals("ses_long")).toMatchObject({ rows: 1000 });
    expect(h.store.get(KV.sessions)?.get("ses_long")).toMatchObject({ observationCount: 1000 });
  }, 60_000);

  it("refuses only the capture past 5000", async () => {
    const h = setup();
    await h.seed("ses_full", CAP - 1);
    expect(await h.capture("ses_full", 0)).toMatchObject({ observationId: expect.any(String) });
    expect(h.rows("ses_full")).toBe(CAP);
    expect(await h.capture("ses_full", 1)).toEqual({ success: false, error: `Session observation limit reached (${CAP})` });
    expect(h.rows("ses_full")).toBe(CAP);
  }, 60_000);

  it("captures into a 5000-row session with the storage work of a 100-row one and no slower", async () => {
    const h = setup();
    await h.seed("ses_big", CAP - 100);
    const opsOf = async (sessionId: string, i: number) => {
      h.stateOps.length = 0;
      expect(await h.capture(sessionId, i)).toMatchObject({ observationId: expect.any(String) });
      return [...h.stateOps];
    };
    await h.seed("ses_small", 100);
    await h.capture("ses_warm", 0);
    const small = await opsOf("ses_small", 0);
    const big = await opsOf("ses_big", 0);
    const wholeSessionReads = (ops: string[]) =>
      ops.filter((op) => /^state::(list|list_keys) mem:obs:/.test(op));

    expect(wholeSessionReads(big)).toEqual([]);
    expect(big.length).toBe(small.length);

    const times = async (sessionId: string, from: number, n: number) => {
      const out: number[] = [];
      for (let i = from; i < from + n; i++) {
        const t0 = performance.now();
        await h.capture(sessionId, i);
        out.push(performance.now() - t0);
      }
      return out.sort((a, b) => a - b)[Math.floor(out.length / 2)]!;
    };
    const emptyMedian = await times("ses_small", 1, 60);
    const bigMedian = await times("ses_big", 1, 60);
    expect(h.rows("ses_big")).toBeGreaterThan(CAP - 100);
    expect(bigMedian).toBeLessThan(Math.max(emptyMedian * 3, 5));
  }, 60_000);
});

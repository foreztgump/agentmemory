import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { observationStatsOf, withObservationStats } from "../src/fork/kv/observation-stats.js";
import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import type { CompressedObservation, Session } from "../src/types.js";

type Req = { function_id: string; payload: { scope: string; key: string; value?: unknown } };
const DAY = 86_400_000;

function makeKv(tracked: boolean) {
  const store = new Map<string, Map<string, unknown>>();
  const reads: string[] = [];
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const sdk = {
    registerFunction: (id: string | { id: string }, fn: (payload: unknown) => Promise<unknown>) =>
      functions.set(typeof id === "string" ? id : id.id, fn),
    registerTrigger: () => {},
    trigger: async (req: Req) => {
      const p = req.payload;
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return p.value;
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list":
          reads.push(p.scope);
          return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys":
          reads.push(p.scope);
          return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
        case "state::list_groups": return { groups: [...store.keys()].filter((k) => store.get(k)!.size > 0) };
      }
      const fn = functions.get(req.function_id);
      return fn ? fn(req.payload) : null;
    },
  };
  const base = new StateKV(sdk as never, { backend: "redis" });
  const kv = tracked ? withObservationStats(base) : base;
  registerAutoForgetFunction(sdk as never, kv);
  const forget = (dryRun: boolean) => sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun } as never }) as Promise<{
    ttlExpired: string[];
    contradictions: unknown[];
    lowValueObs: string[];
  }>;
  const obsReads = (sessionId: string) => reads.filter((s) => s === KV.observations(sessionId)).length;
  const remaining = () =>
    Object.fromEntries(
      [...store.entries()]
        .filter(([name]) => name.startsWith("mem:obs:"))
        .map(([name, rows]) => [name, [...rows.keys()].sort()]),
    );
  return { kv, store, forget, obsReads, remaining, reads };
}

function row(id: string, sessionId: string, ageDays: number | null, importance: number | undefined): CompressedObservation {
  return {
    id,
    sessionId,
    ...(ageDays === null ? {} : { timestamp: new Date(Date.now() - ageDays * DAY).toISOString() }),
    type: "file_edit",
    title: id,
    facts: [],
    narrative: "n",
    concepts: [],
    files: [],
    ...(importance === undefined ? {} : { importance }),
  } as CompressedObservation;
}

const SESSIONS: Record<string, Array<[string, number | null, number | undefined]>> = {
  s1: [["a1", 300, 1], ["a2", 250, 2], ["a3", 300, 5]],
  s2: [["b1", 400, 5], ["b2", 400, undefined]],
  s3: [["c1", 10, 1], ["c2", 20, 2]],
  s4: [["d1", 200, 2], ["d2", 5, 1], ["d3", 190, 3]],
  s5: [],
  s6: [["f1", null, 1], ["f2", 400, 3]],
  s7: [["g1", 181, 2], ["g2", 179, 2]],
};

async function seed(h: ReturnType<typeof makeKv>) {
  for (const [sessionId, rows] of Object.entries(SESSIONS)) {
    const session: Session = { id: sessionId, project: "p", cwd: "/tmp", startedAt: new Date().toISOString(), status: "active", observationCount: 0 };
    await h.kv.set(KV.sessions, sessionId, session);
    for (const [id, age, importance] of rows) await h.kv.set(KV.observations(sessionId), id, row(id, sessionId, age, importance));
  }
  await observationStatsOf(h.kv)?.repairAll();
}

beforeEach(() => {
  getSearchIndex().clear();
  setIndexPersistence({ scheduleSave: vi.fn(), save: vi.fn(async () => {}) });
});

describe("auto-forget with observation stats", () => {
  it("returns what the upstream path returns and removes the same rows, dry run and live", async () => {
    const withStats = makeKv(true);
    const plain = makeKv(false);
    await seed(withStats);
    await seed(plain);

    expect(await withStats.forget(true)).toEqual(await plain.forget(true));
    expect(withStats.remaining()).toEqual(plain.remaining());

    const live = await withStats.forget(false);
    expect(live).toEqual(await plain.forget(false));
    expect(live.lowValueObs).toEqual(["a1", "a2", "d1", "g1"]);
    expect(withStats.remaining()).toEqual(plain.remaining());
    expect(withStats.remaining()["mem:obs:s1"]).toEqual(["a3"]);
  });

  it("does not read a session that has no low-importance row old enough", async () => {
    const h = makeKv(true);
    await seed(h);
    h.reads.length = 0;
    await h.forget(true);
    for (const skipped of ["s2", "s3", "s5", "s6"]) expect({ skipped, reads: h.obsReads(skipped) }).toEqual({ skipped, reads: 0 });
    for (const scanned of ["s1", "s4", "s7"]) expect(h.obsReads(scanned)).toBeGreaterThan(0);
  });

  it("converges when the oldest bound is stale: one scan, then none", async () => {
    const h = makeKv(true);
    await seed(h);
    await h.kv.delete(KV.observations("s7"), "g1");
    expect(await observationStatsOf(h.kv)!.lowImportance("s7")).toMatchObject({ rows: 1 });
    h.reads.length = 0;
    expect((await h.forget(true)).lowValueObs).toEqual(["a1", "a2", "d1"]);
    expect(h.obsReads("s7")).toBeGreaterThan(0);
    h.reads.length = 0;
    await h.forget(true);
    expect(h.obsReads("s7")).toBe(0);
  });

  it("scans a session whose stats row predates the low-importance fields, then learns them", async () => {
    const h = makeKv(true);
    await seed(h);
    const row1 = h.store.get(KV.obsStats)!.get("s3") as Record<string, unknown>;
    delete row1.lowImportanceRows;
    delete row1.lowImportanceOldestMs;
    h.reads.length = 0;
    await h.forget(true);
    expect(h.obsReads("s3")).toBeGreaterThan(0);
    h.reads.length = 0;
    await h.forget(true);
    expect(h.obsReads("s3")).toBe(0);
  });

  it("skips a session left without low rows once its old ones are forgotten", async () => {
    const h = makeKv(true);
    await seed(h);
    await h.forget(false);
    h.reads.length = 0;
    await h.forget(true);
    expect(h.obsReads("s1")).toBe(0);
  });
});

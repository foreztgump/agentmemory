import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { withObservationStats } from "../src/fork/kv/observation-stats.js";
import { findUnindexedObservations, getSearchIndex, reconcileIndex, setIndexPersistence } from "../src/functions/search.js";
import { trackedUnindexedObservations } from "../src/fork/index-reconcile.js";
import type { KeywordIndexPort } from "../src/state/search-ports.js";
import type { CompressedObservation, Session } from "../src/types.js";

type Req = { function_id: string; payload: { scope: string; key: string; value?: unknown } };

function makeKv(tracked: boolean) {
  const store = new Map<string, Map<string, unknown>>();
  const listed: string[] = [];
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const sdk = {
    trigger: async (req: Req) => {
      const p = req.payload;
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return p.value;
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list":
          listed.push(p.scope);
          return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
        case "state::list_groups": return { groups: [...store.keys()].filter((k) => store.get(k)!.size > 0) };
      }
      return null;
    },
  };
  const base = new StateKV(sdk as never, { backend: "redis" });
  const kv = tracked ? withObservationStats(base) : base;
  const rows = (sessionId: string) => store.get(KV.observations(sessionId))?.size ?? 0;
  return { kv, rows, listed };
}

function obs(id: string, sessionId: string, indexable = true): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "decision",
    title: `observation ${id}`,
    facts: [],
    ...(indexable ? { narrative: `narrative for ${id}` } : {}),
    concepts: [],
    files: [],
    importance: 5,
  } as CompressedObservation;
}

function session(id: string, observationCount: number): Session {
  return { id, project: "p", cwd: "/tmp", startedAt: new Date().toISOString(), status: "active", observationCount };
}

function pair() {
  const tracked = makeKv(true);
  const plain = makeKv(false);
  const both = {
    async addSession(id: string) {
      await tracked.kv.set(KV.sessions, id, session(id, 0));
      await plain.kv.set(KV.sessions, id, session(id, 0));
    },
    async addObs(o: CompressedObservation) {
      await tracked.kv.set(KV.observations(o.sessionId), o.id, o);
      await plain.kv.set(KV.observations(o.sessionId), o.id, o);
      await plain.kv.update(KV.sessions, o.sessionId, [{ type: "set", path: "observationCount", value: plain.rows(o.sessionId) }]);
    },
    async removeObs(sessionId: string, id: string) {
      await tracked.kv.delete(KV.observations(sessionId), id);
      await plain.kv.delete(KV.observations(sessionId), id);
      await plain.kv.update(KV.sessions, sessionId, [{ type: "set", path: "observationCount", value: plain.rows(sessionId) }]);
    },
    async removeSession(sessionId: string, obsIds: string[]) {
      for (const id of obsIds) await both.removeObs(sessionId, id);
      await tracked.kv.delete(KV.sessions, sessionId);
      await plain.kv.delete(KV.sessions, sessionId);
    },
  };
  const scan = async () => {
    const [a, b] = await Promise.all([findUnindexedObservations(tracked.kv), findUnindexedObservations(plain.kv)]);
    return { tracked: { sessions: a.sessions, missing: a.missing.map((o) => o.id).sort() }, plain: { sessions: b.sessions, missing: b.missing.map((o) => o.id).sort() } };
  };
  const expectSame = async () => {
    const { tracked: a, plain: b } = await scan();
    expect(a).toEqual(b);
    return a;
  };
  return { tracked, plain, both, expectSame };
}

beforeEach(() => {
  getSearchIndex().clear();
  setIndexPersistence({ scheduleSave: vi.fn(), save: vi.fn(async () => {}) });
});

describe("tracked index reconcile", () => {
  it("matches upstream's scan through new sessions, indexable and non-indexable rows, deletes and an index clear", async () => {
    const t = pair();
    const idx = getSearchIndex();
    expect(await t.expectSame()).toEqual({ sessions: 0, missing: [] });

    await t.both.addSession("s1");
    await t.both.addObs(obs("a", "s1"));
    await t.both.addObs(obs("b", "s1", false));
    expect((await t.expectSame()).missing).toEqual(["a"]);

    idx.add(obs("a", "s1"));
    expect((await t.expectSame()).missing).toEqual([]);

    await t.both.addSession("s2");
    await t.both.addObs(obs("c", "s2"));
    await t.both.addObs(obs("d", "s2"));
    expect(await t.expectSame()).toEqual({ sessions: 2, missing: ["c", "d"] });

    idx.add(obs("c", "s2"));
    expect((await t.expectSame()).missing).toEqual(["d"]);
    idx.add(obs("d", "s2"));
    expect((await t.expectSame()).missing).toEqual([]);

    await t.both.addObs(obs("e", "s1"));
    expect((await t.expectSame()).missing).toEqual(["e"]);
    await t.both.removeObs("s1", "e");
    expect((await t.expectSame()).missing).toEqual([]);

    await t.both.addObs(obs("f", "s2"));
    await t.both.removeSession("s2", ["c", "d", "f"]);
    expect(await t.expectSame()).toEqual({ sessions: 1, missing: [] });

    idx.clear();
    expect((await t.expectSame()).missing).toEqual(["a"]);
    idx.add(obs("a", "s1"));
    expect((await t.expectSame()).missing).toEqual([]);

    await t.both.addObs(obs("g", "s1"));
    idx.clear();
    idx.add(obs("g", "s1"));
    expect((await t.expectSame()).missing).toEqual(["a"]);
  });

  it("matches upstream when many sessions change between scans", async () => {
    const t = pair();
    const idx = getSearchIndex();
    for (let s = 0; s < 6; s++) {
      await t.both.addSession(`s${s}`);
      for (let i = 0; i < 3; i++) await t.both.addObs(obs(`o${s}_${i}`, `s${s}`, (s + i) % 2 === 0));
    }
    await t.expectSame();
    idx.add(obs("o0_0", "s0"));
    idx.add(obs("o2_0", "s2"));
    await t.both.addObs(obs("o6_0", "s0"));
    await t.both.removeObs("s3", "o3_1");
    await t.both.addSession("s9");
    await t.both.addObs(obs("o9_0", "s9"));
    await t.expectSame();
    await t.both.removeSession("s1", ["o1_0", "o1_1", "o1_2"]);
    idx.add(obs("o9_0", "s9"));
    await t.expectSame();
  });

  it("lists a session with only non-indexable rows once, not on every scan", async () => {
    const t = pair();
    await t.both.addSession("quiet");
    await t.expectSame();
    for (let i = 0; i < 3; i++) await t.both.addObs(obs(`q${i}`, "quiet", false));
    const before = t.tracked.listed.filter((s) => s === KV.observations("quiet")).length;
    for (let i = 0; i < 4; i++) await t.expectSame();
    const after = t.tracked.listed.filter((s) => s === KV.observations("quiet")).length;
    expect(after - before).toBe(1);
    const plainReads = t.plain.listed.filter((s) => s === KV.observations("quiet")).length;
    expect(plainReads).toBeGreaterThanOrEqual(4);
  });

  it("lists no session at all when nothing changed since the last scan", async () => {
    const t = pair();
    await t.both.addSession("s1");
    await t.both.addObs(obs("a", "s1", false));
    await t.expectSame();
    const before = t.tracked.listed.length;
    await findUnindexedObservations(t.tracked.kv);
    expect(t.tracked.listed.length).toBe(before);
  });

  it("serves status and reconcile calls that overlap", async () => {
    const t = pair();
    await t.both.addSession("s1");
    await t.both.addObs(obs("a", "s1"));
    await t.both.addObs(obs("b", "s1"));
    const [scan, added] = await Promise.all([findUnindexedObservations(t.tracked.kv), reconcileIndex(t.tracked.kv)]);
    expect(scan.sessions).toBe(1);
    expect(added).toBe(2);
    expect(getSearchIndex().has("a")).toBe(true);
    expect((await findUnindexedObservations(t.tracked.kv)).missing).toEqual([]);
  });

  it("keeps working after a failed scan", async () => {
    const t = pair();
    await t.both.addSession("s1");
    await t.both.addObs(obs("a", "s1"));
    const list = t.tracked.kv.list.bind(t.tracked.kv);
    let fail = true;
    t.tracked.kv.list = (async (scope: string) => {
      if (fail && scope === KV.observations("s1")) throw new Error("boom");
      return list(scope);
    }) as never;
    await expect(findUnindexedObservations(t.tracked.kv)).rejects.toThrow("boom");
    fail = false;
    expect((await findUnindexedObservations(t.tracked.kv)).missing.map((o) => o.id)).toEqual(["a"]);
  });
});

describe("tracked index reconcile on a remote index", () => {
  it("prefetches ids a cold remote index does not know before calling them missing", async () => {
    const { kv } = makeKv(true);
    await kv.set(KV.sessions, "s1", session("s1", 0));
    await kv.set(KV.observations("s1"), "a", obs("a", "s1"));
    await kv.set(KV.observations("s1"), "b", obs("b", "s1"));
    const stored = new Set(["a"]);
    const known = new Set<string>();
    const remote = {
      has: (id: string) => known.has(id),
      prefetch: async (ids: readonly string[]) => { for (const id of ids) if (stored.has(id)) known.add(id); },
      observationCountsBySession: async () => new Map([["s1", 0]]),
    } as unknown as KeywordIndexPort;
    const scan = await trackedUnindexedObservations(kv, remote, 0);
    expect(scan?.missing.map((o) => o.id)).toEqual(["b"]);
  });
});

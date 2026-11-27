import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { withObservationStats } from "../src/fork/kv/observation-stats.js";
import { registerFileIndexFunction } from "../src/functions/file-index.js";
import { registerRememberFunction } from "../src/functions/remember.js";

type Req = { function_id: string; payload: Record<string, unknown> };
type Store = Map<string, Map<string, unknown>>;
type Input = { files: string[]; sessionId?: string; project?: string };

const READS = new Set(["state::get", "state::list", "state::list_keys", "state::list_groups"]);

/** A redis-backed StateKV over an in-memory store; `indexed` wraps it the way src/index.ts does. */
function worker(store: Store, indexed: boolean) {
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  const reads: string[] = [];
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const sdk = {
    registerFunction: (id: string | { id: string }, fn: (payload: unknown) => Promise<unknown>) =>
      functions.set(typeof id === "string" ? id : id.id, fn),
    registerTrigger: () => {},
    trigger: async (req: Req) => {
      const p = req.payload as { scope: string; key: string; value?: unknown; ops?: Array<{ type: string; path: string; value?: unknown }> };
      if (READS.has(req.function_id) && p?.scope !== KV.accessLog) reads.push(`${req.function_id} ${p?.scope ?? ""}`);
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return { new_value: p.value };
        case "state::update": {
          const current = { ...((store.get(p.scope)?.get(p.key) as Record<string, unknown>) ?? {}) };
          for (const op of p.ops ?? []) {
            if (op.type === "set") current[op.path] = op.value;
            if (op.type === "remove") delete current[op.path];
          }
          scope(p.scope).set(p.key, current);
          return { new_value: current };
        }
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list": return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
        case "state::list_groups": return { groups: [...store.keys()].filter((k) => store.get(k)!.size > 0) };
      }
      const fn = functions.get(req.function_id);
      return fn ? fn(req.payload) : null;
    },
  };
  const base = new StateKV(sdk as never, { backend: "redis" });
  const kv = indexed ? withObservationStats(base) : base;
  registerFileIndexFunction(sdk as never, kv);
  const fileContext = async (input: Input) => {
    const out = (await sdk.trigger({ function_id: "mem::file-context", payload: input as never })) as { context: string };
    await new Promise((resolve) => setTimeout(resolve, 0));
    return out.context;
  };
  return { sdk, kv, reads, fileContext };
}

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const PATHS = ["src/index.ts", "src/state/kv.ts", "src/functions/file-index.ts", "lib/index.ts", "README.md", "test/kv.test.ts", "/abs/repo/src/state/kv.ts", "docs/README.md"];
const QUERIES = ["src/index.ts", "./src/index.ts", "index.ts", "kv.ts", "state/kv.ts", "./state/kv.ts", "/abs/repo/src/state/kv.ts", "/other/src/index.ts", "README.md", "docs/README.md", "file-index.ts", "missing.ts", "test/kv.test.ts"];

/** Sessions across three projects with tied and invalid start times, rows of every importance, with and without titles. */
function seed(store: Store, sessions: number, seedValue = 7) {
  const pick = rng(seedValue);
  const at = (i: number) => new Date(Date.UTC(2026, 10, 1) + Math.floor(i / 2) * 60_000).toISOString();
  const ids: string[] = [];
  for (let i = 0; i < sessions; i++) {
    const id = `ses-${(i * 7919) % 100_003}`;
    ids.push(id);
    const startedAt = i === 3 ? "not-a-date" : at(i);
    store.set(KV.sessions, store.get(KV.sessions) ?? new Map());
    store.get(KV.sessions)!.set(id, { id, project: `p${i % 3}`, cwd: "/tmp", startedAt, status: "completed", observationCount: 0 });
    const rows = new Map<string, unknown>();
    const n = 1 + Math.floor(pick() * 6);
    for (let j = 0; j < n; j++) {
      const obsId = j % 3 === 0 ? `obs_${(Date.UTC(2026, 10, 1) + i * 1000 + j).toString(36)}_${i}${j}` : `imported-${i}-${j}`;
      const files = [PATHS[Math.floor(pick() * PATHS.length)]!, ...(pick() < 0.3 ? [PATHS[Math.floor(pick() * PATHS.length)]!] : [])];
      rows.set(obsId, {
        id: obsId,
        sessionId: id,
        timestamp: at(i + j),
        type: pick() < 0.5 ? "file_edit" : "decision",
        ...(pick() < 0.85 ? { title: `t-${i}-${j}` } : {}),
        narrative: `n-${i}-${j}`,
        importance: 2 + Math.floor(pick() * 5),
        files,
        concepts: [],
        facts: [],
      });
    }
    store.set(KV.observations(id), rows);
  }
  return ids;
}

function inputs(ids: string[]): Input[] {
  const out: Input[] = [];
  for (const q of QUERIES) {
    out.push({ files: [q] });
    out.push({ files: [q], project: "p1" });
    out.push({ files: [q], sessionId: ids[ids.length - 1] });
    out.push({ files: [q], sessionId: ids[ids.length - 2], project: "p2" });
  }
  out.push({ files: ["src/index.ts", "kv.ts", "README.md"] }, { files: ["index.ts", "index.ts"] });
  return out;
}

async function expectSameAsLegacy(store: Store, indexed: ReturnType<typeof worker>, ids: string[]) {
  const legacy = worker(store, false);
  let nonEmpty = 0;
  for (const input of inputs(ids)) {
    const expected = await legacy.fileContext(input);
    if (expected) nonEmpty++;
    expect({ input, context: await indexed.fileContext(input) }).toEqual({ input, context: expected });
  }
  expect(nonEmpty).toBeGreaterThan(10);
}

describe("file context index", () => {
  it("returns what the full scan returns, window, exclusion, project and match forms included", async () => {
    for (const sessions of [10, 40, 120]) {
      const store: Store = new Map();
      const ids = seed(store, sessions, sessions);
      await expectSameAsLegacy(store, worker(store, true), ids);
    }
  });

  it("stays equal to the full scan through writes made after it warmed", async () => {
    const store: Store = new Map();
    const ids = seed(store, 40);
    const h = worker(store, true);
    await expectSameAsLegacy(store, h, ids);
    const newest = ids[ids.length - 1]!;
    const rowsOf = (id: string) => [...store.get(KV.observations(id))!.keys()];

    await h.kv.set(KV.observations(newest), "obs_added", {
      id: "obs_added", sessionId: newest, timestamp: new Date().toISOString(), type: "bug", title: "added",
      narrative: "fresh", importance: 9, files: ["src/index.ts", "kv.ts"], concepts: [], facts: [],
    });
    await expectSameAsLegacy(store, h, ids);

    const [first, second] = rowsOf(ids[ids.length - 3]!);
    await h.kv.update(KV.observations(ids[ids.length - 3]!), first!, [{ type: "set", path: "importance", value: 1 }]);
    await h.kv.update(KV.observations(ids[ids.length - 3]!), second ?? first!, [{ type: "set", path: "files", value: ["README.md"] }]);
    await expectSameAsLegacy(store, h, ids);

    for (const key of rowsOf(ids[ids.length - 4]!)) await h.kv.delete(KV.observations(ids[ids.length - 4]!), key);
    await expectSameAsLegacy(store, h, ids);

    await h.kv.set(KV.sessions, "ses-newer", { id: "ses-newer", project: "p1", cwd: "/tmp", startedAt: "2027-01-01T00:00:00.000Z", status: "active" });
    await h.kv.set(KV.observations("ses-newer"), "obs_newer", {
      id: "obs_newer", sessionId: "ses-newer", timestamp: "2027-01-01T00:00:01.000Z", type: "bug", title: "newer",
      narrative: "shifts the window", importance: 5, files: ["/abs/repo/src/index.ts"], concepts: [], facts: [],
    });
    await expectSameAsLegacy(store, h, [...ids, "ses-newer"]);

    await h.kv.update(KV.sessions, ids[0]!, [{ type: "set", path: "startedAt", value: "2027-02-01T00:00:00.000Z" }]);
    await h.kv.update(KV.sessions, ids[ids.length - 5]!, [{ type: "set", path: "project", value: "p0" }]);
    await expectSameAsLegacy(store, h, [...ids, "ses-newer"]);

    await h.kv.delete(KV.sessions, newest);
    await expectSameAsLegacy(store, h, ids.slice(0, -1));
  });

  it("follows forget, which deletes the rows and the session through the wrapped kv", async () => {
    const store: Store = new Map();
    const ids = seed(store, 30);
    const h = worker(store, true);
    registerRememberFunction(h.sdk as never, h.kv);
    await expectSameAsLegacy(store, h, ids);
    const victim = ids[ids.length - 2]!;
    const result = (await h.sdk.trigger({ function_id: "mem::forget", payload: { sessionId: victim } })) as { deleted?: number };
    expect(result.deleted).toBeGreaterThan(0);
    expect(store.get(KV.sessions)!.has(victim)).toBe(false);
    await expectSameAsLegacy(store, h, ids.filter((id) => id !== victim));
  });

  it("reads the same amount per warm call at 50 and 500 sessions", async () => {
    const warmReads = async (sessions: number) => {
      const store: Store = new Map();
      seed(store, sessions);
      const h = worker(store, true);
      await h.fileContext({ files: ["src/index.ts"] });
      h.reads.length = 0;
      await h.fileContext({ files: ["src/index.ts", "kv.ts"] });
      return [...h.reads];
    };
    const small = await warmReads(50);
    const large = await warmReads(500);
    expect(large.length).toBe(small.length);
    expect(large.filter((r) => r.includes(KV.sessions)).length).toBe(0);
  });
});

describe("file context index under concurrent and failed writes", () => {
  const row = (id: string, sessionId: string, file: string) => ({
    id, sessionId, timestamp: "2026-12-01T00:00:00.000Z", type: "bug", title: `title-${id}`,
    narrative: `narrative-${id}`, importance: 9, files: [file], concepts: [], facts: [],
  });

  it("shows a write that lands while a session's rows are being read in the next call", async () => {
    const store: Store = new Map();
    const ids = seed(store, 20);
    const h = worker(store, true);
    const target = ids[ids.length - 1]!;
    const scope = KV.observations(target);
    const trigger = h.sdk.trigger;
    let raced = false;
    h.sdk.trigger = async (req: Req) => {
      if (!raced && req.function_id === "state::list" && req.payload.scope === scope) {
        raced = true;
        const stale = await trigger(req);
        await h.kv.set(scope, "obs_raced", row("obs_raced", target, "src/raced.ts"));
        return stale;
      }
      return trigger(req);
    };
    await h.fileContext({ files: ["src/raced.ts"] });
    h.sdk.trigger = trigger;
    expect(raced).toBe(true);
    expect(await h.fileContext({ files: ["src/raced.ts"] })).toContain("title-obs_raced");
    await expectSameAsLegacy(store, h, ids);
  });

  it("shows a write whose stats bookkeeping threw in the next call", async () => {
    const store: Store = new Map();
    const ids = seed(store, 20);
    const h = worker(store, true);
    await expectSameAsLegacy(store, h, ids);
    const target = ids[ids.length - 1]!;
    const trigger = h.sdk.trigger;
    h.sdk.trigger = async (req: Req) => {
      const landed = store.get(KV.observations(target))!.has("obs_late");
      if (landed && req.function_id === "state::set" && req.payload.scope === KV.obsStats) throw new Error("stats store down");
      return trigger(req);
    };
    await expect(h.kv.set(KV.observations(target), "obs_late", row("obs_late", target, "src/index.ts"))).rejects.toThrow("stats store down");
    h.sdk.trigger = trigger;
    expect(store.get(KV.observations(target))!.has("obs_late")).toBe(true);
    expect(await h.fileContext({ files: ["src/index.ts"] })).toContain("title-obs_late");
    await expectSameAsLegacy(store, h, ids);
  });

  it("reads nothing on a warm call and only the changed rows after a capture", async () => {
    const store: Store = new Map();
    const ids = seed(store, 500);
    const h = worker(store, true);
    await h.fileContext({ files: ["src/index.ts"] });
    h.reads.length = 0;
    await h.fileContext({ files: ["src/index.ts", "kv.ts"] });
    const warm = h.reads.length;

    const target = ids[ids.length - 1]!;
    await h.kv.set(KV.observations(target), "obs_capture", row("obs_capture", target, "src/index.ts"));
    await h.kv.update(KV.sessions, target, [{ type: "set", path: "updatedAt", value: "2026-12-01T00:00:00.000Z" }]);
    h.reads.length = 0;
    expect(await h.fileContext({ files: ["src/index.ts"] })).toContain("title-obs_capture");
    expect(warm).toBeLessThanOrEqual(0);
    expect(h.reads.length).toBeLessThanOrEqual(2);
  });
});

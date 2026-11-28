import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { withObservationStats } from "../src/fork/kv/observation-stats.js";
import { registerContextFunction } from "../src/functions/context.js";
import { logger } from "../src/logger.js";
import type { CompressedObservation, Session } from "../src/types.js";

type Req = { function_id: string; payload: { scope: string; key: string; value?: unknown } };

function harness() {
  const store = new Map<string, Map<string, unknown>>();
  const reads: { fn: string; scope: string }[] = [];
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const sdk = {
    registerFunction: () => {},
    registerTrigger: () => {},
    trigger: async (req: Req) => {
      const p = req.payload;
      if (req.function_id.startsWith("state::")) reads.push({ fn: req.function_id, scope: p.scope });
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return { new_value: p.value };
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list": return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
      }
      return null;
    },
  };
  const base = new StateKV(sdk as never, { backend: "redis" });
  const kv = withObservationStats(base);
  const upstream = Object.create(base) as StateKV;
  (upstream as { iterate?: unknown }).iterate = undefined;
  return { store, scope, reads, kv, upstream };
}

const T0 = Date.UTC(2026, 5, 1);

function obs(n: number, suffix: string, sessionId: string, importance: number, title?: string): CompressedObservation {
  return {
    id: `obs_${(T0 + n).toString(36)}_${suffix}`,
    sessionId,
    timestamp: new Date(T0 + n).toISOString(),
    type: "file_edit",
    title: title ?? `title ${n}${suffix}`,
    facts: [],
    narrative: `narrative ${n}${suffix} ${"x".repeat(400)}`,
    concepts: [],
    files: [],
    importance,
  } as CompressedObservation;
}

const SESSIONS = ["ses_a", "ses_b", "ses_c", "ses_cur"];

function seedSessions(h: ReturnType<typeof harness>) {
  SESSIONS.forEach((sid, i) => {
    const s: Session = {
      id: sid, project: "proj", cwd: "/tmp", startedAt: new Date(T0 - i * 1000).toISOString(), status: "completed", observationCount: 0,
    } as Session;
    h.scope(KV.sessions).set(s.id, s);
  });
}

async function writeThroughWrapper(h: ReturnType<typeof harness>) {
  for (const sid of SESSIONS.slice(0, 3)) {
    for (let i = 0; i < 60; i++) {
      const row = obs(i % 20, `${sid}${i}`, sid, [5, 5, 7, 3, 9, 1][i % 6]!, i % 11 === 0 ? "" : undefined);
      await h.kv.set(KV.observations(sid), row.id, row);
    }
  }
}

async function context(kv: StateKV) {
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  const sdk = { registerFunction: (id: string, fn: (payload: unknown) => Promise<unknown>) => functions.set(id, fn) } as never;
  registerContextFunction(sdk, kv, 8000);
  return functions.get("mem::context")!({ sessionId: "ses_cur", project: "proj", agentId: "*" }) as Promise<{ context: string; blocks: number }>;
}

const rebuilds = () =>
  vi.mocked(logger.warn).mock.calls.filter(([message]) => String(message).startsWith("important-observation index")).length;

async function expectSameAsUpstream(h: ReturnType<typeof harness>) {
  const indexed = await context(h.kv);
  const upstream = await context(h.upstream);
  expect(indexed).toEqual(upstream);
  return indexed;
}

const obsReads = (h: ReturnType<typeof harness>) => h.reads.filter((r) => r.scope?.startsWith(KV.observations("")));

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.stubEnv("AGENTMEMORY_SLOTS", "false");
});

describe("mem::context through the important-observation index", () => {
  it("matches upstream output after every kind of observation write", async () => {
    const h = harness();
    seedSessions(h);
    await writeThroughWrapper(h);
    const first = await expectSameAsUpstream(h);
    expect(first.blocks).toBe(3);

    const rowsOf = (sid: string) => [...h.store.get(KV.observations(sid))!.values()] as CompressedObservation[];
    const low = rowsOf("ses_a").find((o) => o.title && o.importance === 5)!;
    await h.kv.update(KV.observations("ses_a"), low.id, [{ type: "set", path: "importance", value: 10 }]);
    expect((await expectSameAsUpstream(h)).context).toContain(`${low.title}:`);
    await h.kv.update(KV.observations("ses_a"), low.id, [{ type: "set", path: "importance", value: 2 }]);
    expect((await expectSameAsUpstream(h)).context).not.toContain(`${low.title}:`);
    const untitled = rowsOf("ses_a").find((o) => !o.title)!;
    await h.kv.set(KV.observations("ses_a"), untitled.id, { ...untitled, title: "now titled", importance: 10 });
    expect((await expectSameAsUpstream(h)).context).toContain("now titled:");
    await h.kv.set(KV.observations("ses_a"), untitled.id, { ...untitled, title: "", importance: 10 });
    await expectSameAsUpstream(h);
    for (const top of rowsOf("ses_c").filter((o) => o.title && o.importance === 9)) {
      await h.kv.delete(KV.observations("ses_c"), top.id);
      await expectSameAsUpstream(h);
    }
    for (const row of [...h.store.get(KV.observations("ses_b"))!.values()] as CompressedObservation[]) {
      await h.kv.delete(KV.observations("ses_b"), row.id);
    }
    expect((await expectSameAsUpstream(h)).blocks).toBe(2);
    await h.kv.set(KV.observations("ses_b"), "late", obs(99, "late", "ses_b", 8));
    await expectSameAsUpstream(h);
    expect(rebuilds()).toBe(0);
  });

  it("reads only the observations it injects once a session is indexed", async () => {
    const h = harness();
    seedSessions(h);
    await writeThroughWrapper(h);
    h.reads.length = 0;
    await context(h.kv);
    const reads = obsReads(h);
    expect(reads.every((r) => r.fn === "state::get")).toBe(true);
    expect(reads.length).toBeLessThanOrEqual(3 * 5);
  });

  it("builds a missing index from one paged scan, then stops scanning", async () => {
    const h = harness();
    seedSessions(h);
    await writeThroughWrapper(h);
    h.store.delete(KV.obsImportant);
    await expectSameAsUpstream(h);
    expect(h.store.get(KV.obsImportant)?.size).toBe(3);
    h.reads.length = 0;
    await context(h.kv);
    expect(obsReads(h).every((r) => r.fn === "state::get")).toBe(true);
  });

  it("never injects a row deleted behind the index's back", async () => {
    const h = harness();
    seedSessions(h);
    await writeThroughWrapper(h);
    await context(h.kv);
    const deleted: string[] = [];
    for (const sid of SESSIONS.slice(0, 3)) {
      const rows = h.store.get(KV.observations(sid))!;
      for (const [key, row] of [...rows]) {
        const o = row as CompressedObservation;
        if (o.importance === 9 && o.title) {
          deleted.push(`${o.title}:`);
          rows.delete(key);
        }
      }
    }
    const out = await expectSameAsUpstream(h);
    expect(rebuilds()).toBe(3);
    expect(deleted.length).toBeGreaterThan(5);
    for (const title of deleted) expect(out.context).not.toContain(title);
  });

  it("matches upstream through a long random run of writes around the index's bound", async () => {
    const h = harness();
    seedSessions(h);
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const keys: string[] = [];
    for (let step = 0; step < 400; step++) {
      const sid = SESSIONS[rand(2)]!;
      const scope = KV.observations(sid);
      const op = rand(5);
      const existing = keys.filter((k) => h.store.get(scope)?.has(k));
      if (op <= 1 || existing.length === 0) {
        const row = obs(rand(40), `r${step}`, sid, rand(11));
        keys.push(row.id);
        await h.kv.set(scope, row.id, row);
      } else if (op === 2) {
        await h.kv.update(scope, existing[rand(existing.length)]!, [{ type: "set", path: "importance", value: rand(11) }]);
      } else if (op === 3) {
        const key = existing[rand(existing.length)]!;
        const row = h.store.get(scope)!.get(key) as CompressedObservation;
        await h.kv.set(scope, key, { ...row, title: row.title ? "" : `retitled ${step}` });
      } else {
        await h.kv.delete(scope, existing[rand(existing.length)]!);
      }
      if (step % 5 === 0) await expectSameAsUpstream(h);
    }
    await expectSameAsUpstream(h);
    expect(rebuilds()).toBe(0);
  });

  it("keeps the shown rows right while the leaders go one by one and new rows rank behind the kept ones", async () => {
    const h = harness();
    seedSessions(h);
    const scope = KV.observations("ses_a");
    for (let i = 0; i < 30; i++) {
      const row = obs(i, `lead${i}`, "ses_a", 6 + (i % 5));
      await h.kv.set(scope, row.id, row);
    }
    for (let i = 0; i < 30; i++) {
      const row = obs(100 + i, `mid${i}`, "ses_a", 6);
      await h.kv.set(scope, row.id, row);
    }
    await expectSameAsUpstream(h);
    for (let step = 0; step < 50; step++) {
      const leader = (await context(h.upstream)).context.match(/\] (title \S+):/)?.[1];
      const row = [...h.store.get(scope)!.values()].find((o) => (o as CompressedObservation).title === leader) as CompressedObservation | undefined;
      if (row) await h.kv.delete(scope, row.id);
      const late = obs(200 + step, `late${step}`, "ses_a", 7);
      await h.kv.set(scope, late.id, late);
      await expectSameAsUpstream(h);
    }
    expect(rebuilds()).toBe(0);
  });
});

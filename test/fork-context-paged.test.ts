import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { collectWhere } from "../src/fork/kv/paged-scan.js";
import { registerContextFunction } from "../src/functions/context.js";
import type { CompressedObservation, Lesson, Session } from "../src/types.js";

type Req = { function_id: string; payload: { scope: string; key: string; value?: unknown } };

function makeStore(backend: "redis" | "file") {
  const store = new Map<string, Map<string, unknown>>();
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
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return { new_value: p.value };
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list": return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
      }
      const fn = functions.get(req.function_id);
      return fn ? fn(req.payload) : null;
    },
  };
  const kv = new StateKV(sdk as never, { backend });
  const withoutIterate = Object.create(kv) as StateKV;
  (withoutIterate as { iterate?: unknown }).iterate = undefined;
  return { sdk, kv, withoutIterate, scope };
}

const T0 = Date.UTC(2026, 5, 1);
const id = (n: number, suffix: string) => `obs_${(T0 + n).toString(36)}_${suffix}`;

function obs(n: number, suffix: string, sessionId: string, importance: number, title = `title ${n}${suffix}`): CompressedObservation {
  return {
    id: id(n, suffix),
    sessionId,
    timestamp: new Date(T0 + n).toISOString(),
    type: "file_edit",
    title,
    facts: [],
    narrative: `narrative ${n}${suffix}`,
    concepts: [],
    files: [],
    importance,
  } as CompressedObservation;
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  let seed = 12345;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function fill(h: ReturnType<typeof makeStore>) {
  const rows: CompressedObservation[] = [];
  for (let i = 0; i < 450; i++) {
    rows.push(obs(i % 90, `a${i}`, "ses_old", [5, 5, 7, 3, 9, 1][i % 6]!, i % 11 === 0 ? "" : undefined));
  }
  for (const row of shuffled(rows)) h.scope(KV.observations("ses_old")).set(row.id, row);
  const sessions: Session[] = ["ses_old", "ses_two", "ses_cur"].map((sid, i) => ({
    id: sid, project: "proj", cwd: "/tmp", startedAt: new Date(T0 - i * 1000).toISOString(), status: "completed", observationCount: 0,
  }));
  for (const s of sessions) h.scope(KV.sessions).set(s.id, s);
  for (const row of shuffled([obs(1, "x", "ses_two", 8), obs(1, "y", "ses_two", 8), obs(1, "z", "ses_two", 6)])) {
    h.scope(KV.observations("ses_two")).set(row.id, row);
  }
  const lessons = Array.from({ length: 30 }, (_, i) => ({
    id: `les_${(T0 + (i % 5)).toString(36)}_${i}`, content: `lesson ${i}`, context: "", confidence: [0.5, 0.8, 0.8][i % 3]!,
    project: i % 2 ? "proj" : undefined, createdAt: new Date(T0 + i).toISOString(), updatedAt: new Date(T0 + i).toISOString(),
    lastReinforcedAt: new Date(T0 + i).toISOString(), reinforcements: 0, source: "manual", tags: [],
  })) as unknown as Lesson[];
  for (const l of shuffled(lessons)) h.scope(KV.lessons).set(l.id, l);
}

async function context(h: ReturnType<typeof makeStore>, kv: StateKV) {
  const sdk = { registerFunction: h.sdk.registerFunction } as never;
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  (sdk as { registerFunction: unknown }).registerFunction = (idOrOpts: string, fn: (payload: unknown) => Promise<unknown>) => functions.set(idOrOpts, fn);
  registerContextFunction(sdk, kv, 8000);
  return functions.get("mem::context")!({ sessionId: "ses_cur", project: "proj", agentId: "*" });
}

beforeEach(() => {
  vi.stubEnv("AGENTMEMORY_SLOTS", "false");
});

describe("collectWhere", () => {
  for (const backend of ["redis", "file"] as const) {
    it(`returns what list then filter returns, on the ${backend} backend, across pages`, async () => {
      const h = makeStore(backend);
      await fill(h);
      const keep = (o: CompressedObservation) => o.title && o.importance >= 5;
      const expected = (await h.kv.list<CompressedObservation>(KV.observations("ses_old"))).filter(keep);
      const paged = await collectWhere<CompressedObservation>(h.kv, KV.observations("ses_old"), keep);
      expect(paged.length).toBeGreaterThan(100);
      if (backend === "redis") expect(paged).toEqual(expected);
      else expect(paged.map((o) => o.id).sort()).toEqual(expected.map((o) => o.id).sort());
      expect(await collectWhere(h.withoutIterate, KV.observations("ses_old"), keep)).toEqual(expected);
    });
  }

  it("holds only the rows it keeps", async () => {
    const h = makeStore("redis");
    await fill(h);
    const kept = await collectWhere<CompressedObservation>(h.kv, KV.observations("ses_old"), (o) => o.importance === 9);
    expect(kept.every((o) => o.importance === 9)).toBe(true);
    expect(await collectWhere(h.kv, KV.observations("nothing"), () => true)).toEqual([]);
  });
});

describe("mem::context reads", () => {
  it("is byte-identical with the paged reads and with upstream's whole-scope lists, ties in importance included", async () => {
    const h = makeStore("redis");
    await fill(h);
    const paged = (await context(h, h.kv)) as { context: string; blocks: number };
    const upstream = (await context(h, h.withoutIterate)) as { context: string; blocks: number };
    expect(paged.blocks).toBeGreaterThan(1);
    expect(paged.context).toContain("title ");
    expect(paged).toEqual(upstream);
  });
});

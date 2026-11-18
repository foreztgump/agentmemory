import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateKV, collectAll } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  GuardedStateKV,
  ScopeReadInventory,
  withScopeGuard,
  getScopeGuardMode,
  normalizeScope,
} from "../src/fork/scope-guard.js";

type Call = { function_id: string; payload: { scope: string; key?: string } };

function fakeSdk(store: Map<string, Map<string, unknown>>, functionId?: string) {
  return {
    currentInvocation: () => (functionId ? { function_id: functionId } : undefined),
    trigger: async (req: Call) => {
      const scope = store.get(req.payload.scope) ?? new Map<string, unknown>();
      if (req.function_id === "state::list") return [...scope.values()];
      if (req.function_id === "state::list_keys") return { keys: [...scope.keys()] };
      if (req.function_id === "state::get") return scope.get(req.payload.key!) ?? null;
      throw new Error(`unexpected ${req.function_id}`);
    },
  };
}

function seeded(scope: string, count: number) {
  const values = new Map<string, unknown>();
  for (let i = 0; i < count; i++) values.set(`k${i}`, { id: `k${i}`, text: "x".repeat(10) });
  return new Map([[scope, values]]);
}

const bytesOf = (values: unknown[]) => Buffer.byteLength(JSON.stringify(values));

const savedEnv = process.env.AGENTMEMORY_SCOPE_GUARD;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENTMEMORY_SCOPE_GUARD;
  else process.env.AGENTMEMORY_SCOPE_GUARD = savedEnv;
});

describe("scope guard", () => {
  it("normalizes per-id scopes to their schema template", () => {
    expect(normalizeScope(KV.observations("ses_abc123"))).toBe("mem:obs:*");
    expect(normalizeScope(KV.teamUsers("t1", "u2"))).toBe("mem:team:*:users:*");
    expect(normalizeScope(KV.obsSessionIndex(7))).toBe("mem:idx:obs:*");
    expect(normalizeScope(KV.memories)).toBe("mem:memories");
    expect(normalizeScope(KV.auditMonths)).toBe("mem:audit:months");
    expect(normalizeScope(KV.auditMonth("2026-11"))).toBe("mem:audit:*");
    expect(normalizeScope("mem:index:bm25:vec:12")).toBe("mem:index:bm25:vec:*");
  });

  it("records a list with its collection, calling function, item count and reply bytes", async () => {
    const inventory = new ScopeReadInventory();
    const kv = new GuardedStateKV(fakeSdk(seeded("mem:obs:ses_1", 3), "mem::observe") as never, {}, inventory);
    let values: unknown[] = [];
    for (let i = 0; i < 2; i++) values = await kv.list("mem:obs:ses_1");
    const [read] = inventory.snapshot().reads;
    expect(read).toMatchObject({
      collection: "mem:obs:*",
      op: "list",
      calls: 2,
      maxItems: 3,
      maxBytes: bytesOf(values),
      bytes: 2 * bytesOf(values),
    });
    expect(read!.site).toMatch(/^mem::observe (\S+ )?fork-scope-guard\.test\.ts:\d+$/);
  });

  it("records a whole iterate and collectAll even when pages are consumed one by one", async () => {
    const inventory = new ScopeReadInventory();
    const kv = new GuardedStateKV(fakeSdk(seeded(KV.memories, 5)) as never, {}, inventory);
    const all = await collectAll(kv, KV.memories);
    const reads = inventory.snapshot().reads;
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ collection: KV.memories, op: "iterate", maxItems: 5, maxBytes: bytesOf(all) });
    expect(reads[0]!.site.startsWith("- ")).toBe(true);
  });

  it("records what an iterate read before the caller stopped early", async () => {
    const inventory = new ScopeReadInventory();
    const kv = new GuardedStateKV(fakeSdk(seeded(KV.memories, 5)) as never, {}, inventory);
    for await (const page of kv.iterate(KV.memories, { pageSize: 2 })) {
      expect(page).toHaveLength(2);
      break;
    }
    expect(inventory.snapshot().reads[0]).toMatchObject({ op: "iterate", maxItems: 2 });
  });

  it("records listKeys and skips collections the predicate calls bounded", async () => {
    const inventory = new ScopeReadInventory();
    const store = new Map([...seeded(KV.memories, 2), ...seeded(KV.config, 2)]);
    const kv = new GuardedStateKV(fakeSdk(store) as never, {}, inventory, (c) => c !== KV.config);
    await kv.listKeys(KV.memories);
    await kv.list(KV.config);
    expect(inventory.snapshot().reads.map((r) => [r.collection, r.op])).toEqual([[KV.memories, "listKeys"]]);
  });

  it("records a listPage as a read of every key, with the page as the reply", async () => {
    const inventory = new ScopeReadInventory();
    const kv = new GuardedStateKV(fakeSdk(seeded(KV.memories, 5)) as never, {}, inventory);
    const page = await kv.listPage(KV.memories, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(inventory.snapshot().reads[0]).toMatchObject({ op: "listPage", maxItems: 5, maxBytes: bytesOf(page.items) });
  });

  it("returns the same values as an unguarded StateKV", async () => {
    const store = seeded(KV.memories, 4);
    const plain = await new StateKV(fakeSdk(store) as never).list(KV.memories);
    const guarded = await new GuardedStateKV(fakeSdk(store) as never, {}, new ScopeReadInventory()).list(KV.memories);
    expect(guarded).toEqual(plain);
  });

  it("writes the inventory sorted by largest reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
    try {
      const inventory = new ScopeReadInventory();
      inventory.record("a", "list", "s", 1, 10);
      inventory.record("b", "list", "s", 1, 99);
      inventory.writeTo(join(dir, "inv.json"));
      const written = JSON.parse(readFileSync(join(dir, "inv.json"), "utf8"));
      expect(written.v).toBe(1);
      expect(written.reads.map((r: { collection: string }) => r.collection)).toEqual(["b", "a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is off by default, accepts warn, and rejects anything else", () => {
    delete process.env.AGENTMEMORY_SCOPE_GUARD;
    expect(getScopeGuardMode()).toBe("off");
    const sdk = fakeSdk(new Map()) as never;
    const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
    const plain = new StateKV(sdk, { backend: "redis" });
    expect(withScopeGuard(plain, sdk, dir)).toBe(plain);
    process.env.AGENTMEMORY_SCOPE_GUARD = "warn";
    const guarded = withScopeGuard(plain, sdk, dir);
    expect(guarded).toBeInstanceOf(GuardedStateKV);
    expect(guarded.backend).toBe("redis");
    process.env.AGENTMEMORY_SCOPE_GUARD = "throw";
    expect(() => getScopeGuardMode()).toThrow(/off or warn/);
  });
});

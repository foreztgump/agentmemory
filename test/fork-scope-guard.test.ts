import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateKV, collectAll } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  GuardedStateKV,
  ScopeReadInventory,
  ScopeTooLargeError,
  assertWholeReadAllowed,
  withScopeGuard,
  getScopeGuardMode,
  normalizeScope,
  readInventory,
  scopeClassOf,
  type WholeReadOp,
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

  it("carries the inventory across a restart and counts the restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
    const file = join(dir, "inv.json");
    try {
      const first = new ScopeReadInventory();
      first.record("a", "list", "s", 2, 10);
      first.writeTo(file);
      const second = new ScopeReadInventory(readInventory(file));
      second.record("a", "list", "s", 5, 4);
      const snapshot = second.snapshot();
      expect(snapshot).toMatchObject({ startedAt: first.startedAt, restarts: 1 });
      expect(snapshot.reads).toMatchObject([{ calls: 2, items: 7, bytes: 14, maxItems: 5, maxBytes: 10 }]);
      writeFileSync(file, "{not json");
      expect(readInventory(file)).toBeUndefined();
      writeFileSync(file, JSON.stringify({ v: 1, reads: [] }));
      expect(readInventory(file)).toBeUndefined();
      const kept = { ...snapshot.reads[0]! };
      const restored = new ScopeReadInventory({ ...snapshot, reads: [kept, { collection: "b", op: "list" } as never] });
      expect(restored.snapshot().reads).toEqual([kept]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is off by default, accepts warn and throw, and rejects anything else", () => {
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
    for (const value of ["throw", "refuse", " THROW "]) {
      process.env.AGENTMEMORY_SCOPE_GUARD = value;
      expect(getScopeGuardMode()).toBe("throw");
    }
    process.env.AGENTMEMORY_SCOPE_GUARD = "strict";
    expect(() => getScopeGuardMode()).toThrow(/off, warn or throw/);
  });
});

describe("scope guard refuse mode", () => {
  const OPS: WholeReadOp[] = ["list", "listKeys", "iterate", "listPage"];
  const refused = (scope: string, op: WholeReadOp) => {
    try {
      assertWholeReadAllowed(scope, op);
      return false;
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeTooLargeError);
      return true;
    }
  };

  it("maps a raw scope to its class through the KV templates", () => {
    expect(scopeClassOf(KV.memories)).toBe("paged-only");
    expect(scopeClassOf(KV.config)).toBe("bounded");
    expect(scopeClassOf(KV.graphControl)).toBe("point-read-only");
    expect(scopeClassOf(KV.observations("ses_abc"))).toBe("bounded");
    expect(scopeClassOf(KV.auditMonth("2026-11"))).toBe("paged-only");
    expect(scopeClassOf(KV.auditMonths)).toBe("bounded");
    expect(scopeClassOf(KV.teamShared("t1"))).toBe("paged-only");
    expect(scopeClassOf(KV.teamProfile("t1"))).toBe("bounded");
    expect(scopeClassOf(KV.obsSessionIndex(3))).toBe("point-read-only");
    expect(scopeClassOf(KV.captureEvents("a1"))).toBe("paged-only");
    expect(scopeClassOf("mem:not-a-scope")).toBeUndefined();
    expect(scopeClassOf("mem:index:bm25:vec:12")).toBeUndefined();
  });

  it.each([
    ["bounded", KV.config, []],
    ["bounded family", KV.observations("ses_abc"), []],
    ["bounded static beside a family", KV.auditMonths, []],
    ["paged-only", KV.memories, ["list"]],
    ["paged-only family", KV.auditMonth("2026-11"), ["list"]],
    ["point-read-only", KV.graphControl, ["list", "listKeys", "iterate", "listPage"]],
    ["point-read-only family", KV.obsSessionIndex(3), ["list", "listKeys", "iterate", "listPage"]],
    ["unknown", "mem:not-a-scope", []],
  ] as Array<[string, string, WholeReadOp[]]>)("refuses exactly the ops its class forbids: %s", (_label, scope, forbidden) => {
    expect(OPS.filter((op) => refused(scope, op))).toEqual(forbidden);
  });

  it("names the scope, the op and the paged alternative", () => {
    expect(() => assertWholeReadAllowed(KV.auditMonth("2026-11"), "list")).toThrow(
      /list of mem:audit:2026-11 \(paged-only\).*use iterate, collectAll, listPage or getMany/,
    );
    expect(() => assertWholeReadAllowed(KV.graphControl, "iterate")).toThrow(
      /iterate of mem:graph:control \(point-read-only\).*by key with get or getMany/,
    );
    try {
      assertWholeReadAllowed(KV.memories, "list");
    } catch (error) {
      expect(error).toMatchObject({ name: "ScopeTooLargeError", scope: KV.memories, op: "list", scopeClass: "paged-only" });
    }
  });

  it("refuses before reading, and only in throw mode", async () => {
    const reads: string[] = [];
    const sdk = fakeSdk(seeded(KV.memories, 3));
    const counting = { ...sdk, trigger: async (req: Call) => (reads.push(req.function_id), sdk.trigger(req)) };
    const strict = new GuardedStateKV(counting as never, {}, new ScopeReadInventory(), undefined, true);
    await expect(strict.list(KV.memories)).rejects.toBeInstanceOf(ScopeTooLargeError);
    expect(reads).toEqual([]);
    await expect(strict.listKeys(KV.memories)).resolves.toHaveLength(3);
    await expect(strict.listPage(KV.memories, { limit: 2 })).resolves.toMatchObject({ total: 3 });
    expect((await collectAll(strict, KV.memories)).length).toBe(3);
    await expect(strict.list(KV.config)).resolves.toEqual([]);
    await expect(strict.listKeys(KV.graphControl)).rejects.toBeInstanceOf(ScopeTooLargeError);
    await expect(collectAll(strict, KV.graphControl)).rejects.toBeInstanceOf(ScopeTooLargeError);
    await expect(strict.listPage(KV.graphControl, { limit: 1 })).rejects.toBeInstanceOf(ScopeTooLargeError);

    const lenient = new GuardedStateKV(fakeSdk(seeded(KV.graphControl, 2)) as never, {}, new ScopeReadInventory());
    for (const scope of [KV.graphControl, KV.memories]) {
      await expect(lenient.list(scope)).resolves.toBeDefined();
      await expect(lenient.listKeys(scope)).resolves.toBeDefined();
      await expect(collectAll(lenient, scope)).resolves.toBeDefined();
    }
  });

  it("keeps recording the reads it allows", async () => {
    const inventory = new ScopeReadInventory();
    const kv = new GuardedStateKV(fakeSdk(seeded(KV.memories, 3)) as never, {}, inventory, undefined, true);
    await collectAll(kv, KV.memories);
    await expect(kv.list(KV.memories)).rejects.toThrow();
    expect(inventory.snapshot().reads.map((r) => r.op)).toEqual(["iterate"]);
  });

  it("wraps the store in throw mode and leaves warn mode alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
    const sdk = fakeSdk(seeded(KV.memories, 2)) as never;
    try {
      process.env.AGENTMEMORY_SCOPE_GUARD = "throw";
      await expect(withScopeGuard(new StateKV(sdk), sdk, dir).list(KV.memories)).rejects.toBeInstanceOf(ScopeTooLargeError);
      process.env.AGENTMEMORY_SCOPE_GUARD = "warn";
      await expect(withScopeGuard(new StateKV(sdk), sdk, dir).list(KV.memories)).resolves.toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { StateKV, applyUpdateOps } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { withObservationStats } from "../src/fork/kv/observation-stats.js";
import { GuardedStateKV, ScopeReadInventory } from "../src/fork/scope-guard.js";

const SET_TIMEOUT = "invocation_failed: handler error: SET_ERROR: Failed to set value: Failed to atomically set value in Redis: timed out";
const DELETE_TIMEOUT = "invocation_failed: handler error: DELETE_ERROR: Failed to delete value: Failed to delete value from Redis: timed out";

type Req = { function_id: string; payload: { scope: string; key: string; value?: unknown; ops?: never[] } };

/** A redis-backed engine whose writes time out as the adapter does: the command still lands when `applies`. */
function flakyEngine() {
  const store = new Map<string, unknown>();
  const calls: string[] = [];
  const failures = new Map<string, number>();
  let applies = false;
  const id = (scope: string, key: string) => `${scope}\u0000${key}`;
  const fail = (fn: string, message: string) => {
    const left = failures.get(fn) ?? 0;
    if (left === 0) return null;
    failures.set(fn, left - 1);
    return new Error(message);
  };
  const sdk = {
    trigger: vi.fn(async (req: Req) => {
      const { scope, key } = req.payload;
      calls.push(req.function_id);
      switch (req.function_id) {
        case "state::get":
          return store.has(id(scope, key)) ? structuredClone(store.get(id(scope, key))) : null;
        case "state::set": {
          const old = store.get(id(scope, key)) ?? null;
          const error = fail("state::set", SET_TIMEOUT);
          if (!error || applies) store.set(id(scope, key), structuredClone(req.payload.value));
          if (error) throw error;
          return { old_value: old, new_value: req.payload.value };
        }
        case "state::update": {
          const old = store.get(id(scope, key)) ?? null;
          const error = fail("state::update", SET_TIMEOUT);
          const next = applyUpdateOps(old, req.payload.ops ?? []);
          if (!error || applies) store.set(id(scope, key), next);
          if (error) throw error;
          return { old_value: old, new_value: next, errors: [] };
        }
        case "state::delete": {
          const error = fail("state::delete", DELETE_TIMEOUT);
          if (!error || applies) store.delete(id(scope, key));
          if (error) throw error;
          return null;
        }
        case "state::list_keys":
          return { keys: [...store.keys()].filter((k) => k.startsWith(`${scope}\u0000`)).map((k) => k.split("\u0000")[1]) };
        default:
          return null;
      }
    }),
  };
  return {
    sdk,
    calls,
    stored: (scope: string, key: string) => store.get(id(scope, key)) ?? null,
    seed: (scope: string, key: string, value: unknown) => void store.set(id(scope, key), value),
    timeOut: (fn: string, times: number, opts: { applies?: boolean } = {}) => {
      failures.set(fn, times);
      applies = opts.applies ?? false;
    },
    count: (fn: string) => calls.filter((c) => c === fn).length,
  };
}

const redisKV = (engine: ReturnType<typeof flakyEngine>) => new StateKV(engine.sdk as never, { backend: "redis" });

describe("a state write that times out on the redis adapter", () => {
  it("set is retried until it lands", async () => {
    const engine = flakyEngine();
    engine.timeOut("state::set", 2);
    await redisKV(engine).set(KV.memories, "mem_1", { id: "mem_1", title: "kept" });
    expect(engine.stored(KV.memories, "mem_1")).toEqual({ id: "mem_1", title: "kept" });
    expect(engine.count("state::set")).toBe(3);
  });

  it("set that the server applied before the reply timed out converges to the same value", async () => {
    const engine = flakyEngine();
    engine.timeOut("state::set", 1, { applies: true });
    await redisKV(engine).set(KV.memories, "mem_1", { id: "mem_1", title: "once" });
    expect(engine.stored(KV.memories, "mem_1")).toEqual({ id: "mem_1", title: "once" });
  });

  it("set that keeps timing out is reported to the caller after a bounded number of tries", async () => {
    const engine = flakyEngine();
    engine.timeOut("state::set", 100);
    await expect(redisKV(engine).set(KV.memories, "mem_1", { id: "mem_1" })).rejects.toThrow(/atomically set value in Redis: timed out/);
    expect(engine.count("state::set")).toBeGreaterThan(1);
    expect(engine.count("state::set")).toBeLessThanOrEqual(5);
    expect(engine.stored(KV.memories, "mem_1")).toBeNull();
  });

  it("delete is retried until the row is gone", async () => {
    const engine = flakyEngine();
    engine.seed(KV.memories, "mem_1", { id: "mem_1" });
    engine.timeOut("state::delete", 2);
    await redisKV(engine).delete(KV.memories, "mem_1");
    expect(engine.stored(KV.memories, "mem_1")).toBeNull();
    expect(engine.count("state::delete")).toBe(3);
  });

  it("delete that keeps timing out is reported to the caller", async () => {
    const engine = flakyEngine();
    engine.seed(KV.memories, "mem_1", { id: "mem_1" });
    engine.timeOut("state::delete", 100);
    await expect(redisKV(engine).delete(KV.memories, "mem_1")).rejects.toThrow(/delete value from Redis: timed out/);
    expect(engine.stored(KV.memories, "mem_1")).toEqual({ id: "mem_1" });
  });

  it("update with set and remove ops retries its write and stores the updated row", async () => {
    const engine = flakyEngine();
    engine.seed(KV.sessions, "ses_1", { id: "ses_1", status: "completed", endedAt: "x", observationCount: 1 });
    engine.timeOut("state::set", 2);
    await redisKV(engine).update(KV.sessions, "ses_1", [
      { type: "set", path: "status", value: "active" },
      { type: "remove", path: "endedAt" },
      { type: "set", path: "observationCount", value: 2 },
    ]);
    expect(engine.stored(KV.sessions, "ses_1")).toEqual({ id: "ses_1", status: "active", observationCount: 2 });
  });

  it("update with an op the engine applies itself is not retried, since a second try could apply it twice", async () => {
    const engine = flakyEngine();
    engine.seed(KV.sessions, "ses_1", { id: "ses_1", observationCount: 1 });
    engine.timeOut("state::update", 1, { applies: true });
    await expect(
      redisKV(engine).update(KV.sessions, "ses_1", [{ type: "increment", path: "observationCount", value: 1 }]),
    ).rejects.toThrow(/timed out/);
    expect(engine.count("state::update")).toBe(1);
  });

  it("does not retry a write that failed for another reason", async () => {
    const engine = flakyEngine();
    engine.sdk.trigger.mockImplementationOnce(async () => {
      throw new Error("invocation_failed: handler error: SET_ERROR: Failed to set value: WRONGTYPE Operation against a key holding the wrong kind of value");
    });
    await expect(redisKV(engine).set(KV.memories, "mem_1", { id: "mem_1" })).rejects.toThrow(/WRONGTYPE/);
    expect(engine.count("state::set")).toBe(0);
  });

  it("keeps two writes to one key in call order when the first one is retried", async () => {
    const engine = flakyEngine();
    engine.timeOut("state::set", 1);
    const kv = redisKV(engine);
    await Promise.all([
      kv.set(KV.memories, "mem_1", { id: "mem_1", v: 1 }),
      kv.set(KV.memories, "mem_1", { id: "mem_1", v: 2 }),
    ]);
    expect(engine.stored(KV.memories, "mem_1")).toEqual({ id: "mem_1", v: 2 });
  });

  it("is retried through the fork's observation-stats and scope-guard wrappers", async () => {
    const engine = flakyEngine();
    const kv = withObservationStats(new GuardedStateKV(engine.sdk as never, { backend: "redis" }, new ScopeReadInventory()));
    engine.timeOut("state::set", 1);
    await kv.set(KV.observations("ses_1"), "obs_1", { id: "obs_1", sessionId: "ses_1", title: "t" });
    expect(engine.stored(KV.observations("ses_1"), "obs_1")).toMatchObject({ id: "obs_1" });
    expect(engine.stored(KV.obsStats, "ses_1")).toMatchObject({ rows: 1 });
    engine.timeOut("state::delete", 1);
    await kv.delete(KV.observations("ses_1"), "obs_1");
    expect(engine.stored(KV.observations("ses_1"), "obs_1")).toBeNull();
  });
});

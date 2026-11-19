import { describe, expect, it, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { KEYS_WARN_COUNT, WHOLE_LIST_MAX_KEYS, isRedisListTimeout } from "../src/fork/kv/redis-replies.js";
import { logger } from "../src/logger.js";

// The message iii's redis adapter (state worker 0.22.22) returns when HGETALL outlasts the redis
// client's response timeout, as seen on Kvrocks at first boot. If a new state worker changes it,
// this test and the fallback in StateKV.list must follow.
const ADAPTER_TIMEOUT = "invocation_failed: handler error: LIST_ERROR: Failed to list values: Failed to get group from Redis: timed out";

type Call = { function_id: string; payload: { scope: string; key?: string } };

function sdk(rows: Record<string, unknown>, listError?: string) {
  const calls: string[] = [];
  return {
    calls,
    trigger: async (req: Call) => {
      calls.push(req.function_id);
      if (req.function_id === "state::list") {
        if (listError) throw new Error(listError);
        return Object.values(rows);
      }
      if (req.function_id === "state::list_keys") return { keys: Object.keys(rows) };
      if (req.function_id === "state::get") return rows[req.payload.key!] ?? null;
      throw new Error(`unexpected ${req.function_id}`);
    },
  };
}

const rows = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [
  `obs_${i}`, { id: `obs_${i}`, timestamp: new Date(Date.UTC(2026, 10, 1, 0, 40 - i)).toISOString() },
]));

describe("StateKV.list on a redis store that times out", () => {
  it("returns the same rows in the same order through list_keys and point reads", async () => {
    const expected = await new StateKV(sdk(rows) as never, { backend: "redis" }).list("mem:obs:s1");
    const slow = sdk(rows, ADAPTER_TIMEOUT);
    expect(await new StateKV(slow as never, { backend: "redis" }).list("mem:obs:s1")).toEqual(expected);
    expect(slow.calls).toContain("state::list_keys");
  });

  it("drops a row deleted between list_keys and the point read, never returning a null row", async () => {
    const live: Record<string, unknown> = { ...rows };
    const base = sdk(live, ADAPTER_TIMEOUT);
    const racing = {
      trigger: async (req: Call) => {
        const out = await base.trigger(req);
        if (req.function_id === "state::list_keys") delete live.obs_7;
        return out;
      },
    };
    const got = await new StateKV(racing as never, { backend: "redis" }).list<{ id: string }>("mem:obs:s1");
    const expected = await new StateKV(sdk(live) as never, { backend: "redis" }).list<{ id: string }>("mem:obs:s1");
    expect(got.every((row) => row !== null && row !== undefined)).toBe(true);
    expect(got).toEqual(expected);
    expect(got).toHaveLength(39);
  });

  it("still fails on any other error, and on the file backend", async () => {
    await expect(new StateKV(sdk(rows, "LIST_ERROR: Failed to deserialize value") as never, { backend: "redis" }).list("mem:obs:s1"))
      .rejects.toThrow("deserialize");
    await expect(new StateKV(sdk(rows, ADAPTER_TIMEOUT) as never, { backend: "file" }).list("mem:obs:s1"))
      .rejects.toThrow("timed out");
  });

  it("recognises only the adapter's list timeout", () => {
    expect(isRedisListTimeout(new Error(ADAPTER_TIMEOUT))).toBe(true);
    expect(isRedisListTimeout(new Error("invocation timed out"))).toBe(false);
  });
});

describe("StateKV.list keeps each redis reply small", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [
    `obs_${i}`, { id: `obs_${i}`, timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() },
  ]));

  it("reads a scope above WHOLE_LIST_MAX_KEYS row by row, never with one state::list", async () => {
    const big = many(WHOLE_LIST_MAX_KEYS + 1);
    const store = sdk(big);
    const got = await new StateKV(store as never, { backend: "redis" }).list("mem:obs:s1");
    expect(store.calls).not.toContain("state::list");
    expect(got).toEqual(await new StateKV(sdk(big) as never, { backend: "file" }).list("mem:obs:s1"));
  });

  it("sends one state::list for a scope at the limit, and the file backend never lists keys", async () => {
    const small = many(WHOLE_LIST_MAX_KEYS);
    const redis = sdk(small);
    await new StateKV(redis as never, { backend: "redis" }).list("mem:obs:s1");
    expect(redis.calls).toEqual(["state::list_keys", "state::list"]);
    const file = sdk(many(WHOLE_LIST_MAX_KEYS + 1));
    await new StateKV(file as never, { backend: "file" }).list("mem:obs:s1");
    expect(file.calls).toEqual(["state::list"]);
  });

  it("warns once when a listed scope passes KEYS_WARN_COUNT", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const kv = new StateKV({ trigger: async () => ({ keys: Array.from({ length: KEYS_WARN_COUNT + 1 }, (_, i) => `k${i}`) }) } as never, { backend: "redis" });
    await kv.listKeys("mem:memories");
    await kv.listKeys("mem:memories");
    expect(warn.mock.calls.filter(([message]) => String(message).includes("nearing the adapter's reply limit"))).toHaveLength(1);
    warn.mockRestore();
  });
});

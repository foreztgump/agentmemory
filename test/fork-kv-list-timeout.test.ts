import { describe, expect, it } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { isRedisListTimeout } from "../src/fork/kv/list-timeout.js";

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

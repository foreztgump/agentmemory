import { describe, expect, it } from "vitest";
import { scopeReader, type StateKV } from "../src/state/kv.js";

function flakyKV(failures: number) {
  let lists = 0;
  const kv = {
    list: async () => {
      lists++;
      if (lists <= failures) throw new Error(`list ${lists} failed`);
      return [{ id: "a" }, { id: "b" }];
    },
  };
  return { kv: kv as unknown as StateKV, lists: () => lists };
}

describe("scopeReader", () => {
  it("reads each scope once and shares the rows", async () => {
    const { kv, lists } = flakyKV(0);
    const read = scopeReader(kv);
    const [first, second] = await Promise.all([read("mem:facets"), read("mem:facets")]);
    expect(first).toEqual([{ id: "a" }, { id: "b" }]);
    expect(second).toBe(first);
    expect(lists()).toBe(1);
  });

  it("retries a scope whose first read failed", async () => {
    const { kv, lists } = flakyKV(1);
    const read = scopeReader(kv);
    await expect(read("mem:facets")).rejects.toThrow("list 1 failed");
    await expect(read("mem:facets")).resolves.toEqual([{ id: "a" }, { id: "b" }]);
    expect(lists()).toBe(2);
  });
});

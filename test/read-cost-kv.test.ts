import { describe, expect, it } from "vitest";
import { readCostKV } from "./helpers/read-cost-kv.js";

describe("readCostKV", () => {
  it("counts writes apart from the read chain", async () => {
    const { kv, seed, measure } = readCostKV();
    seed("mem:probe", "a", { id: "a" });
    const r = await measure(async () => {
      await kv.get("mem:probe", "a");
      await kv.set("mem:probe", "b", { id: "b" });
      await kv.set("mem:probe", "c", { id: "c" });
      await kv.get("mem:probe", "b");
    });
    expect({ reads: r.reads, writes: r.writes, depth: r.depth }).toEqual({ reads: 2, writes: 2, depth: 2 });
  });
});

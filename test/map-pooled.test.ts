import { describe, expect, it } from "vitest";
import { mapPooled } from "../src/state/kv.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("mapPooled", () => {
  it("keeps input order and never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPooled(
      Array.from({ length: 40 }, (_, i) => i),
      async (i) => {
        peak = Math.max(peak, ++inFlight);
        for (let t = 0; t < (i % 3) + 1; t++) await tick();
        inFlight--;
        return i * 2;
      },
      16,
    );
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => i * 2));
    expect(peak).toBe(16);
  });

  it("throws the earliest item's error and starts no new work after a failure", async () => {
    const started: number[] = [];
    const failure = mapPooled(
      Array.from({ length: 40 }, (_, i) => i),
      async (i) => {
        started.push(i);
        await tick();
        if (i === 9) throw new Error("item 9");
        if (i === 3) {
          for (let t = 0; t < 3; t++) await tick();
          throw new Error("item 3");
        }
        return i;
      },
      4,
    );
    await expect(failure).rejects.toThrow("item 3");
    expect(Math.max(...started)).toBeLessThan(16);
  });
});

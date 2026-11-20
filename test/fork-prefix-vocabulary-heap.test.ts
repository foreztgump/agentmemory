import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("prefix vocabulary heap", () => {
  it("holds the term bound under its heap ceiling", { timeout: 60_000 }, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", "bench/fork/qdrant/prefix-vocabulary-heap.ts"], { timeout: 55_000 });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as { terms: number; maxTerms: number; heapMiB: number; ceilingMiB: number };
    expect(result.terms).toBe(result.maxTerms);
    expect(result.heapMiB).toBeLessThanOrEqual(result.ceilingMiB);
  });
});

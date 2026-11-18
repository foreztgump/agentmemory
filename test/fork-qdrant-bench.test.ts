import { describe, expect, it } from "vitest";
import { B, DIMS, docSparse, dot, K1, noisyCopy, normalize, querySparse, termId, uuidOf } from "../bench/fork/qdrant/lib.js";
import { mulberry32 } from "../bench/fork/lib/stats.js";

describe("Qdrant spike tooling", () => {
  it("noisy copies sit at the cosine the sigma predicts", () => {
    const rand = mulberry32(1);
    const src = normalize(Float32Array.from({ length: DIMS }, () => rand() - 0.5));
    const sigma = 0.0151;
    const cos = dot(src, noisyCopy(src, sigma, rand));
    expect(cos).toBeCloseTo(1 / Math.sqrt(1 + DIMS * sigma * sigma), 2);
  });

  it("weights document terms with BM25's tf and length part", () => {
    const sparse = docSparse(["alpha", "beta", "alpha"], 6);
    const norm = K1 * (1 - B + (B * 3) / 6);
    const alpha = sparse.values[sparse.indices.indexOf(termId("alpha"))];
    const beta = sparse.values[sparse.indices.indexOf(termId("beta"))];
    expect(alpha).toBeCloseTo((2 * (K1 + 1)) / (2 + norm), 10);
    expect(beta).toBeCloseTo((1 * (K1 + 1)) / (1 + norm), 10);
  });

  it("builds query vectors from the app's term extraction, one entry per term", () => {
    const sparse = querySparse("search searching search");
    expect(new Set(sparse.indices).size).toBe(sparse.indices.length);
    expect(sparse.values[sparse.indices.indexOf(termId("search"))]).toBe(1);
  });

  it("maps row numbers to UUID point ids and back", () => {
    const id = uuidOf(465_117);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.slice(-12), 16)).toBe(465_117);
  });
});

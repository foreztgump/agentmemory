// TEE-1167: the images collection can keep an image whose remove never reached
// the worker. KV.imageEmbeddings is the authority, so disk-mode search drops hits
// whose row is gone.
import { describe, expect, it, vi } from "vitest";
import { KV } from "../src/state/schema.js";
import type { ImageSearchResult } from "../src/state/search-ports.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const hit = (imageRef: string, score: number): ImageSearchResult => ({ imageRef, score, sessionId: "ses_1", updatedAt: "2026-11-19T00:00:00.000Z" });

describe("disk-mode image search", () => {
  it("does not return an image whose remove never reached the worker once its KV row is gone", async () => {
    vi.resetModules();
    const ports = await import("../src/state/search-ports.js");
    const { registerVisionSearchFunctions } = await import("../src/functions/vision-search.js");
    const base = mockKV();
    const getMany = vi.fn(async <T>(scope: string, keys: string[]) => Promise.all(keys.map((k) => base.get<T>(scope, k))));
    const kv = { ...base, getMany };
    const images = {
      put: vi.fn(),
      remove: vi.fn(),
      search: vi.fn(async () => ({ results: [hit("live.png", 0.9), hit("removed.png", 0.8)], total: 2 })),
    };
    const runtime = ports.getSearchRuntime() as unknown as Record<string, unknown>;
    runtime.images = images;
    await base.set(KV.imageEmbeddings, "live.png", { imageRef: "live.png", vector: [1, 0], modelName: "m", dimensions: 2, updatedAt: "2026-11-19T00:00:00.000Z" });
    const provider = { name: "m", dimensions: 2, embed: async () => new Float32Array([1, 0]), embedImage: async () => new Float32Array([1, 0]) };
    const sdk = mockSdk({ looseTrigger: true });
    registerVisionSearchFunctions(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::vision-search", { queryText: "diagram", topK: 5 })) as { success: boolean; results: ImageSearchResult[] };

    expect(result.success).toBe(true);
    expect(result.results.map((r) => r.imageRef)).toEqual(["live.png"]);
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany).toHaveBeenCalledWith(KV.imageEmbeddings, ["live.png", "removed.png"]);
  });
});

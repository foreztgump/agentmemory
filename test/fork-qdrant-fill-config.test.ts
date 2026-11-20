// TEE-1201: the optimizer settings that keep a fill from empty within Qdrant's
// memory limit (bench/fork/qdrant/fill-memory.ts measures the peak). Skipped
// unless QDRANT_URL is set.
import { afterAll, describe, expect, it } from "vitest";
import { QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

describe.skipIf(!QDRANT_URL)("collection optimizer settings for a fill", { timeout: 60_000 }, () => {
  const collections = ["docs", "lessons"].map((layout) => qdrantFor(`fill_config_${layout}_${process.pid}`, 16, layout === "lessons" ? "lessons" : undefined));
  afterAll(() => Promise.all(collections.map((q) => q.drop())));

  it("builds one segment at a time and caps segment size, on both text layouts", async () => {
    for (const qdrant of collections) {
      await qdrant.ensure();
      const info = await qdrant.call<{ config: { optimizer_config: Record<string, unknown> } }>("GET", qdrant.path);
      expect(info.config.optimizer_config).toMatchObject({ default_segment_number: 2, max_optimization_threads: 1, max_segment_size: 300_000 });
    }
  });
});

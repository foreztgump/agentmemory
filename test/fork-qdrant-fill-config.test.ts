// TEE-1201: the optimizer settings that keep a fill from empty within Qdrant's
// memory limit (bench/fork/qdrant/fill-memory.ts measures the peak). Skipped
// unless QDRANT_URL is set.
import { afterAll, describe, expect, it } from "vitest";
import type { Qdrant } from "../src/fork/worker/qdrant.js";
import { QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const FILL = { default_segment_number: 4, max_optimization_threads: 1, max_segment_size: 300_000 };
const optimizers = async (qdrant: Qdrant) =>
  (await qdrant.call<{ config: { optimizer_config: Record<string, unknown> } }>("GET", qdrant.path)).config.optimizer_config;

describe.skipIf(!QDRANT_URL)("collection optimizer settings for a fill", { timeout: 60_000 }, () => {
  const created: Qdrant[] = [];
  const named = (name: string, layout?: "lessons") => {
    const qdrant = qdrantFor(`fill_config_${name}_${process.pid}`, 16, layout);
    created.push(qdrant);
    return qdrant;
  };
  afterAll(() => Promise.all(created.map((q) => q.drop())));

  it("builds one segment at a time, caps segment size and targets 4 segments, on both text layouts", async () => {
    for (const qdrant of [named("docs"), named("lessons", "lessons")]) {
      await qdrant.ensure();
      expect(await optimizers(qdrant)).toMatchObject(FILL);
    }
  });
});

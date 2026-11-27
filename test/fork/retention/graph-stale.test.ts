import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { markGraphStale } from "../../../src/fork/retention/graph-stale.js";
import { initializeGraphIndex } from "../../../src/state/graph-retrieval-index.js";
import { KV } from "../../../src/state/schema.js";
import type { GraphEdge, GraphNode } from "../../../src/types.js";
import { createGraphIndexState } from "../../helpers/graph-index-state.js";

const date = "2026-10-14T00:00:00.000Z";
const node = (id: string, sources: string[]): GraphNode => ({ id, name: id, type: "concept", properties: {}, sourceObservationIds: sources, createdAt: date });
const edge = (id: string, sources: string[]): GraphEdge => ({ id, sourceNodeId: "a", targetNodeId: "b", type: "related_to", weight: 1, sourceObservationIds: sources, createdAt: date });

async function ready() {
  const state = createGraphIndexState();
  await initializeGraphIndex(state.kv, { status: "ready" });
  return state;
}

describe("markGraphStale", () => {
  it("marks nodes and edges that cite an id, leaves the rest, and is idempotent", async () => {
    const { kv } = await ready();
    await kv.set(KV.graphNodes, "a", node("a", ["obs_1"]));
    await kv.set(KV.graphNodes, "b", node("b", ["obs_2"]));
    await kv.set(KV.graphEdges, "ab", edge("ab", ["obs_1", "obs_2"]));
    await kv.set(KV.graphEdges, "cd", edge("cd", ["obs_3"]));

    expect(await markGraphStale(kv, ["obs_1"])).toMatchObject({ nodes: 1, edges: 1, marked: 2, deferred: false });
    expect(await markGraphStale(kv, ["obs_1"])).toMatchObject({ marked: 0, deferred: false });

    expect((await kv.get<GraphNode>(KV.graphNodes, "a"))?.stale).toBe(true);
    expect((await kv.get<GraphNode>(KV.graphNodes, "a"))?.updatedAt).toBeDefined();
    expect((await kv.get<GraphNode>(KV.graphNodes, "b"))?.stale).toBeUndefined();
    expect((await kv.get<GraphEdge>(KV.graphEdges, "ab"))?.stale).toBe(true);
    expect((await kv.get<GraphEdge>(KV.graphEdges, "cd"))?.stale).toBeUndefined();
  });

  it("handles many ids and many citing items in bounded batches", async () => {
    const { kv } = await ready();
    const ids = Array.from({ length: 70 }, (_, n) => `obs_${n}`);
    for (let n = 0; n < 150; n++) await kv.set(KV.graphNodes, `hub_${n}`, node(`hub_${n}`, ["obs_5"]));
    for (const id of ids) await kv.set(KV.graphNodes, `n_${id}`, node(`n_${id}`, [id]));
    await kv.set(KV.graphNodes, "keep", node("keep", ["obs_other"]));

    const result = await markGraphStale(kv, [...ids, "obs_5"]);

    expect(result).toMatchObject({ nodes: 220, deferred: false });
    expect((await kv.get<GraphNode>(KV.graphNodes, "hub_149"))?.stale).toBe(true);
    expect((await kv.get<GraphNode>(KV.graphNodes, "keep"))?.stale).toBeUndefined();
  });

  it("does nothing, and is not deferred, when the stack has no graph index", async () => {
    const { kv } = createGraphIndexState();
    expect(await markGraphStale(kv, ["obs_1"])).toEqual({ nodes: 0, edges: 0, marked: 0, ids: [], deferred: false });
  });

  it("defers, and changes nothing, when the index exists but is not ready", async () => {
    const state = createGraphIndexState();
    await initializeGraphIndex(state.kv, { status: "building" });
    expect(await markGraphStale(state.kv, ["obs_1"])).toMatchObject({ marked: 0, deferred: true });
  });

  it("defers an id the index cannot hold, and still marks the others", async () => {
    const { kv } = await ready();
    await kv.set(KV.graphNodes, "a", node("a", ["obs_1"]));
    const huge = "x".repeat(2000);
    expect(await markGraphStale(kv, [huge, "obs_1"])).toMatchObject({ nodes: 1, deferred: true });
    expect((await kv.get<GraphNode>(KV.graphNodes, "a"))?.stale).toBe(true);
  });

  it("discards a discovery the index changed under, and marks on the retry", async () => {
    const { kv, intercept } = await ready();
    await kv.set(KV.graphNodes, "a", node("a", ["obs_1"]));
    let changed = false;
    intercept(async (id, payload) => {
      if (!changed && id === "state::get" && payload.scope === KV.graphRetrievalData && payload.key.includes(":root:")) {
        changed = true;
        await kv.set(KV.graphNodes, "late", node("late", ["obs_1"]));
      }
    });

    const result = await markGraphStale(kv, ["obs_1"]);

    expect(result).toMatchObject({ nodes: 2, deferred: false });
    expect((await kv.get<GraphNode>(KV.graphNodes, "late"))?.stale).toBe(true);
  });
});

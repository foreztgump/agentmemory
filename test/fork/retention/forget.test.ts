import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

const decrementImageRef = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../../src/functions/image-refs.js", () => ({ decrementImageRef }));

import { displace } from "../../../src/fork/retention/move.js";
import { registerRetention } from "../../../src/fork/retention/register.js";
import { restoreItems } from "../../../src/fork/retention/restore.js";
import { RETENTION_KV, itemKey } from "../../../src/fork/retention/scopes.js";
import type { DemoteRecord, ItemRef, RunId } from "../../../src/fork/retention/types.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import { queryGraphIndex } from "../../../src/functions/graph-index-query.js";
import { registerRememberFunction } from "../../../src/functions/remember.js";
import { getSearchIndex, setVectorIndex } from "../../../src/functions/search.js";
import { KV } from "../../../src/state/schema.js";
import { currentAuditScope } from "../../helpers/mocks.js";
import { initializeGraphIndex } from "../../../src/state/graph-retrieval-index.js";
import type { SearchRuntime } from "../../../src/state/search-ports.js";
import { VectorIndex } from "../../../src/state/vector-index.js";
import type { AuditEntry, GraphEdge, GraphNode, Session } from "../../../src/types.js";
import {
  NOW, RUN, candidate, captureKeyOf, keywordHits, liveRow, memory, observation, openRun, rig, seedMemory, seedObservation, seedSeal, seedSession, vec, vectorHits,
} from "./move-fixtures.js";

const RUN2 = "ret_s9b" as RunId;
const obsRef = (id: string, sessionId = "ses_1"): ItemRef => ({ kind: "observation", sessionId, id });
const memRef = (id: string): ItemRef => ({ kind: "memory", id });

interface ForgetResult {
  success: boolean;
  deleted: number;
  notFound: string[];
  failed: number;
  cleanupFailed: number;
  cleanupFailures?: Array<{ id: string; error: string }>;
}

const date = "2026-10-14T00:00:00.000Z";
const node = (id: string, sources: string[], over: Partial<GraphNode> = {}): GraphNode => ({
  id, name: `name ${id}`, type: "concept", properties: {}, sourceObservationIds: sources, createdAt: date, ...over,
});
const edge = (id: string, from: string, to: string, sources: string[]): GraphEdge => ({
  id, sourceNodeId: from, targetNodeId: to, type: "related_to", weight: 1, sourceObservationIds: sources, createdAt: date,
});

async function setup(opts: { graph?: boolean; unwrapped?: boolean } = {}) {
  getSearchIndex().clear();
  const vectorIndex = new VectorIndex();
  setVectorIndex(vectorIndex);
  const runtime = { backend: "memory", keyword: getSearchIndex(), vector: vectorIndex, openPersistence: () => ({ scheduleSave: () => {} }) } as unknown as SearchRuntime;
  const r = rig(() => runtime);
  (r as { runtime: unknown }).runtime = runtime;
  if (opts.graph !== false) await initializeGraphIndex(r.kv, { status: "ready" });
  registerRememberFunction(r.h.sdk as never, opts.unwrapped ? r.h.kv : r.kv);
  const forget = (payload: Record<string, unknown>) => r.h.call("mem::forget", payload) as Promise<ForgetResult>;
  const graph = async (query: string) => (await queryGraphIndex(r.kv, { query })).nodes.map((n) => n.id).sort();
  const stale = async (scope: string, id: string) => (await r.kv.get<{ stale?: boolean }>(scope, id))?.stale === true;
  const heldBy = async (runId: RunId) => (await r.runs.get(runId))?.held;
  return { r, runtime, vectorIndex, forget, graph, stale, heldBy };
}

beforeEach(() => decrementImageRef.mockClear());
afterEach(() => resetSummarizeVeto());

describe("R10: forget removes the data now and marks dependent graph items stale", () => {
  it("removes a cited observation from KV and both indexes at once, and stales every graph item that cites it", async () => {
    const { r, forget, graph, stale, vectorIndex } = await setup();
    await seedObservation(r, observation("obs_1"), { seed: 1 });
    await seedObservation(r, observation("obs_2"), { seed: 2 });
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_1"]));
    await r.kv.set(KV.graphNodes, "n2", node("n2", ["obs_2"]));
    await r.kv.set(KV.graphNodes, "n3", node("n3", ["obs_2", "obs_1"]));
    await r.kv.set(KV.graphEdges, "e1", edge("e1", "n1", "n2", ["obs_1"]));
    await r.kv.set(KV.graphEdges, "e2", edge("e2", "n2", "n3", ["obs_2"]));
    expect(await graph("name")).toEqual(["n1", "n2", "n3"]);
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1", "obs_2"]);

    const result = await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });

    expect(result).toMatchObject({ success: true, deleted: 1, notFound: [] });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await keywordHits(r, "zebra")).toEqual(["obs_2"]);
    expect(await vectorHits(r, 1)).not.toContain("obs_1");
    expect(vectorIndex.has("obs_1")).toBe(false);
    expect(await stale(KV.graphNodes, "n1")).toBe(true);
    expect(await stale(KV.graphNodes, "n3")).toBe(true);
    expect(await stale(KV.graphEdges, "e1")).toBe(true);
    expect(await stale(KV.graphNodes, "n2")).toBe(false);
    expect(await stale(KV.graphEdges, "e2")).toBe(false);
    expect(await graph("name")).toEqual(["n2"]);
  });

  it("removes a forgotten memory from KV and both indexes at once, and leaves the graph items of its source observations alone", async () => {
    const { r, forget, graph, stale, vectorIndex } = await setup();
    await seedObservation(r, observation("obs_1"), { seed: 1 });
    await seedMemory(r, memory("mem_1", { isLatest: true, sourceObservationIds: ["obs_1"] }), { seed: 3 });
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_1"]));
    expect(await keywordHits(r, "okapi")).toEqual(["mem_1"]);

    const result = await forget({ memoryId: "mem_1" });

    expect(result).toMatchObject({ success: true, deleted: 1, notFound: [] });
    expect(await liveRow(r, KV.memories, "mem_1")).toBeNull();
    expect(await keywordHits(r, "okapi")).toEqual([]);
    expect(vectorIndex.has("mem_1")).toBe(false);
    expect(await stale(KV.graphNodes, "n1")).toBe(false);
    expect(await graph("name")).toEqual(["n1"]);
  });

  it("runs with retention registered but off, and with it never registered", async () => {
    const { r, forget } = await setup();
    registerRetention(r.h.sdk as never, r.kv);
    await seedObservation(r, observation("obs_1"), { seed: 1 });
    expect(await forget({ sessionId: "ses_1", observationIds: ["obs_1"] })).toMatchObject({ success: true, deleted: 1 });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toBeNull();
  });

  it("forgets without a graph index, and records no graph work", async () => {
    const { r, forget } = await setup({ graph: false });
    await seedObservation(r, observation("obs_1"), { seed: 1 });
    expect(await forget({ sessionId: "ses_1", observationIds: ["obs_1"] })).toMatchObject({ success: true, deleted: 1, cleanupFailed: 0 });
    const audits = await r.kv.list<AuditEntry>(currentAuditScope());
    expect(audits.map((a) => a.details.change)).not.toContain("graph items marked stale by forget");
  });

  it("audits the graph items it marked stale", async () => {
    const { r, forget } = await setup();
    await seedObservation(r, observation("obs_1"));
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_1"]));
    await r.kv.set(KV.graphEdges, "e1", edge("e1", "n1", "n1", ["obs_1"]));
    await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });
    const rows = await r.kv.list<AuditEntry>(currentAuditScope());
    const graphAudit = rows.find((a) => a.details.change === "graph items marked stale by forget");
    expect(graphAudit).toMatchObject({ operation: "forget", functionId: "mem::forget", targetIds: expect.arrayContaining(["n1", "e1"]), details: { nodes: 1, edges: 1 } });
  });
});

describe("bare observation ids: graph citations carry no session", () => {
  it("marks the graph items of a shared id stale when one session's row is forgotten, and leaves the other session's row and vault entry alone", async () => {
    const { r, forget, stale } = await setup();
    await seedObservation(r, observation("obs_x", "ses_1"), { seed: 1 });
    const other = await seedObservation(r, observation("obs_x", "ses_2", { title: "other title" }));
    await seedSeal(r, "ses_2", 1);
    await openRun(r, RUN, 0);
    await displace(r.deps, r.vault, RUN, candidate("O", other, (await r.kv.get(RETENTION_KV.seals, "ses_2"))!));
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 1 });
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_x"]));
    await r.kv.set(KV.graphNodes, "n2", node("n2", ["obs_y"]));

    await forget({ sessionId: "ses_1", observationIds: ["obs_x"] });

    expect(await stale(KV.graphNodes, "n1")).toBe(true);
    expect(await stale(KV.graphNodes, "n2")).toBe(false);
    expect(await r.vault.get(RUN, obsRef("obs_x", "ses_2"))).not.toBeNull();
    expect(await r.vault.locate(obsRef("obs_x", "ses_2"))).toEqual({ runId: RUN, stage: "O" });
    expect((await r.runs.get(RUN))?.held).toBe(1);
  });

  it("does not take the id's graph items for the other session's live row: a shared id is stale for both", async () => {
    const { r, forget, stale } = await setup();
    await seedObservation(r, observation("obs_x", "ses_1"));
    await seedObservation(r, observation("obs_x", "ses_2"));
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_x"]));
    await forget({ sessionId: "ses_1", observationIds: ["obs_x"] });
    expect(await stale(KV.graphNodes, "n1")).toBe(true);
    expect(await liveRow(r, KV.observations("ses_2"), "obs_x")).not.toBeNull();
  });
});

describe("R11: forget leaves each session's count equal to its stored rows", () => {
  const rowsOf = async (r: Awaited<ReturnType<typeof setup>>["r"], sessionId: string) => (await r.kv.list(KV.observations(sessionId))).length;
  const countOf = async (r: Awaited<ReturnType<typeof setup>>["r"], sessionId: string) => (await r.kv.get<Session>(KV.sessions, sessionId))?.observationCount;

  it("holds on the stats-wrapped store the stack runs on", async () => {
    const { r, forget } = await setup();
    for (const id of ["obs_1", "obs_2", "obs_3"]) await seedObservation(r, observation(id));
    await seedObservation(r, observation("obs_9", "ses_2"));

    await forget({ sessionId: "ses_1", observationIds: ["obs_1", "obs_2"] });

    expect(await countOf(r, "ses_1")).toBe(await rowsOf(r, "ses_1"));
    expect(await countOf(r, "ses_1")).toBe(1);
    expect(await countOf(r, "ses_2")).toBe(1);
  });

  it("holds on a store without row stats, and repairs a count that had drifted", async () => {
    const { r, forget } = await setup({ unwrapped: true });
    for (const id of ["obs_1", "obs_2", "obs_3"]) await seedObservation(r, observation(id));
    await r.kv.update(KV.sessions, "ses_1", [{ type: "set", path: "observationCount", value: 9 }]);

    await forget({ sessionId: "ses_1", observationIds: ["obs_1", "obs_2"] });

    expect(await countOf(r, "ses_1")).toBe(await rowsOf(r, "ses_1"));
    expect(await countOf(r, "ses_1")).toBe(1);
  });

  it("recounts after a forget of a row that retention had moved, so the count matches the live rows", async () => {
    const { r, forget } = await setup();
    const row = await seedObservation(r, observation("obs_1"));
    await seedObservation(r, observation("obs_2"));
    const seal = await seedSeal(r, "ses_1", 2);
    await openRun(r, RUN, 0);
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    await r.kv.update(KV.sessions, "ses_1", [{ type: "set", path: "observationCount", value: 5 }]);

    await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });

    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(1);
  });
});

describe("forget during grace erases the vault copy", () => {
  it("erases a stage O entry: forget finds the item, nothing can restore it, held is lowered, graph items go stale", async () => {
    const { r, forget, stale, heldBy } = await setup();
    const row = await seedObservation(r, observation("obs_1"), { seed: 1, captureKey: captureKeyOf(1) });
    await seedObservation(r, observation("obs_2"), { seed: 2 });
    const seal = await seedSeal(r, "ses_1", 2);
    await openRun(r, RUN, 0);
    expect((await displace(r.deps, r.vault, RUN, candidate("O", row, seal))).moved).toBe(true);
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 1 });
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_1"]));

    const result = await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });

    expect(result).toMatchObject({ success: true, deleted: 1, notFound: [], cleanupFailed: 0 });
    expect(await r.vault.get(RUN, obsRef("obs_1"))).toBeNull();
    expect(await r.vault.locate(obsRef("obs_1"))).toBeNull();
    expect(await heldBy(RUN)).toBe(0);
    expect(await stale(KV.graphNodes, "n1")).toBe(true);
    expect(await restoreItems(r.deps, [obsRef("obs_1")], "test")).toMatchObject({ restored: 0 });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await keywordHits(r, "zebra")).toEqual(["obs_2"]);
  });

  it("erases both claims of a trim-then-O stacked item, lowering both runs", async () => {
    const { r, forget, heldBy } = await setup();
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await openRun(r, RUN, 0);
    await openRun(r, RUN2, 0);
    expect((await displace(r.deps, r.vault, RUN, candidate("T", row, seal))).moved).toBe(true);
    const trimmed = (await r.kv.get(KV.observations("ses_1"), "obs_1"))!;
    expect((await displace(r.deps, r.vault, RUN2, candidate("O", trimmed as never, seal))).moved).toBe(true);
    for (const id of [RUN, RUN2]) await r.runs.save({ ...(await r.runs.get(id))!, held: 1 });
    expect(await r.vault.locate(obsRef("obs_1"))).toMatchObject({ runId: RUN2, under: { runId: RUN } });

    const result = await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });

    expect(result).toMatchObject({ deleted: 1, notFound: [] });
    expect(await r.vault.get(RUN, obsRef("obs_1"))).toBeNull();
    expect(await r.vault.get(RUN2, obsRef("obs_1"))).toBeNull();
    expect(await r.vault.locate(obsRef("obs_1"))).toBeNull();
    expect([await heldBy(RUN), await heldBy(RUN2)]).toEqual([0, 0]);
    expect(await restoreItems(r.deps, [obsRef("obs_1")], "test")).toMatchObject({ restored: 0, keptLive: 0 });
  });

  it("erases the trim entry of a row that is still live when the row is forgotten", async () => {
    const { r, forget, heldBy } = await setup();
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await openRun(r, RUN, 0);
    await displace(r.deps, r.vault, RUN, candidate("T", row, seal));
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 1 });

    expect(await forget({ sessionId: "ses_1", observationIds: ["obs_1"] })).toMatchObject({ deleted: 1, notFound: [] });

    expect(await r.vault.get(RUN, obsRef("obs_1"))).toBeNull();
    expect(await r.vault.locate(obsRef("obs_1"))).toBeNull();
    expect(await heldBy(RUN)).toBe(0);
  });

  it("erases a memory entry (stage X) and a stage S entry", async () => {
    const { r, forget, heldBy } = await setup();
    const expired = await seedMemory(r, memory("mem_x"), { seed: 4 });
    const old = await seedMemory(r, memory("mem_s", { isLatest: false, forgetAfter: undefined }));
    await openRun(r, RUN, 0);
    expect((await displace(r.deps, r.vault, RUN, candidate("X", expired))).moved).toBe(true);
    expect((await displace(r.deps, r.vault, RUN, candidate("S", old))).moved).toBe(true);
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 2 });

    const first = await forget({ memoryId: "mem_x" });

    expect(first).toMatchObject({ success: true, deleted: 1, notFound: [] });
    expect(await r.vault.get(RUN, memRef("mem_x"))).toBeNull();
    expect(await r.vault.locate(memRef("mem_x"))).toBeNull();
    expect(await heldBy(RUN)).toBe(1);
    expect(await restoreItems(r.deps, [memRef("mem_x")], "test")).toMatchObject({ restored: 0 });
    expect(await liveRow(r, KV.memories, "mem_x")).toBeNull();
    expect(await keywordHits(r, "okapi")).toEqual([]);

    expect(await forget({ memoryId: "mem_s" })).toMatchObject({ deleted: 1, notFound: [] });
    expect(await heldBy(RUN)).toBe(0);
  });

  it("deletes the demote record of a forgotten memory", async () => {
    const { r, forget } = await setup();
    await seedMemory(r, memory("mem_c", { forgetAfter: undefined }));
    const record: DemoteRecord = { memoryId: "mem_c", runId: RUN, demotedAt: NOW.toISOString(), reason: { stage: "C", ageActiveDays: 400, note: "cold" }, vector: "AAAA" };
    await r.kv.set(RETENTION_KV.demoted, "mem_c", record);

    expect(await forget({ memoryId: "mem_c" })).toMatchObject({ deleted: 1 });

    expect(await r.kv.get(RETENTION_KV.demoted, "mem_c")).toBeNull();
  });

  it("releases the image reference a vault-only observation still holds, once", async () => {
    const { r, forget } = await setup();
    const row = await seedObservation(r, observation("obs_1", "ses_1", { imageData: "/img/a.png" }));
    const seal = await seedSeal(r, "ses_1", 1);
    await openRun(r, RUN, 0);
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 1 });

    await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });
    await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });

    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(decrementImageRef).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/img/a.png");
  });

  it("does not release the image of a live row twice: forget's own cleanup owns it", async () => {
    const { r, forget } = await setup();
    await seedObservation(r, observation("obs_1", "ses_1", { imageData: "/img/b.png" }));
    await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });
    expect(decrementImageRef).toHaveBeenCalledTimes(1);
  });

  it("leaves an id that exists nowhere in notFound, and touches no vault entry of a different id", async () => {
    const { r, forget, heldBy } = await setup();
    const row = await seedObservation(r, observation("obs_1"));
    const seal = await seedSeal(r, "ses_1", 1);
    await openRun(r, RUN, 0);
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 1 });

    expect(await forget({ sessionId: "ses_1", observationIds: ["obs_nope"], memoryId: "mem_nope" })).toMatchObject({ deleted: 0, notFound: ["mem_nope", "obs_nope"] });

    expect(await r.vault.get(RUN, obsRef("obs_1"))).not.toBeNull();
    expect(await heldBy(RUN)).toBe(1);
    expect(await r.kv.get(RETENTION_KV.items, itemKey(obsRef("obs_nope")))).toBeNull();
  });

  it("reports a failure in the retention cleanup as cleanupFailed and still deletes the row", async () => {
    const { r, forget } = await setup();
    await seedObservation(r, observation("obs_1"));
    const get = r.kv.get.bind(r.kv);
    r.kv.get = (async (scope: string, key: string) => {
      if (scope === RETENTION_KV.items) throw new Error("state store down");
      return get(scope, key);
    }) as never;

    const result = await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });

    expect(result).toMatchObject({ deleted: 1, cleanupFailed: 1 });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toBeNull();
  });
});

describe("forgetting a whole session", () => {
  it("clears every row's retention copies and graph items in one pass", async () => {
    const { r, forget, stale } = await setup();
    for (let n = 1; n <= 40; n++) await seedObservation(r, observation(`obs_${n}`), { seed: n });
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_17"]));
    await r.kv.set(KV.graphNodes, "n2", node("n2", ["other"]));

    const result = await forget({ sessionId: "ses_1" });

    expect(result).toMatchObject({ success: true });
    expect((await r.kv.list(KV.observations("ses_1"))).length).toBe(0);
    expect(await stale(KV.graphNodes, "n1")).toBe(true);
    expect(await stale(KV.graphNodes, "n2")).toBe(false);
    expect(await vectorHits(r, 17)).toEqual([]);
  });
});

describe("ocr round: forget reports what it erased and what it could not", () => {
  const displaced = async (r: Awaited<ReturnType<typeof setup>>["r"], id: string, runId: RunId = RUN, sessionId = "ses_1") => {
    const row = await seedObservation(r, observation(id, sessionId));
    const seal = (await r.kv.get<never>(RETENTION_KV.seals, sessionId)) ?? (await seedSeal(r, sessionId, 4));
    expect((await displace(r.deps, r.vault, runId, candidate("O", row, seal))).moved).toBe(true);
  };
  const failReads = (r: Awaited<ReturnType<typeof setup>>["r"], scope: string, key?: string) => {
    const get = r.kv.get.bind(r.kv);
    r.kv.get = (async (s: string, k: string) => {
      if (s === scope && (key === undefined || k === key)) throw new Error("state store down");
      return get(s, k);
    }) as never;
  };

  it("lists an id the request names twice as erased, not as not found", async () => {
    const { r, forget } = await setup();
    await displaced(r, "obs_1");
    await openRun(r, RUN, 1);

    const result = await forget({ sessionId: "ses_1", observationIds: ["obs_1", "obs_1"] });

    expect(result).toMatchObject({ deleted: 1, notFound: [] });
  });

  it("erases the other refs and still marks graph items stale when one ref cannot be read, and reports that ref", async () => {
    const { r, forget, stale, heldBy } = await setup();
    await openRun(r, RUN, 0);
    for (const id of ["obs_1", "obs_2", "obs_3"]) await displaced(r, id);
    await seedObservation(r, observation("obs_4"));
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 3 });
    for (const [id, sources] of [["n1", "obs_1"], ["n2", "obs_2"], ["n3", "obs_3"], ["n4", "obs_4"]]) await r.kv.set(KV.graphNodes, id, node(id, [sources]));
    failReads(r, RETENTION_KV.items, itemKey(obsRef("obs_2")));

    const result = await forget({ sessionId: "ses_1", observationIds: ["obs_1", "obs_2", "obs_3", "obs_4"] });

    expect(result).toMatchObject({ deleted: 3, notFound: ["obs_2"], cleanupFailed: 1, cleanupFailures: [{ id: "obs_2", error: "cleanup_failed" }] });
    expect(await r.kv.get(RETENTION_KV.vault(RUN), itemKey(obsRef("obs_1")))).toBeNull();
    expect(await r.kv.get(RETENTION_KV.vault(RUN), itemKey(obsRef("obs_3")))).toBeNull();
    expect(await r.kv.get(RETENTION_KV.vault(RUN), itemKey(obsRef("obs_2")))).not.toBeNull();
    expect(await heldBy(RUN)).toBe(1);
    expect(await stale(KV.graphNodes, "n1")).toBe(true);
    expect(await stale(KV.graphNodes, "n3")).toBe(true);
    expect(await stale(KV.graphNodes, "n4")).toBe(true);
    expect(await stale(KV.graphNodes, "n2")).toBe(false);
  });

  it("writes the graph audit entry and reports the session when the recount fails", async () => {
    const { r, forget, stale } = await setup({ unwrapped: true });
    await seedObservation(r, observation("obs_1"));
    await seedObservation(r, observation("obs_2"));
    await r.kv.update(KV.sessions, "ses_1", [{ type: "set", path: "observationCount", value: 9 }]);
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_1"]));
    const update = r.h.kv.update.bind(r.h.kv);
    r.h.kv.update = (async (scope: string, ...rest: unknown[]) => {
      if (scope === KV.sessions) throw new Error("state store down");
      return (update as (...a: unknown[]) => unknown)(scope, ...rest);
    }) as never;

    const result = await forget({ sessionId: "ses_1", observationIds: ["obs_1"] });

    expect(result).toMatchObject({ deleted: 1, cleanupFailed: 1, cleanupFailures: [{ id: "retention:recount:ses_1" }] });
    expect(await stale(KV.graphNodes, "n1")).toBe(true);
    const audits = await r.kv.list<AuditEntry>(currentAuditScope());
    expect(audits.map((a) => a.details.change)).toContain("graph items marked stale by forget");
  });

  it("audits a deferred graph mark when the index is building", async () => {
    const r0 = await setup({ graph: false });
    await initializeGraphIndex(r0.r.kv, { status: "building" });
    await seedObservation(r0.r, observation("obs_1"));
    await r0.forget({ sessionId: "ses_1", observationIds: ["obs_1"] });
    const audits = await r0.r.kv.list<AuditEntry>(currentAuditScope());
    expect(audits.find((a) => a.details.change === "graph items marked stale by forget")).toMatchObject({ details: { deferred: true, nodes: 0 } });
  });
});

describe("ocr round: concurrent forgets leave the session count equal to the rows", () => {
  it("keeps the count right when two forgets of one session recount at once", async () => {
    const { r, forget } = await setup({ unwrapped: true });
    for (const id of ["obs_1", "obs_2", "obs_3", "obs_4"]) await seedObservation(r, observation(id));
    await r.kv.update(KV.sessions, "ses_1", [{ type: "set", path: "observationCount", value: 9 }]);
    const update = r.h.kv.update.bind(r.h.kv);
    let first = true;
    r.h.kv.update = (async (scope: string, ...rest: unknown[]) => {
      if (scope === KV.sessions && first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return (update as (...a: unknown[]) => unknown)(scope, ...rest);
    }) as never;

    await Promise.all([forget({ sessionId: "ses_1", observationIds: ["obs_1"] }), forget({ sessionId: "ses_1", observationIds: ["obs_2"] })]);

    const rows = (await r.kv.list(KV.observations("ses_1"))).length;
    expect(rows).toBe(2);
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(rows);
  });
});

describe("ocr round: forgetting a whole session erases its displaced rows", () => {
  it("leaves nothing restorable, lowers each run's held, and erases vaulted, stacked and live rows alike", async () => {
    const { r, forget, stale, heldBy } = await setup();
    await openRun(r, RUN, 0);
    await openRun(r, RUN2, 0);
    const one = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const two = await seedObservation(r, observation("obs_2"), { seed: 2 });
    await seedObservation(r, observation("obs_3"), { seed: 3 });
    await seedObservation(r, observation("obs_4"), { seed: 4 });
    const other = await seedObservation(r, observation("obs_1", "ses_2", { title: "other" }));
    const seal = await seedSeal(r, "ses_1", 4);
    const otherSeal = await seedSeal(r, "ses_2", 1);
    expect((await displace(r.deps, r.vault, RUN, candidate("O", one, seal))).moved).toBe(true);
    expect((await displace(r.deps, r.vault, RUN, candidate("T", two, seal))).moved).toBe(true);
    const trimmed = (await r.kv.get(KV.observations("ses_1"), "obs_2"))!;
    expect((await displace(r.deps, r.vault, RUN2, candidate("O", trimmed as never, seal))).moved).toBe(true);
    expect((await displace(r.deps, r.vault, RUN2, candidate("O", other, otherSeal))).moved).toBe(true);
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 2 });
    await r.runs.save({ ...(await r.runs.get(RUN2))!, held: 2 });
    await r.kv.set(KV.graphNodes, "n1", node("n1", ["obs_1"]));
    await r.kv.set(KV.graphNodes, "n2", node("n2", ["obs_2"]));
    await r.kv.set(KV.graphNodes, "n3", node("n3", ["obs_3"]));
    r.h.stateOps.length = 0;

    const result = await forget({ sessionId: "ses_1" });

    expect(result).toMatchObject({ success: true, notFound: [], cleanupFailed: 0 });
    expect(result.deleted).toBe(2 + 2 + 1);
    for (const id of ["obs_1", "obs_2"]) {
      expect(await r.vault.get(RUN, obsRef(id))).toBeNull();
      expect(await r.vault.get(RUN2, obsRef(id))).toBeNull();
      expect(await r.vault.locate(obsRef(id))).toBeNull();
    }
    expect(await restoreItems(r.deps, [obsRef("obs_1"), obsRef("obs_2"), obsRef("obs_3")], "test")).toMatchObject({ restored: 0, keptLive: 0 });
    expect([await heldBy(RUN), await heldBy(RUN2)]).toEqual([0, 1]);
    expect(await r.vault.get(RUN2, obsRef("obs_1", "ses_2"))).not.toBeNull();
    expect(await r.vault.locate(obsRef("obs_1", "ses_2"))).toEqual({ runId: RUN2, stage: "O" });
    expect((await r.kv.list(KV.observations("ses_1"))).length).toBe(0);
    for (const id of ["n1", "n2", "n3"]) expect(await stale(KV.graphNodes, id)).toBe(true);
    expect(await keywordHits(r, "zebra")).toEqual([]);
    expect(r.h.stateOps.filter((op) => op.startsWith("state::list ") && op.includes("mem:retention:vault:"))).toEqual([]);
  });

  it("keeps notFound right when the session row is gone but its displaced rows are erased", async () => {
    const { r, forget } = await setup();
    await openRun(r, RUN, 0);
    const row = await seedObservation(r, observation("obs_1"));
    const seal = await seedSeal(r, "ses_1", 1);
    expect((await displace(r.deps, r.vault, RUN, candidate("O", row, seal))).moved).toBe(true);
    await r.runs.save({ ...(await r.runs.get(RUN))!, held: 1 });
    await r.kv.delete(KV.sessions, "ses_1");

    const result = await forget({ sessionId: "ses_1" });

    expect(result).toMatchObject({ deleted: 1, notFound: ["ses_1"] });
    expect(await r.vault.get(RUN, obsRef("obs_1"))).toBeNull();
  });
});

void vec;

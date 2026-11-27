import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { registerRememberFunction } from "../../../src/functions/remember.js";
import { getSearchIndex } from "../../../src/functions/search.js";
import { initializeGraphIndex, reconcileGraphIndexRecord } from "../../../src/state/graph-retrieval-index.js";
import { displace } from "../../../src/fork/retention/move.js";
import { proveChain, successorIndex } from "../../../src/fork/retention/plan.js";
import { RETENTION_PAGE_SIZE } from "../../../src/fork/retention/settings.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { KV } from "../../../src/state/schema.js";
import type { Memory } from "../../../src/types.js";
import { memory, NOW, observation, openRun, RUN, rig, seedMemory, seedSession } from "./move-fixtures.js";
import {
  candidatesOf, clockOf, judgeAll, liveIds, pin, planAll, planAndMove, sealedSession, ZERO,
} from "./plan-fixtures.js";

const keyOf = (c: { ref: { kind: string; id: string } }) => c.ref.id;

describe("R2, plan half: only a digested session is planned", () => {
  async function fourSessions() {
    const r = rig();
    const rows = {
      summarized: await sealedSession(r, "ses_summarized", 3),
      noSummary: await sealedSession(r, "ses_nosummary", 3, { summary: "none" }),
      active: await sealedSession(r, "ses_active", 3, { status: "active" }),
      stale: await sealedSession(r, "ses_stale", 3, { summary: "stale" }),
    };
    return { r, rows };
  }

  it("yields candidates from the summarized session only, with zero windows", async () => {
    const { r } = await fourSessions();
    const planned = candidatesOf(await planAll(r, ZERO));
    expect(planned.map((c) => c.stage)).toEqual(["O", "O", "O"]);
    expect(planned.map((c) => c.ref.kind === "observation" && c.ref.sessionId)).toEqual(["ses_summarized", "ses_summarized", "ses_summarized"]);
  });

  it("soft-deletes only the summarized session's rows when the plan is moved", async () => {
    const { r } = await fourSessions();
    const { cleared } = await planAndMove(r);
    expect(cleared).toHaveLength(3);
    expect(await liveIds(r, "ses_summarized")).toEqual([]);
    for (const id of ["ses_nosummary", "ses_active", "ses_stale"]) expect(await liveIds(r, id)).toHaveLength(3);
    expect(await r.kv.listKeys(RETENTION_KV.vault(RUN))).toHaveLength(3);
  });

  it("trims only the summarized session's rows when only the trim window has passed", async () => {
    const { r } = await fourSessions();
    const windows = { ...ZERO, observationDays: 9999 };
    await openRun(r);
    const planned = candidatesOf(await planAll(r, windows));
    expect(planned.map((c) => c.stage)).toEqual(["T", "T", "T"]);
    const { cleared } = await judgeAll(r, windows, planned);
    for (const item of cleared) expect((await displace(r.deps, r.vault, RUN, item)).moved).toBe(true);
    const source = async (session: string, id: string) => (await r.kv.get<{ source?: { truncated: boolean } }>(KV.observations(session), id))?.source?.truncated;
    expect(await source("ses_summarized", "ses_summarized_o0")).toBe(true);
    expect(await source("ses_stale", "ses_stale_o0")).toBe(false);
    expect(await liveIds(r, "ses_summarized")).toHaveLength(3);
  });

  it("plans a trimmed row once: a row past both windows is one stage O candidate", async () => {
    const r = rig();
    await sealedSession(r, "ses_a", 1);
    const planned = candidatesOf(await planAll(r, { ...ZERO, trimDays: 0 }));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.stage).toBe("O");
  });

  it("plans nothing inside the window, and skips a source that is already truncated", async () => {
    const r = rig();
    const recent = observation("recent", "ses_a", { timestamp: "2026-08-20T09:00:00.000Z" });
    const bare = observation("bare", "ses_a", { source: { hookType: "post_tool_use", originalBytes: 1, truncated: true } });
    await sealedSession(r, "ses_a", 0, { rows: [recent, bare] });
    const plan = async (windows: typeof ZERO) => candidatesOf(await planAll(r, windows)).map((c) => [c.stage, keyOf(c)]);
    expect(await plan({ ...ZERO, trimDays: 9999, observationDays: 9999 })).toEqual([]);
    expect(await plan({ ...ZERO, trimDays: 0, observationDays: 9999 })).toEqual([["T", "recent"]]);
    expect(await plan({ ...ZERO, trimDays: 9999, observationDays: 0 })).toEqual([["O", "bare"], ["O", "recent"]]);
  });
});

describe("R5: each protected item survives an enforcing plan-and-move, under its signal", () => {
  it("lists the six items under their signals and moves only the control", async () => {
    const r = rig();
    const rows = [
      observation("o_pinned", "ses_p"), observation("o_cited", "ses_p"), observation("o_important", "ses_p", { importance: 9 }), observation("o_control", "ses_p"),
    ];
    await sealedSession(r, "ses_p", 0, { rows });
    await pin(r, { kind: "observation", sessionId: "ses_p", id: "o_pinned" });
    const two = "2024-09-01T00:00:00.000Z";
    await seedMemory(r, memory("m_citer", { forgetAfter: undefined, sourceObservationIds: ["o_cited"] }));
    await seedMemory(r, memory("m_cold", { forgetAfter: undefined, createdAt: two, updatedAt: two, origin: { channel: "agent", capturedAt: two } }));
    await seedMemory(r, memory("m_arch", { forgetAfter: undefined, createdAt: two, updatedAt: two, type: "architecture" }));
    await seedMemory(r, memory("m_plain", { forgetAfter: undefined, createdAt: two, updatedAt: two }));
    for (const id of ["m_cold", "m_arch", "m_plain"]) {
      await r.kv.set(KV.retentionScores, id, { memoryId: id, score: 0.01, salience: 0.1, temporalDecay: 0.1, reinforcementBoost: 0, lastAccessed: two, accessCount: 1 });
    }
    await r.kv.set(KV.accessLog, "m_cold", { memoryId: "m_cold", count: 1, lastAt: two, recent: [] });
    await r.kv.set(KV.lessons, "les_1", { id: "les_1", content: "never force push", context: "", confidence: 0.9, reinforcements: 1, source: "manual", sourceIds: [], tags: [], createdAt: two, updatedAt: two, decayRate: 0.1 });

    const { cleared, protectedBy, judge } = await planAndMove(r);

    expect(protectedBy).toEqual({
      "obs:5:ses_p:o_pinned": "pin", "obs:5:ses_p:o_cited": "cited-by-memory", "obs:5:ses_p:o_important": "importance",
      "memory:m_cold": "deliberate-save", "memory:m_arch": "memory-type",
    });
    expect(judge.hits()).toMatchObject({ pin: 1, "cited-by-memory": 1, importance: 1, "deliberate-save": 1, "memory-type": 1, lesson: 1 });
    expect(cleared.map((c) => c.ref.id).sort()).toEqual(["m_plain", "o_control"]);

    expect(await liveIds(r, "ses_p")).toEqual(["o_cited", "o_important", "o_pinned"]);
    for (const id of ["m_cold", "m_arch", "m_citer"]) expect(await r.kv.get(KV.memories, id)).not.toBeNull();
    expect(await r.kv.get(KV.lessons, "les_1")).not.toBeNull();
    expect(await r.kv.listKeys(RETENTION_KV.vault(RUN))).toEqual(["obs:5:ses_p:o_control"]);
  });
});

describe("R6: a superseded memory leaves recall at once and is removed after its window", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-30T00:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  it("plans the old version as stage S with a chain proof, and the move leaves the revision untouched", async () => {
    const r = rig();
    registerRememberFunction(r.h.sdk as never, r.kv);
    const save = async (content: string) => (await r.h.call("mem::remember", { content, type: "workflow", project: "proj" }) as { memory: Memory }).memory;
    const first = await save("session tokens rotate every fifteen minutes via the auth broker");
    const revision = await save("session tokens rotate every fifteen minutes via the auth broker service");
    expect(revision).toMatchObject({ version: 2, supersedes: [first.id], isLatest: true });

    const recall = async () => (await getSearchIndex().search("session tokens rotate", 10)).map((h) => h.obsId);
    expect(await recall()).toEqual([revision.id]);

    const revisionBefore = await r.kv.get<Memory>(KV.memories, revision.id);
    await openRun(r);
    const planned = candidatesOf(await planAll(r, ZERO));
    expect(planned.map((c) => [c.stage, c.ref.id])).toEqual([["S", first.id]]);
    expect(planned[0]).toMatchObject({ proof: { successorId: revision.id } });

    const { cleared } = await judgeAll(r, ZERO, planned);
    expect((await displace(r.deps, r.vault, RUN, cleared[0]!)).moved).toBe(true);

    expect(await r.kv.get(KV.memories, first.id)).toBeNull();
    expect(await r.kv.get(KV.memories, revision.id)).toEqual(revisionBefore);
    expect(await recall()).toEqual([revision.id]);
  });

  it("plans nothing while the superseded window has not passed", async () => {
    const r = rig();
    registerRememberFunction(r.h.sdk as never, r.kv);
    await r.h.call("mem::remember", { content: "deploys use blue green rollout with health gates", project: "proj" });
    await r.h.call("mem::remember", { content: "deploys use blue green rollout with health gates always", project: "proj" });
    expect(candidatesOf(await planAll(r, { ...ZERO, supersededDays: 9999 }))).toEqual([]);
  });
});

describe("stage S chain proof (design 5.4)", () => {
  const chain = (id: string, over: Partial<Memory>) => memory(id, { forgetAfter: undefined, ...over });

  async function proofFor(rows: Memory[], target: string) {
    const r = rig();
    for (const row of rows) await r.kv.set(KV.memories, row.id, row);
    return proveChain(r.kv, rows.find((m) => m.id === target)!, await successorIndex(r.kv));
  }

  it("follows a chain of revisions to the latest row", async () => {
    const a = chain("a", { isLatest: false, version: 1 });
    const b = chain("b", { isLatest: false, version: 2, supersedes: ["a"], parentId: "a", createdAt: "2026-02-01T00:00:00.000Z" });
    const c = chain("c", { version: 3, supersedes: ["b", "a"], parentId: "b", createdAt: "2026-03-01T00:00:00.000Z" });
    expect(await proofFor([a, b, c], "a")).toMatchObject({ successorId: "c" });
    expect(await proofFor([a, b, c], "b")).toMatchObject({ successorId: "c" });
  });

  it.each([
    ["no successor", [chain("a", { isLatest: false })]],
    ["a successor that is not newer", [chain("a", { isLatest: false }), chain("b", { supersedes: ["a"], version: 1 })]],
    ["a successor created earlier", [chain("a", { isLatest: false }), chain("b", { supersedes: ["a"], version: 2, createdAt: "2025-12-01T00:00:00.000Z" })]],
    ["a chain that loops", [chain("a", { isLatest: false, version: 1, supersedes: ["b"] }), chain("b", { isLatest: false, version: 2, supersedes: ["a"] })]],
    ["a chain that ends on a superseded row", [chain("a", { isLatest: false }), chain("b", { isLatest: false, version: 2, supersedes: ["a"] })]],
  ])("gives no proof for %s", async (_name, rows) => {
    expect(await proofFor(rows, "a")).toBeNull();
  });

  it("does not plan a superseded memory whose chain is unresolved", async () => {
    const r = rig();
    await r.kv.set(KV.memories, "a", chain("a", { isLatest: false }));
    expect(candidatesOf(await planAll(r, ZERO))).toEqual([]);
  });
});

describe("the plan is a bounded stream", () => {
  it("walks a session of several pages in key order and resumes from any cursor", async () => {
    const r = rig();
    const count = RETENTION_PAGE_SIZE * 2 + 5;
    const rows = Array.from({ length: count }, (_, i) => observation(`o${String(i).padStart(4, "0")}`, "ses_big"));
    await sealedSession(r, "ses_big", 0, { rows });
    const batches = await planAll(r, ZERO);
    expect(batches.filter((b) => b.candidates.length > 0).map((b) => b.candidates.length)).toEqual([RETENTION_PAGE_SIZE, RETENTION_PAGE_SIZE, 5]);
    expect(candidatesOf(batches).every((c) => c.ref.kind === "observation" && c.ref.sessionId === "ses_big")).toBe(true);
    expect(batches.at(-1)!.cursorAfter).toEqual({ unit: "memories", after: null });

    const all = candidatesOf(batches).map(keyOf);
    for (const [i, batch] of batches.entries()) {
      const resumed = candidatesOf(await planAll(r, ZERO, batch.cursorAfter)).map(keyOf);
      expect(resumed).toEqual(all.slice(all.length - resumed.length));
      expect(candidatesOf(batches.slice(0, i + 1)).length + resumed.length).toBe(count);
    }
  });

  it("walks sessions in id order and then memories, one page of one session per batch", async () => {
    const r = rig();
    await sealedSession(r, "ses_b", 2);
    await sealedSession(r, "ses_a", 2);
    await seedMemory(r, memory("m_1"));
    const batches = await planAll(r, ZERO);
    expect(batches.map((b) => b.cursorAfter.unit)).toEqual(["sessions", "sessions", "sessions", "sessions", "memories", "memories"]);
    expect(batches.slice(0, 4).map((b) => b.cursorAfter.after)).toEqual([null, null, "ses_a", "ses_a"]);
    expect(candidatesOf(batches).map(keyOf)).toEqual(["ses_a_o0", "ses_a_o1", "ses_b_o0", "ses_b_o1", "m_1"]);
  });

  it("reads at most one page of rows per call and lists no growing scope whole", async () => {
    const r = rig();
    await sealedSession(r, "ses_a", RETENTION_PAGE_SIZE + 3);
    await seedMemory(r, memory("m_1"));
    const reads: number[] = [];
    const getMany = r.kv.getMany.bind(r.kv);
    r.kv.getMany = (async (scope: string, keys: string[], opts?: never) => {
      reads.push(keys.length);
      return getMany(scope, keys, opts);
    }) as typeof r.kv.getMany;
    r.h.stateOps.length = 0;
    await judgeAll(r, ZERO, candidatesOf(await planAll(r, ZERO)));
    expect(Math.max(...reads)).toBeLessThanOrEqual(RETENTION_PAGE_SIZE);
    const listed = r.h.stateOps.filter((op) => op.startsWith("state::list ")).map((op) => op.split(" ")[1]);
    expect(listed.filter((scope) => scope !== KV.observations("ses_a"))).toEqual([]);
  });
});

describe("a graph-cited row goes last and is counted", () => {
  it("yields the uncited rows first and sets graphCited on the cited one, which the judge counts without a veto", async () => {
    const r = rig();
    await sealedSession(r, "ses_g", 0, { rows: [observation("a_cited", "ses_g"), observation("b_free", "ses_g"), observation("c_free", "ses_g")] });
    await initializeGraphIndex(r.kv, { status: "ready" });
    await reconcileGraphIndexRecord(r.kv, "node", "n1", {
      id: "n1", name: "Zebra", type: "concept", properties: {}, sourceObservationIds: ["a_cited"], createdAt: NOW.toISOString(),
    });
    const batches = await planAll(r, ZERO);
    const sessionBatches = batches.filter((b) => b.cursorAfter.unit === "sessions");
    expect(sessionBatches.map((b) => b.cursorAfter.within?.pass)).toEqual(["uncited", "graph-cited"]);
    expect(candidatesOf(batches).map(keyOf)).toEqual(["b_free", "c_free", "a_cited"]);
    expect(candidatesOf(batches).map((c) => c.graphCited ?? false)).toEqual([false, false, true]);

    const { cleared, judge } = await judgeAll(r, ZERO, candidatesOf(batches));
    expect(cleared).toHaveLength(3);
    expect(judge.hits()["cited-by-graph"]).toBe(1);

    const resumed = candidatesOf(await planAll(r, ZERO, sessionBatches[0]!.cursorAfter)).map(keyOf);
    expect(resumed).toEqual(["a_cited"]);
  });
});

describe("stages X and C", () => {
  it("plans an expired memory as stage X whether or not it is latest, and a live ttl not at all", async () => {
    const r = rig();
    await seedMemory(r, memory("m_expired"));
    await seedMemory(r, memory("m_old_expired", { isLatest: false }));
    await seedMemory(r, memory("m_future", { forgetAfter: "2027-01-01T00:00:00.000Z" }));
    expect(candidatesOf(await planAll(r, ZERO)).map((c) => [c.stage, c.ref.id])).toEqual([["X", "m_expired"], ["X", "m_old_expired"]]);
  });

  it("plans a cold memory as stage C only with a score below the cold tier", async () => {
    const r = rig();
    for (const [id, score] of [["m_cold", 0.01], ["m_warm", 0.5]] as const) {
      await seedMemory(r, memory(id, { forgetAfter: undefined }));
      await r.kv.set(KV.retentionScores, id, { memoryId: id, score, salience: 0, temporalDecay: 0, reinforcementBoost: 0, lastAccessed: "", accessCount: 0 });
    }
    await seedMemory(r, memory("m_unscored", { forgetAfter: undefined }));
    expect(candidatesOf(await planAll(r, ZERO)).map((c) => [c.stage, c.ref.id])).toEqual([["C", "m_cold"]]);
  });

  it("ages a memory on its own project's active days", async () => {
    const r = rig();
    for (const [id, startedAt] of [["s1", "2026-03-20T08:00:00.000Z"], ["s2", "2026-04-01T08:00:00.000Z"], ["s3", "2026-04-02T08:00:00.000Z"]] as const) {
      await seedSession(r, id, { startedAt });
    }
    const stopped = "2026-03-15T00:00:00.000Z";
    for (const [id, project] of [["m_old", "proj"], ["m_idle", "idle"]] as const) {
      await seedMemory(r, memory(id, { forgetAfter: undefined, isLatest: false, updatedAt: stopped, project }));
      await r.kv.set(KV.memories, `${id}_next`, memory(`${id}_next`, { forgetAfter: undefined, version: 2, supersedes: [id], createdAt: "2026-04-01T00:00:00.000Z" }));
    }
    const days = async (supersededDays: number) => candidatesOf(await planAll(r, { ...ZERO, supersededDays })).map(keyOf);
    expect((await clockOf(r)).activeDaysSince("proj", new Date(stopped))).toBe(3);
    expect(await days(3)).toEqual(["m_old"]);
    expect(await days(4)).toEqual([]);
    expect(await days(0)).toEqual(["m_idle", "m_old"]);
  });
});

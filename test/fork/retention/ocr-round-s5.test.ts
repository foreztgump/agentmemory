// Fix round on the slice 5 Open Code Review: recheck of a stage T entry reads the live row's importance, a
// failing graph reader fails closed, one session verdict across the plan's two passes, parallel posting reads.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { logger } from "../../../src/logger.js";
import { displace } from "../../../src/fork/retention/move.js";
import { planCandidates, type PlanBatch } from "../../../src/fork/retention/plan.js";
import { createProtector } from "../../../src/fork/retention/protect.js";
import { RETENTION_IMPORTANCE_FLOOR } from "../../../src/fork/retention/settings.js";
import { initializeGraphIndex, reconcileGraphIndexRecord } from "../../../src/state/graph-retrieval-index.js";
import type { StateKV } from "../../../src/state/kv.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation } from "../../../src/types.js";
import { NOW, observation, openRun, RUN, rig, type Rig } from "./move-fixtures.js";
import { candidatesOf, clockOf, judgeAll, planAll, sealedSession, ZERO } from "./plan-fixtures.js";

/** A StateKV whose `get` goes through `around`; everything else is the target's, bound to it. */
function withGet(kv: StateKV, around: (scope: string, key: string, read: () => Promise<unknown>) => Promise<unknown>): StateKV {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === "get") return (scope: string, key: string) => around(scope, key, () => target.get(scope, key));
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const citeing = (id: string, name: string, ...cited: string[]) => ({
  id, name, type: "concept" as const, properties: {}, sourceObservationIds: cited, createdAt: NOW.toISOString(),
});

describe("recheck of a stage T entry reads the live row's importance", () => {
  it("protects a trimmed row whose live importance rose to the floor during grace, and clears one that did not", async () => {
    const r = rig();
    await openRun(r);
    const rows = await sealedSession(r, "ses_a", 0, { rows: [observation("t_up", "ses_a"), observation("t_flat", "ses_a")] });
    const windows = { ...ZERO, observationDays: 9999 };
    const { cleared } = await judgeAll(r, windows, candidatesOf(await planAll(r, windows)));
    expect(cleared.map((c) => c.stage)).toEqual(["T", "T"]);
    for (const item of cleared) await displace(r.deps, r.vault, RUN, item);

    const live = (await r.kv.get<CompressedObservation>(KV.observations("ses_a"), "t_up"))!;
    await r.kv.set(KV.observations("ses_a"), "t_up", { ...live, importance: RETENTION_IMPORTANCE_FLOOR });
    const entries = await Promise.all(rows.map((row) => r.vault.get(RUN, { kind: "observation", sessionId: "ses_a", id: row.id })));
    expect(entries.map((e) => e?.stage)).toEqual(["T", "T"]);

    const protector = await createProtector(r.kv, windows, await clockOf(r));
    expect(await Promise.all(entries.map((entry) => protector.recheck(entry!)))).toEqual([{ kind: "protected", signal: "importance" }, { kind: "clear" }]);
  });

  it("clears a trim entry whose live row is gone, since only importance needs it", async () => {
    const r = rig();
    await openRun(r);
    await sealedSession(r, "ses_a", 0, { rows: [observation("t_gone", "ses_a")] });
    const windows = { ...ZERO, observationDays: 9999 };
    const { cleared } = await judgeAll(r, windows, candidatesOf(await planAll(r, windows)));
    await displace(r.deps, r.vault, RUN, cleared[0]!);
    await r.kv.delete(KV.observations("ses_a"), "t_gone");
    const entry = (await r.vault.get(RUN, { kind: "observation", sessionId: "ses_a", id: "t_gone" }))!;
    expect(await (await createProtector(r.kv, windows, await clockOf(r))).recheck(entry)).toEqual({ kind: "clear" });
  });
});

async function citedSession(r: Rig, ids: string[]) {
  await sealedSession(r, "ses_g", 0, { rows: ids.map((id) => observation(id, "ses_g")) });
  await initializeGraphIndex(r.kv, { status: "ready" });
}

async function planWith(r: Rig, kv: StateKV, onBatch?: (batch: PlanBatch) => Promise<void>): Promise<PlanBatch[]> {
  const batches: PlanBatch[] = [];
  for await (const batch of planCandidates(kv, await clockOf(r), ZERO, null, NOW)) {
    batches.push(batch);
    await onBatch?.(batch);
  }
  return batches;
}

describe("graphCitedIds fails closed on an unexpected reader error", () => {
  it("counts the chunk as cited and logs at warn when the reader cannot be created", async () => {
    const r = rig();
    await citedSession(r, ["a", "b"]);
    const broken = withGet(r.kv, async (scope, _key, read) => {
      if (scope === KV.graphRetrievalControl) throw new Error("kv outage");
      return read();
    });
    vi.mocked(logger.warn).mockClear();
    const batches = await planWith(r, broken);
    const sessionBatches = batches.filter((b) => b.cursorAfter.unit === "sessions");
    expect(sessionBatches.map((b) => b.cursorAfter.within?.pass)).toEqual(["uncited", "graph-cited"]);
    expect(sessionBatches[0]!.candidates).toEqual([]);
    expect(sessionBatches[1]!.candidates.map((c) => [c.ref.id, c.graphCited])).toEqual([["a", true], ["b", true]]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("graph"), expect.objectContaining({ error: "kv outage" }));
  });
});

describe("a session's graph verdict is read once across the plan's two passes", () => {
  it("yields a row once when the graph changes between the passes", async () => {
    const r = rig();
    await citedSession(r, ["a", "b"]);
    let changed = false;
    const batches = await planWith(r, r.kv, async (batch) => {
      if (changed || batch.cursorAfter.within?.pass !== "uncited") return;
      changed = true;
      await reconcileGraphIndexRecord(r.kv, "node", "n1", citeing("n1", "Zebra", "a"));
    });
    expect(changed).toBe(true);
    expect(candidatesOf(batches).map((c) => c.ref.id)).toEqual(["a", "b"]);
  });
});

describe("the two posting reads of an id are issued together", () => {
  it("has the node and edge postings in flight at the same time", async () => {
    const r = rig();
    await citedSession(r, ["a"]);
    let inFlight = 0;
    let peak = 0;
    const slow = withGet(r.kv, async (scope, _key, read) => {
      if (scope !== KV.graphRetrievalData) return read();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return read();
    });
    await planWith(r, slow);
    expect(peak).toBeGreaterThanOrEqual(2);
  });
});

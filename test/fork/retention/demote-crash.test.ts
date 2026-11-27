// R12 for stage C: a crash between any two writes of a demote or an un-demote, then recoverRun. The memory ends
// wholly demoted (marked, a record, out of both indexes) or wholly live (unmarked, no record, in both), never half.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { reinstateDemote } from "../../../src/fork/retention/demote.js";
import { hiddenFromIndex } from "../../../src/fork/retention/indexable.js";
import { displace, recoverRun } from "../../../src/fork/retention/move.js";
import { restoreItems } from "../../../src/fork/retention/restore.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { DemoteRecord } from "../../../src/fork/retention/types.js";
import { KV } from "../../../src/state/schema.js";
import { float32ToBase64 } from "../../../src/state/vector-index.js";
import type { Memory } from "../../../src/types.js";
import { crashed, crashingAt } from "./crash.js";
import { NOW, RUN, candidate, keywordHits, liveRow, memory, openRun, rig, seedMemory, vec, vectorHits, type Rig } from "./move-fixtures.js";

const MAX_WRITES = 40;
const cold = (id = "mem_cold") => memory(id, { forgetAfter: undefined, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" });

async function liveFixture() {
  const r = rig();
  await openRun(r);
  const row = await seedMemory(r, cold(), { seed: 7 });
  await seedMemory(r, cold("mem_warm"), { seed: 8 });
  return { r, row, cleared: await candidate(r, "C", row) };
}

async function demotedFixture() {
  const f = await liveFixture();
  await displace(f.r.deps, f.r.vault, RUN, f.cleared);
  return f;
}

const snapshot = (r: Rig) => JSON.stringify([...r.h.store].map(([scope, rows]) => [scope, [...rows]]));

async function assertSettled(r: Rig, row: Memory): Promise<"demoted" | "live"> {
  const live = await liveRow<Memory>(r, KV.memories, "mem_cold");
  const record = await r.kv.get<DemoteRecord>(RETENTION_KV.demoted, "mem_cold");
  expect(live, "the row is never lost").not.toBeNull();
  expect(await r.vault.locate({ kind: "memory", id: "mem_cold" })).toBeNull();
  expect(await keywordHits(r, "okapi")).toContain("mem_warm");
  if (hiddenFromIndex(live)) {
    expect(live).toEqual({ ...row, retention: { demotedAt: NOW.toISOString(), runId: RUN, memoryId: "mem_cold" } });
    expect(record?.vector).toBe(float32ToBase64(vec(7)));
    expect(await keywordHits(r, "okapi")).toEqual(["mem_warm"]);
    expect(await vectorHits(r, 7)).not.toContain("mem_cold");
    return "demoted";
  }
  expect(live).toEqual(row);
  expect(record, "a live row has no record").toBeNull();
  expect(await keywordHits(r, "okapi")).toEqual(["mem_cold", "mem_warm"]);
  expect(r.runtime.vector.readVectors(["mem_cold"]).get("mem_cold")).toEqual(vec(7));
  return "live";
}

async function everyCrashPoint(make: () => ReturnType<typeof liveFixture>, drive: (f: Awaited<ReturnType<typeof liveFixture>>, n: number) => Promise<void>) {
  const outcomes = new Set<string>();
  let points = 0;
  for (let n = 1; n <= MAX_WRITES; n++) {
    const f = await make();
    const crashedHere = await crashed(() => drive(f, n));
    await recoverRun(f.r.deps, f.r.vault, RUN);
    outcomes.add(await assertSettled(f.r, f.row));
    const once = snapshot(f.r);
    await recoverRun(f.r.deps, f.r.vault, RUN);
    expect(snapshot(f.r), "a second recovery changes nothing").toBe(once);
    if (!crashedHere) return { points, outcomes };
    points++;
  }
  throw new Error(`still writing after ${MAX_WRITES} writes`);
}

describe("demote", () => {
  it("is settled by recoverRun after a crash at every write, and a crash before the mark leaves the memory live", async () => {
    const { points, outcomes } = await everyCrashPoint(liveFixture, async (f, n) => {
      const crashing = crashingAt(f.r.deps, n);
      await displace(crashing.deps, crashing.vault, RUN, f.cleared);
    });
    expect(points).toBeGreaterThanOrEqual(4);
    expect([...outcomes].sort()).toEqual(["demoted", "live"]);
  });

  it("a displace re-run after recovery converges on the demoted state", async () => {
    for (const n of [1, 2, 3, 4]) {
      const f = await liveFixture();
      const crashing = crashingAt(f.r.deps, n);
      await crashed(() => displace(crashing.deps, crashing.vault, RUN, f.cleared));
      await recoverRun(f.r.deps, f.r.vault, RUN);
      await displace(f.r.deps, f.r.vault, RUN, await candidate(f.r, "C", (await liveRow<Memory>(f.r, KV.memories, "mem_cold"))!));
      expect(await assertSettled(f.r, f.row)).toBe("demoted");
    }
  });
});

describe("un-demote", () => {
  it("is settled by recoverRun after a crash at every write, and a crash after the record is flagged finishes the restore", async () => {
    const { points, outcomes } = await everyCrashPoint(demotedFixture, async (f, n) => {
      const crashing = crashingAt(f.r.deps, n);
      await reinstateDemote(crashing.deps, "mem_cold");
    });
    expect(points).toBeGreaterThanOrEqual(5);
    expect([...outcomes].sort()).toEqual(["demoted", "live"]);
  });

  it("a restore after a crashed un-demote and its recovery leaves the memory live with the stored vector", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const f = await demotedFixture();
      const crashing = crashingAt(f.r.deps, n);
      await crashed(() => reinstateDemote(crashing.deps, "mem_cold"));
      await recoverRun(f.r.deps, f.r.vault, RUN);
      await restoreItems(f.r.deps, [{ kind: "memory", id: "mem_cold" }], "finish");
      expect(await assertSettled(f.r, f.row)).toBe("live");
    }
  });
});

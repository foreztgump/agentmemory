import { describe, expect, it } from "vitest";
import { LEASE_STALE_MS, newRunRow, RunStore } from "../../../src/fork/retention/run-store.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { RunId } from "../../../src/fork/retention/types.js";
import { retentionHarness } from "./harness.js";

const WINDOWS = { trimDays: 45, observationDays: 180, supersededDays: 180, coldDays: 365 };
const T0 = Date.parse("2026-06-01T00:00:00.000Z");

function store(h: ReturnType<typeof retentionHarness>, clock: { now: number }) {
  return new RunStore(h.kv, () => new Date(clock.now));
}

describe("run row", () => {
  it("starts at the seal phase with zeroed counters and the settings it started under", () => {
    const row = newRunRow({ id: "ret_1" as RunId, dryRun: true, windows: WINDOWS, graceDays: 30, ranBy: "p1", startedAt: "2026-06-01T00:00:00.000Z" });
    expect(row).toMatchObject({
      id: "ret_1", dryRun: true, windows: WINDOWS, graceDays: 30, phase: "seal", outcome: "running",
      cursor: null, observationCap: null, held: 0, ranBy: "p1",
    });
    expect(Object.keys(row.counters).sort()).toEqual(["C", "O", "S", "T", "X"]);
    for (const counter of Object.values(row.counters)) expect(counter).toEqual({ planned: 0, moved: 0, bytes: 0, protectedHits: 0 });
  });

  it("gives each stage its own counter object", () => {
    const row = newRunRow({ id: "ret_1" as RunId, dryRun: false, windows: WINDOWS, graceDays: 30, ranBy: "p1", startedAt: "x" });
    row.counters.O.moved = 5;
    expect(row.counters.T.moved).toBe(0);
  });
});

describe("RunStore", () => {
  it("round-trips a run row and lists the runs that are not done", async () => {
    const h = retentionHarness();
    const runs = store(h, { now: T0 });
    const open = newRunRow({ id: "ret_open" as RunId, dryRun: false, windows: WINDOWS, graceDays: 30, ranBy: "p1", startedAt: "x" });
    const finished = { ...newRunRow({ id: "ret_done" as RunId, dryRun: false, windows: WINDOWS, graceDays: 30, ranBy: "p1", startedAt: "x" }), phase: "done" as const };
    await runs.save(open);
    await runs.save(finished);

    expect(await runs.get("ret_open" as RunId)).toEqual(open);
    expect(await runs.get("ret_nope" as RunId)).toBeNull();
    expect((await runs.unfinished()).map((r) => r.id)).toEqual(["ret_open"]);

    open.phase = "apply";
    open.cursor = { unit: "sessions", after: "ses_9" };
    await runs.save(open);
    expect(await runs.get("ret_open" as RunId)).toMatchObject({ phase: "apply", cursor: { unit: "sessions", after: "ses_9" } });
  });
});

describe("sweep lease", () => {
  it("is taken by the first caller and refused to another while its heartbeat is fresh", async () => {
    const h = retentionHarness();
    const clock = { now: T0 };
    const runs = store(h, clock);
    expect(await runs.acquireLease("p1")).toEqual({ held: true });
    clock.now += LEASE_STALE_MS - 1;
    expect(await runs.acquireLease("p2")).toEqual({ held: false, heldBy: "p1" });
    expect(h.store.get(RETENTION_KV.control)?.get("lease")).toMatchObject({ owner: "p1" });
  });

  it("is idempotent for the owner", async () => {
    const h = retentionHarness();
    const runs = store(h, { now: T0 });
    await runs.acquireLease("p1");
    expect(await runs.acquireLease("p1")).toEqual({ held: true });
  });

  it("is taken over once its heartbeat is stale, and says whose it was", async () => {
    const h = retentionHarness();
    const clock = { now: T0 };
    const runs = store(h, clock);
    await runs.acquireLease("p1");
    clock.now += LEASE_STALE_MS;
    expect(await runs.acquireLease("p2")).toEqual({ held: true, tookOverFrom: "p1" });
    expect(await runs.heartbeat("p1")).toBe(false);
    expect(await runs.heartbeat("p2")).toBe(true);
  });

  it("a heartbeat keeps the lease from going stale", async () => {
    const h = retentionHarness();
    const clock = { now: T0 };
    const runs = store(h, clock);
    await runs.acquireLease("p1");
    clock.now += LEASE_STALE_MS - 1;
    expect(await runs.heartbeat("p1")).toBe(true);
    clock.now += LEASE_STALE_MS - 1;
    expect(await runs.acquireLease("p2")).toMatchObject({ held: false });
  });

  it("is released only by its owner", async () => {
    const h = retentionHarness();
    const runs = store(h, { now: T0 });
    await runs.acquireLease("p1");
    await runs.releaseLease("p2");
    expect(await runs.acquireLease("p2")).toMatchObject({ held: false, heldBy: "p1" });
    await runs.releaseLease("p1");
    expect(await runs.acquireLease("p2")).toEqual({ held: true });
  });

  it("admits exactly one of several concurrent acquirers", async () => {
    const h = retentionHarness();
    const runs = store(h, { now: T0 });
    const results = await Promise.all(["a", "b", "c", "d"].map((owner) => runs.acquireLease(owner)));
    expect(results.filter((r) => r.held)).toHaveLength(1);
  });

  it("treats an unreadable heartbeat as stale rather than locking the sweep out for good", async () => {
    const h = retentionHarness();
    h.store.set(RETENTION_KV.control, new Map([["lease", { owner: "ghost", heartbeatAt: "not a date" }]]));
    const runs = store(h, { now: T0 });
    expect(await runs.acquireLease("p1")).toEqual({ held: true, tookOverFrom: "ghost" });
  });
});

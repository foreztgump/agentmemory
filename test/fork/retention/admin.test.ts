// Slice 10: restore through the lease, a restore racing a purge through the endpoints, and the report reader.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { readReport, restoreLeased } from "../../../src/fork/retention/admin.js";
import { LEASE_STALE_MS } from "../../../src/fork/retention/run-store.js";
import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { Scheduler } from "../../../src/fork/retention/timers.js";
import type { ItemRef, RunId, RunRow } from "../../../src/fork/retention/types.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import type { StateKV } from "../../../src/state/kv.js";
import { KV } from "../../../src/state/schema.js";
import { liveRoutes } from "./api-fixtures.js";
import { candidate, observation, rig, seedObservation, seedSeal, type Rig } from "./move-fixtures.js";
import { at, clocked, closedRun } from "./purge-fixtures.js";
import { liveIds } from "./plan-fixtures.js";

const A = "ret_a" as RunId;
const obs = (sessionId: string, id: string): ItemRef => ({ kind: "observation", sessionId, id });

afterEach(() => resetSummarizeVeto());

async function heldRun(r: Rig, ids: readonly string[] = ["p1", "p2", "p3"], session = "ses_p", runId: RunId = A): Promise<void> {
  const rows = [];
  for (const [n, id] of ids.entries()) rows.push(await seedObservation(r, observation(id, session), { seed: n + 1 }));
  const seal = await seedSeal(r, session, rows.length);
  await closedRun(r, runId, await Promise.all(rows.map((row) => candidate(r, "O", row, seal))));
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** The same KV, except that `iterate` of one scope waits on `before` once it has the first page. */
function pausingIterate(kv: StateKV, scope: string, reached: () => void, resume: Promise<void>): StateKV {
  return new Proxy(kv, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "iterate") return typeof value === "function" ? value.bind(target) : value;
      return async function* (name: string, opts: unknown) {
        for await (const page of (target.iterate as (s: string, o: unknown) => AsyncIterable<unknown>)(name, opts)) {
          if (name === scope) {
            reached();
            await resume;
          }
          yield page;
        }
      };
    },
  }) as StateKV;
}

const leaseOwner = async (r: Rig) => (await r.kv.get<{ owner: string }>(RETENTION_KV.control, "lease"))?.owner ?? null;

describe("restoreLeased", () => {
  it("restores a whole run under the sweep lease and releases it", async () => {
    const r = rig();
    await heldRun(r);
    const result = await restoreLeased(r.deps, { runId: A });
    expect(result).toMatchObject({ kind: "done", restored: 3 });
    expect(await liveIds(r, "ses_p")).toEqual(["p1", "p2", "p3"]);
    expect(await leaseOwner(r)).toBeNull();
    expect(await r.runs.get(A)).toMatchObject({ held: 0, restoredBecause: "restore requested" });
  });

  it("restores single refs under the lease too, and leaves the rest held", async () => {
    const r = rig();
    await heldRun(r);
    const result = await restoreLeased(r.deps, { refs: [obs("ses_p", "p2")] });
    expect(result).toMatchObject({ kind: "done", restored: 1 });
    expect(await liveIds(r, "ses_p")).toEqual(["p2"]);
    expect(await r.runs.get(A)).toMatchObject({ held: 2 });
    expect(await leaseOwner(r)).toBeNull();
  });

  it("answers busy while a sweep or purge holds the lease, and restores nothing", async () => {
    const r = rig();
    await heldRun(r);
    await r.runs.acquireLease("sweep-other");
    expect(await restoreLeased(r.deps, { runId: A })).toEqual({ kind: "busy", heldBy: "sweep-other" });
    expect(await restoreLeased(r.deps, { refs: [obs("ses_p", "p1")] })).toEqual({ kind: "busy", heldBy: "sweep-other" });
    expect(await liveIds(r, "ses_p")).toEqual([]);
    expect(await leaseOwner(r)).toBe("sweep-other");
  });

  it("takes over a lease its holder stopped renewing, as a sweep does", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await heldRun(r);
    await r.runs.acquireLease("sweep-dead");
    clock.now = new Date(clock.now.getTime() + LEASE_STALE_MS + 1);
    expect(await restoreLeased(deps, { runId: A })).toMatchObject({ kind: "done", restored: 3 });
  });

  it("answers not-found for a run that does not exist, and run-open for one that has not finished", async () => {
    const r = rig();
    expect(await restoreLeased(r.deps, { runId: "ret_nope" as RunId })).toEqual({ kind: "not-found" });
    await heldRun(r);
    await r.runs.save({ ...(await r.runs.get(A))!, phase: "apply", outcome: "running" } satisfies RunRow);
    expect(await restoreLeased(r.deps, { runId: A })).toEqual({ kind: "run-open" });
    expect(await liveIds(r, "ses_p")).toEqual([]);
    expect(await leaseOwner(r)).toBeNull();
  });

  it("releases the lease when the restore throws", async () => {
    const r = rig();
    await heldRun(r);
    const failing = new Proxy(r.kv, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "iterate") return () => { throw new Error("state store down"); };
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateKV;
    await expect(restoreLeased({ ...r.deps, kv: failing }, { runId: A })).rejects.toThrow("state store down");
    expect(await leaseOwner(r)).toBeNull();
  });

  it("renews the lease while it restores, so a long run is not taken over", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await heldRun(r);
    const beats: Array<() => Promise<void> | void> = [];
    const scheduler: Scheduler = { every: (ms, tick) => { expect(ms).toBeLessThan(LEASE_STALE_MS); beats.push(tick); return { stop: () => { beats.length = 0; } }; } };
    const reached = gate();
    const resume = gate();
    const slow = pausingIterate(deps.kv, RETENTION_KV.vault(A), reached.open, resume.promise);
    const restoring = restoreLeased({ ...deps, kv: slow }, { runId: A }, scheduler);
    await reached.promise;
    clock.now = new Date(clock.now.getTime() + LEASE_STALE_MS - 1000);
    await beats[0]!();
    clock.now = new Date(clock.now.getTime() + 2000);
    expect(await r.runs.acquireLease("sweep-other")).toEqual({ held: false, heldBy: expect.stringMatching(/^restore-/) });
    resume.open();
    expect(await restoring).toMatchObject({ kind: "done", restored: 3 });
    expect(beats).toEqual([]);
  });
});

describe("a restore and a purge on the same run, through the endpoints", () => {
  async function world() {
    const r = rig();
    const clock = { now: at(0) };
    await heldRun(r);
    return { r, clock };
  }

  it("a restore that is running makes a purge answer 409, and the purge goes through afterwards", async () => {
    const { r, clock } = await world();
    const reached = gate();
    const resume = gate();
    const { call } = liveRoutes(r, clock, { kv: pausingIterate(r.kv, RETENTION_KV.vault(A), reached.open, resume.promise) });
    clock.now = at(25);
    const restoring = call("restore", { body: { runId: A } });
    await reached.promise;
    expect(await call("purge", { body: { dryRun: false } })).toMatchObject({ status_code: 409, body: { error: "busy" } });
    resume.open();
    expect(await restoring).toMatchObject({ status_code: 200, body: { kind: "done", restored: 3 } });
    expect(await call("purge", { body: { dryRun: false } })).toMatchObject({ status_code: 200, body: { kind: "done", purged: 0 } });
    expect(await liveIds(r, "ses_p")).toEqual(["p1", "p2", "p3"]);
    expect(await r.kv.listKeys(RETENTION_KV.tombstones)).toEqual([]);
  });

  it("a purge that is running makes a restore answer 409, and the restore finds nothing left afterwards", async () => {
    const { r, clock } = await world();
    const reached = gate();
    const resume = gate();
    const { call } = liveRoutes(r, clock, { kv: pausingIterate(r.kv, RETENTION_KV.vault(A), reached.open, resume.promise) });
    clock.now = at(25);
    const purging = call("purge", { body: { dryRun: false } });
    await reached.promise;
    expect(await call("restore", { body: { runId: A } })).toMatchObject({ status_code: 409, body: { error: "busy" } });
    expect(await call("restore", { body: { refs: [obs("ses_p", "p1")] } })).toMatchObject({ status_code: 409 });
    resume.open();
    expect(await purging).toMatchObject({ status_code: 200, body: { kind: "done", purged: 3, runsEmptied: 1 } });
    expect(await call("restore", { body: { runId: A } })).toMatchObject({ status_code: 200, body: { kind: "done", restored: 0, keptLive: 0 } });
    expect(await liveIds(r, "ses_p")).toEqual([]);
    for (const id of ["p1", "p2", "p3"]) expect(await r.kv.get(RETENTION_KV.tombstones, itemKey(obs("ses_p", id)))).not.toBeNull();
    expect(await r.kv.listKeys(RETENTION_KV.vault(A))).toEqual([]);
  });

  it("fired together, every item ends live or purged, never both and never neither", async () => {
    const { r, clock } = await world();
    const { call } = liveRoutes(r, clock);
    clock.now = at(25);
    const [restore, purge] = await Promise.all([call("restore", { body: { runId: A } }), call("purge", { body: { dryRun: false } })]);
    expect([restore.status_code, purge.status_code].sort()).toEqual([200, 409]);
    await call("restore", { body: { runId: A } });
    await call("purge", { body: { dryRun: false } });
    for (const id of ["p1", "p2", "p3"]) {
      const live = (await r.kv.get(KV.observations("ses_p"), id)) !== null;
      const tombstone = (await r.kv.get(RETENTION_KV.tombstones, itemKey(obs("ses_p", id)))) !== null;
      const vaulted = (await r.vault.locate(obs("ses_p", id))) !== null;
      expect(vaulted).toBe(false);
      expect(live !== tombstone).toBe(true);
    }
  });
});

describe("readReport", () => {
  it("reads a run's report with its run row, and the latest when no run is named", async () => {
    const r = rig();
    await heldRun(r, ["p1"], "ses_p", "ret_old" as RunId);
    await r.kv.set(RETENTION_KV.reports, "ret_old", { runId: "ret_old", dryRun: false, outcome: "kept" });
    await heldRun(r, ["q1"], "ses_q", "ret_new" as RunId);
    await r.runs.save({ ...(await r.runs.get("ret_new" as RunId))!, startedAt: "2026-09-02T00:00:00.000Z" });
    await r.kv.set(RETENTION_KV.reports, "ret_new", { runId: "ret_new", dryRun: false, outcome: "kept" });

    const named = await readReport(r.deps, "ret_old" as RunId);
    expect(named).toMatchObject({ kind: "found", report: { runId: "ret_old" }, run: { id: "ret_old", phase: "done", outcome: "kept", held: 1, graceDays: 1 } });
    const latest = await readReport(r.deps);
    expect(latest).toMatchObject({ kind: "found", report: { runId: "ret_new" }, run: { id: "ret_new" } });
  });

  it("says when the grace ends and whether the run is purged", async () => {
    const r = rig();
    await heldRun(r);
    const before = await readReport(r.deps, A);
    expect(before).toMatchObject({ kind: "found", run: { graceEndsAt: at(24).toISOString(), purgedAt: null } });
    await r.runs.save({ ...(await r.runs.get(A))!, held: 0, purgedAt: at(25).toISOString() });
    expect(await readReport(r.deps, A)).toMatchObject({ run: { held: 0, purgedAt: at(25).toISOString() } });
  });

  it("returns a run with no stored report as a null report, and answers not-found for no run at all", async () => {
    const r = rig();
    expect(await readReport(r.deps)).toEqual({ kind: "not-found" });
    expect(await readReport(r.deps, "ret_nope" as RunId)).toEqual({ kind: "not-found" });
    await heldRun(r);
    expect(await readReport(r.deps, A)).toMatchObject({ kind: "found", report: null });
  });
});

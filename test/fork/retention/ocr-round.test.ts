// Fix round on the slice 4 Open Code Review: item lock discipline, satellite snapshot under the lock,
// canonical memory fingerprint, restoreItems under the lock with a bounded loop, one search() in detach.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { displace, fingerprintRow, recoverRun, reinstate } from "../../../src/fork/retention/move.js";
import { restoreItems } from "../../../src/fork/retention/restore.js";
import { SATELLITES } from "../../../src/fork/retention/satellites.js";
import { RETENTION_KV, itemKey } from "../../../src/fork/retention/scopes.js";
import type { ItemRef, ObservationRowEntry, RunId } from "../../../src/fork/retention/types.js";
import { Vault } from "../../../src/fork/retention/vault.js";
import { withKeyedLock } from "../../../src/state/keyed-mutex.js";
import type { StateKV } from "../../../src/state/kv.js";
import { KV } from "../../../src/state/schema.js";
import { base64ToFloat32 } from "../../../src/state/vector-index.js";
import type { CompressedObservation, Memory } from "../../../src/types.js";
import { RUN, candidate, liveRow, memory, memoryRuntime, observation, openRun, rig, seedObservation, seedSeal, vec, type Rig } from "./move-fixtures.js";

const OBS: ItemRef = { kind: "observation", sessionId: "ses_1", id: "obs_1" };
const OBS_LOCK = "obs:ses_1";
const OBS_SCOPE = KV.observations("ses_1");
const sleep = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** A StateKV whose members can be overridden; everything else is the target's, bound to it. */
function overriding(kv: StateKV, over: Partial<Record<"get" | "set" | "delete" | "iterate", (...args: any[]) => unknown>>): StateKV {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop in over) return (over as Record<string, unknown>)[prop as string];
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function movedObservation(r: Rig, runId: RunId = RUN) {
  const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
  await seedObservation(r, observation("obs_2"), { seed: 2 });
  const seal = await seedSeal(r, "ses_1", 2);
  await openRun(r, runId);
  await displace(r.deps, r.vault, runId, candidate("O", row, seal));
  return { row, seal };
}

/** A vault whose run scope is read in full, then held back until `release`, so recoverRun works from entries that go stale. */
function pausedPages(r: Rig, runId: RunId) {
  const read = deferred();
  const resume = deferred();
  const kv = overriding(r.kv, {
    iterate: async function* (scope: string, opts: never) {
      const pages: unknown[] = [];
      for await (const page of r.kv.iterate(scope, opts)) pages.push(page);
      if (scope === RETENTION_KV.vault(runId)) {
        read.release();
        await resume.promise;
      }
      yield* pages as never[];
    },
  });
  return { vault: new Vault(kv), read: read.promise, resume: resume.release };
}

describe("finding 1: recoverRun writes the locator and settles under the item lock, from the entry as it is now", () => {
  async function crashedMove() {
    const r = rig();
    await movedObservation(r);
    await r.kv.delete(RETENTION_KV.items, itemKey(OBS));
    return r;
  }

  it("does not let a stale entry overwrite a restore under way, and does not delete the restored row", async () => {
    const r = await crashedMove();
    const stale = (await r.vault.get(RUN, OBS))!;
    const paused = pausedPages(r, RUN);
    const recovering = recoverRun(r.deps, paused.vault, RUN);
    await paused.read;

    const rowWrite = deferred();
    const atRowWrite = deferred();
    const restoringDeps = {
      ...r.deps,
      kv: overriding(r.kv, {
        set: async (scope: string, key: string, value: unknown) => {
          if (scope === OBS_SCOPE && key === "obs_1") {
            atRowWrite.release();
            await rowWrite.promise;
          }
          return r.kv.set(scope, key, value);
        },
      }),
    };
    const restoring = reinstate(restoringDeps, r.vault, stale);
    await atRowWrite.promise;
    expect(((await r.vault.get(RUN, OBS)) as ObservationRowEntry).restoring).toBe(true);

    paused.resume();
    await sleep();
    rowWrite.release();
    await Promise.all([recovering, restoring]);

    expect(await liveRow(r, OBS_SCOPE, "obs_1")).not.toBeNull();
    expect(await r.vault.get(RUN, OBS)).toBeNull();
    expect(await r.vault.locate(OBS)).toBeNull();
  });

  it("does not bring back an entry that a restore took after recoverRun read its page", async () => {
    const r = await crashedMove();
    const stale = (await r.vault.get(RUN, OBS))!;
    const paused = pausedPages(r, RUN);
    const recovering = recoverRun(r.deps, paused.vault, RUN);
    await paused.read;

    await reinstate(r.deps, r.vault, stale);
    paused.resume();
    await recovering;

    expect(await liveRow(r, OBS_SCOPE, "obs_1")).not.toBeNull();
    expect(await r.vault.get(RUN, OBS)).toBeNull();
    expect(await r.vault.locate(OBS)).toBeNull();
  });

  it("repairs a lost locator without inverting the stack when a later run holds the key", async () => {
    const r = rig();
    const A = "ret_a" as RunId;
    const B = "ret_b" as RunId;
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, A, candidate("T", row, seal));
    await r.kv.delete(RETENTION_KV.items, itemKey(OBS));
    const trimmed = (await liveRow<CompressedObservation>(r, OBS_SCOPE, "obs_1"))!;
    const later = { ...r.deps, now: () => new Date("2026-09-02T00:00:00.000Z") };
    await displace(later, r.vault, B, candidate("O", trimmed, seal));
    expect(await r.vault.locate(OBS)).toEqual({ runId: B, stage: "O" });

    await recoverRun(r.deps, r.vault, A);

    expect(await r.vault.locate(OBS)).toEqual({ runId: B, stage: "O", under: { runId: A, stage: "T" } });
  });
});

describe("finding 2: displace snapshots the satellites under the item lock", () => {
  it("snapshots the newer vector a writer attached while displace waited for the lock", async () => {
    const r = rig();
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    let moving!: ReturnType<typeof displace>;

    await withKeyedLock(OBS_LOCK, async () => {
      moving = displace(r.deps, r.vault, RUN, candidate("O", row, seal));
      await sleep();
      r.runtime.vector.add("obs_1", "ses_1", vec(2));
    });
    await moving;

    const entry = (await r.vault.get(RUN, OBS)) as ObservationRowEntry;
    expect(base64ToFloat32(entry.satellites.vector!)).toEqual(vec(2));
  });

  it("releases the lock when the snapshot rejects, so the row can be moved afterwards", async () => {
    const r = rig();
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    let reads = 0;
    const flaky = { canRead: true, read: (ids: readonly string[]) => (reads++ === 0 ? Promise.reject(new Error("down")) : r.deps.vectors.read(ids)) };

    expect(await displace({ ...r.deps, vectors: flaky }, r.vault, RUN, candidate("O", row, seal))).toMatchObject({ moved: false, skipped: "unreadable" });
    expect(await displace({ ...r.deps, vectors: flaky }, r.vault, RUN, candidate("O", row, seal))).toMatchObject({ moved: true });
  });
});

describe("finding 3: the memory fingerprint does not depend on key order", () => {
  const reordered = <T extends object>(row: T): T => Object.fromEntries(Object.entries(row).reverse()) as T;

  it("is the same for one memory built with its keys in another order, nested keys included", () => {
    const row = memory("mem_1", { consolidationKeys: { a: "1", b: "2" }, relatedIds: ["x", "y"] });
    const shuffled = { ...reordered(row), consolidationKeys: reordered(row.consolidationKeys!) };
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(row));
    expect(fingerprintRow(shuffled)).toBe(fingerprintRow(row));
  });

  it("still changes with any field the stage S, X and C paths read or write, nested values and array order included", () => {
    const row = memory("mem_1", { consolidationKeys: { a: "1" }, relatedIds: ["x", "y"] });
    const base = fingerprintRow(row);
    for (const changed of [
      { isLatest: false }, { forgetAfter: "2026-03-01T00:00:00.000Z" }, { supersedes: ["mem_0"] }, { strength: 2 }, { content: "other" },
      { consolidationKeys: { a: "2" } }, { relatedIds: ["y", "x"] }, { retention: { demotedAt: "2026-05-01T00:00:00.000Z" } },
    ] as Partial<Memory>[]) {
      expect(fingerprintRow({ ...row, ...changed }), JSON.stringify(changed)).not.toBe(base);
    }
  });
});

describe("finding 4: settle treats a missing row like the rest of the file", () => {
  it("detaches again when the store answers undefined for a row that is gone", async () => {
    const r = rig();
    await movedObservation(r);
    const deps = { ...r.deps, kv: overriding(r.kv, { get: async (scope: string, key: string) => (await r.kv.get(scope, key)) ?? undefined }) };

    expect(await recoverRun(deps, r.vault, RUN)).toEqual({ finished: 0, detachedAgain: 1 });
  });
});

describe("findings 6 and 7: restoreItems claims under the item lock and stops on a claim it has seen", () => {
  it("does not drop a stale claim while another writer holds the item lock", async () => {
    const r = rig();
    await r.kv.set(RETENTION_KV.items, itemKey(OBS), { runId: "ret_ghost", stage: "O" });
    let restoring!: Promise<unknown>;

    await withKeyedLock(OBS_LOCK, async () => {
      restoring = restoreItems(r.deps, [OBS], "test");
      await sleep();
      expect(await r.vault.locate(OBS)).toEqual({ runId: "ret_ghost", stage: "O" });
    });
    await restoring;

    expect(await r.vault.locate(OBS)).toBeNull();
  });

  const stickyLocator = (r: Rig, locates: { count: number }) =>
    overriding(r.kv, {
      get: (scope: string, key: string) => {
        if (scope === RETENTION_KV.items && ++locates.count > 50) throw new Error("restoreItems read the locator over 50 times");
        return r.kv.get(scope, key);
      },
      set: (scope: string, key: string, value: unknown) => (scope === RETENTION_KV.items ? Promise.resolve(value) : r.kv.set(scope, key, value)),
      delete: (scope: string, key: string) => (scope === RETENTION_KV.items ? Promise.resolve() : r.kv.delete(scope, key)),
    });

  it("terminates when the locator keeps naming a run whose entry is gone", async () => {
    const r = rig();
    await r.kv.set(RETENTION_KV.items, itemKey(OBS), { runId: "ret_ghost", stage: "O" });
    const locates = { count: 0 };

    const result = await restoreItems({ ...r.deps, kv: stickyLocator(r, locates) }, [OBS], "test");

    expect(result).toMatchObject({ restored: 0, keptLive: 0 });
  });

  it("terminates when the locator keeps naming a run whose entry was just restored", async () => {
    const r = rig();
    await movedObservation(r);
    const locates = { count: 0 };

    const result = await restoreItems({ ...r.deps, kv: stickyLocator(r, locates) }, [OBS], "test");

    expect(result).toMatchObject({ restored: 1, keptLive: 0 });
    expect(await liveRow(r, OBS_SCOPE, "obs_1")).not.toBeNull();
  });
});

describe("finding 8: detach resolves the search runtime once", () => {
  it("schedules the save on the runtime it removed the doc from", async () => {
    const r = rig();
    const { row } = await movedObservation(r);
    const entry = (await r.vault.get(RUN, OBS)) as ObservationRowEntry;
    const removedFrom = new Set<unknown>();
    const savedOn = new Set<unknown>();
    const fresh = () => {
      const runtime = memoryRuntime();
      const remove = runtime.keyword.remove.bind(runtime.keyword);
      runtime.keyword.remove = (id: string) => (removedFrom.add(runtime), remove(id));
      runtime.openPersistence = () => ({ scheduleSave: () => void savedOn.add(runtime) }) as never;
      return runtime;
    };
    const search = vi.fn(fresh);
    const searchIndex = SATELLITES.find((s) => s.name === "search-index")!;

    await searchIndex.detach!({ ...r.deps, search }, { ...entry, row });

    expect(removedFrom.size).toBe(1);
    expect([...savedOn]).toEqual([...removedFrom]);
  });
});

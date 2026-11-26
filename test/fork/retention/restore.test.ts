import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { displace } from "../../../src/fork/retention/move.js";
import { restoreItems, restoreRun } from "../../../src/fork/retention/restore.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { ItemRef, RunId, RunRow } from "../../../src/fork/retention/types.js";
import { setEmbeddingProvider, setVectorIndex } from "../../../src/functions/search.js";
import { KV } from "../../../src/state/schema.js";
import type { AuditEntry, CompressedObservation, EmbeddingProvider, Memory, Session } from "../../../src/types.js";
import {
  DIMS, RUN, candidate, keywordHits, liveRow, memory, observation, openRun, rig, seedMemory, seedObservation, seedSeal, vectorHits, type Rig,
} from "./move-fixtures.js";

const obsRef = (id: string, sessionId = "ses_1"): ItemRef => ({ kind: "observation", sessionId, id });
const memRef = (id: string): ItemRef => ({ kind: "memory", id });

const spy = { embed: vi.fn(), embedBatch: vi.fn() };
const provider = { name: "spy", dimensions: DIMS, embed: spy.embed, embedBatch: spy.embedBatch } as unknown as EmbeddingProvider;

beforeEach(() => {
  spy.embed.mockReset().mockImplementation(async () => new Float32Array(DIMS).fill(0.5));
  spy.embedBatch.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.5)));
  setEmbeddingProvider(provider);
});

async function sweepMove(r: Rig, items: ReturnType<typeof candidate>[]) {
  let held = 0;
  for (const item of items) if ((await displace(r.deps, r.vault, RUN, item)).moved) held++;
  const run = (await r.runs.get(RUN))!;
  await r.runs.save({ ...run, held });
}

describe("R3 in memory mode: a soft-deleted observation and expired memory leave recall at once and come back unchanged", () => {
  it("leaves keyword and vector recall at once, then returns with the same content, the session count and no embedding call", async () => {
    const r = rig();
    setVectorIndex(r.runtime.vector);
    await openRun(r);
    const o = await seedObservation(r, observation("obs_1"), { seed: 1 });
    await seedObservation(r, observation("obs_2"), { seed: 2 });
    const m = await seedMemory(r, memory("mem_1"), { seed: 7 });
    const seal = await seedSeal(r, "ses_1", 2);
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1", "obs_2"]);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_1"]);
    expect(await vectorHits(r, 1)).toContain("obs_1");
    expect(await vectorHits(r, 7)).toContain("mem_1");
    const countBefore = (await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount;
    expect(countBefore).toBe(2);

    await sweepMove(r, [candidate("O", o, seal), candidate("X", m)]);

    expect(await keywordHits(r, "zebra")).toEqual(["obs_2"]);
    expect(await keywordHits(r, "okapi")).toEqual([]);
    expect(await vectorHits(r, 1)).not.toContain("obs_1");
    expect(await vectorHits(r, 7)).not.toContain("mem_1");
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(1);

    const result = await restoreRun(r.deps, RUN, "test");

    expect(result).toMatchObject({ restored: 2, keptLive: 0, reembedNeeded: 0, deferred: 0 });
    expect(await liveRow<CompressedObservation>(r, KV.observations("ses_1"), "obs_1")).toEqual(o);
    expect(await liveRow<Memory>(r, KV.memories, "mem_1")).toEqual(m);
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1", "obs_2"]);
    expect(await keywordHits(r, "okapi")).toEqual(["mem_1"]);
    expect(await vectorHits(r, 1)).toContain("obs_1");
    expect(await vectorHits(r, 7)).toContain("mem_1");
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(countBefore);
    expect(spy.embed).not.toHaveBeenCalled();
    expect(spy.embedBatch).not.toHaveBeenCalled();
    setVectorIndex(null);
  });
});

describe("R11: stored observation counts equal stored rows after a sweep move and a restore", () => {
  it("repairs a drifted count at move time and keeps every session exact through the restore", async () => {
    const r = rig();
    await openRun(r);
    const rowsA = [observation("a1", "ses_a"), observation("a2", "ses_a"), observation("a3", "ses_a")];
    const rowsB = [observation("b1", "ses_b"), observation("b2", "ses_b")];
    for (const row of [...rowsA, ...rowsB]) await seedObservation(r, row, { seed: 3 });
    const sealA = await seedSeal(r, "ses_a", 3);
    const sealB = await seedSeal(r, "ses_b", 2);
    await r.kv.update(KV.sessions, "ses_a", [{ type: "set", path: "observationCount", value: 99 }]);

    const counts = async () => Promise.all(["ses_a", "ses_b"].map(async (id) => [(await r.kv.get<Session>(KV.sessions, id))!.observationCount, (await r.kv.listKeys(KV.observations(id))).length]));
    const exact = async () => (await counts()).every(([stored, rows]) => stored === rows);

    await sweepMove(r, [candidate("O", rowsA[0]!, sealA), candidate("O", rowsA[1]!, sealA), candidate("O", rowsB[0]!, sealB)]);
    expect(await counts()).toEqual([[1, 1], [1, 1]]);
    expect(await exact()).toBe(true);

    await restoreRun(r.deps, RUN, "test");
    expect(await counts()).toEqual([[3, 3], [2, 2]]);
    expect(await exact()).toBe(true);
  });

  it("a session whose rows all moved has a count of zero, and comes back whole", async () => {
    const r = rig();
    await openRun(r);
    const rows = [observation("a1", "ses_a"), observation("a2", "ses_a")];
    for (const row of rows) await seedObservation(r, row);
    const seal = await seedSeal(r, "ses_a", 2);
    await sweepMove(r, rows.map((row) => candidate("O", row, seal)));
    expect((await r.kv.get<Session>(KV.sessions, "ses_a"))!.observationCount).toBe(0);
    await restoreRun(r.deps, RUN, "test");
    expect((await r.kv.get<Session>(KV.sessions, "ses_a"))!.observationCount).toBe(2);
  });
});

describe("restoreRun", () => {
  it("records why on the run row, lowers held, and writes one retention_restore audit entry", async () => {
    const r = rig();
    await openRun(r);
    const o = await seedObservation(r, observation("obs_1"));
    const seal = await seedSeal(r, "ses_1", 1);
    const m = await seedMemory(r, memory("mem_1"));
    await sweepMove(r, [candidate("O", o, seal), candidate("X", m)]);
    expect((await r.runs.get(RUN))!.held).toBe(2);

    await restoreRun(r.deps, RUN, "recall dropped 3 points");

    const run = (await r.runs.get(RUN)) as RunRow;
    expect(run).toMatchObject({ restoredBecause: "recall dropped 3 points", held: 0 });
    expect((await r.vault.get(RUN, obsRef("obs_1")))).toBeNull();
    expect(r.h.store.get(RETENTION_KV.vault(RUN))?.size ?? 0).toBe(0);
    const audits = [...r.h.store].filter(([scope]) => /^mem:audit:\d{4}-/.test(scope)).flatMap(([, rows]) => [...rows.values()]) as AuditEntry[];
    expect(audits.filter((a) => a.operation === "retention_restore")).toHaveLength(1);
    expect(audits[0]).toMatchObject({ operation: "retention_restore", details: { runId: RUN, why: "recall dropped 3 points", restored: 2 } });
  });

  it("is idempotent: a second restore of the same run restores nothing and changes nothing", async () => {
    const r = rig();
    await openRun(r);
    const o = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await sweepMove(r, [candidate("O", o, seal)]);
    await restoreRun(r.deps, RUN, "first");
    const again = await restoreRun(r.deps, RUN, "second");
    expect(again).toMatchObject({ restored: 0, keptLive: 0 });
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1"]);
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(1);
  });

  it("counts a row that was recaptured since as kept live, and a row without a stored vector as needing the re-embed loop", async () => {
    const r = rig();
    await openRun(r);
    const kept = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const bare = await seedObservation(r, observation("obs_2"));
    const seal = await seedSeal(r, "ses_1", 2);
    await sweepMove(r, [candidate("O", kept, seal), candidate("O", bare, seal)]);
    await r.kv.set(KV.observations("ses_1"), "obs_1", { ...kept, title: "recaptured" });

    expect(await restoreRun(r.deps, RUN, "test")).toMatchObject({ restored: 1, keptLive: 1, reembedNeeded: 1 });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_2")).toEqual(bare);
  });

  it("restores a run that has no run row, and does not create one", async () => {
    const r = rig();
    const o = await seedObservation(r, observation("obs_1"));
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, "ret_orphan" as RunId, candidate("O", o, seal));
    expect(await restoreRun(r.deps, "ret_orphan" as RunId, "test")).toMatchObject({ restored: 1 });
    expect(await r.runs.get("ret_orphan" as RunId)).toBeNull();
  });
});

describe("restoreItems", () => {
  it("restores single items by ref and leaves the rest of the run in the vault", async () => {
    const r = rig();
    await openRun(r);
    const a = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const b = await seedObservation(r, observation("obs_2"), { seed: 2 });
    const m = await seedMemory(r, memory("mem_1"), { seed: 7 });
    const seal = await seedSeal(r, "ses_1", 2);
    await sweepMove(r, [candidate("O", a, seal), candidate("O", b, seal), candidate("X", m)]);

    const result = await restoreItems(r.deps, [obsRef("obs_1"), memRef("mem_1"), obsRef("obs_missing")], "owner asked");

    expect(result).toMatchObject({ restored: 2, keptLive: 0 });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(a);
    expect(await liveRow(r, KV.memories, "mem_1")).toEqual(m);
    expect(await liveRow(r, KV.observations("ses_1"), "obs_2")).toBeNull();
    expect(await r.vault.get(RUN, obsRef("obs_2"))).not.toBeNull();
    expect((await r.runs.get(RUN))!.held).toBe(1);
  });

  it("finds an observation by its session: the same id in another session is a different item", async () => {
    const r = rig();
    await openRun(r);
    const a = await seedObservation(r, observation("obs_dup", "ses_a"));
    const seal = await seedSeal(r, "ses_a", 1);
    await sweepMove(r, [candidate("O", a, seal)]);
    expect(await restoreItems(r.deps, [obsRef("obs_dup", "ses_b")], "test")).toMatchObject({ restored: 0 });
    expect(await restoreItems(r.deps, [obsRef("obs_dup", "ses_a")], "test")).toMatchObject({ restored: 1 });
  });

  it("restores a trimmed and then trashed observation completely from one ref, newest entry first", async () => {
    const r = rig();
    const A = "ret_a" as RunId;
    const B = "ret_b" as RunId;
    await openRun(r, A);
    await openRun(r, B);
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, A, candidate("T", row, seal));
    await displace(r.deps, r.vault, B, candidate("O", (await liveRow<CompressedObservation>(r, KV.observations("ses_1"), "obs_1"))!, seal));
    await r.runs.save({ ...(await r.runs.get(A))!, held: 1 });
    await r.runs.save({ ...(await r.runs.get(B))!, held: 1 });

    const result = await restoreItems(r.deps, [obsRef("obs_1")], "owner asked");

    expect(result).toMatchObject({ restored: 2 });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(row);
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1"]);
    expect([(await r.runs.get(A))!.held, (await r.runs.get(B))!.held]).toEqual([0, 0]);
    expect(await r.vault.locate(obsRef("obs_1"))).toBeNull();
  });

  it("restoring the trim's run while the row sits in a later run's vault keeps the raw source, and restoring that run first then finishes it", async () => {
    const r = rig();
    const A = "ret_a" as RunId;
    const B = "ret_b" as RunId;
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, A, candidate("T", row, seal));
    await displace(r.deps, r.vault, B, candidate("O", (await liveRow<CompressedObservation>(r, KV.observations("ses_1"), "obs_1"))!, seal));

    expect(await restoreRun(r.deps, A, "test")).toMatchObject({ restored: 0, deferred: 1 });
    expect(await r.vault.get(A, obsRef("obs_1"))).toMatchObject({ stage: "T", source: row.source });

    await restoreRun(r.deps, B, "test");
    expect(await restoreRun(r.deps, A, "test")).toMatchObject({ restored: 1 });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(row);
  });
});


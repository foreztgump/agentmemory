// R12, crash half: a crash after every write of displace and of reinstate, then recoverRun.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { displace, fingerprintRow, recoverRun, reinstate } from "../../../src/fork/retention/move.js";
import { restoreRun } from "../../../src/fork/retention/restore.js";
import type { ItemRef, TrimEntry } from "../../../src/fork/retention/types.js";
import { lookupObservationSession } from "../../../src/state/obs-index.js";
import { KV } from "../../../src/state/schema.js";
import { captureEventScope, type CompletedEvent } from "../../../src/capture/event-record.js";
import type { CompressedObservation, Memory, Session } from "../../../src/types.js";
import { Crash, crashed, crashingAt } from "./crash.js";
import {
  RUN, candidate, captureKeyOf, keywordHits, liveRow, memory, observation, openRun, rig, seedMemory, seedObservation, seedSeal, vectorHits, vec,
} from "./move-fixtures.js";

const OBS: ItemRef = { kind: "observation", sessionId: "ses_1", id: "obs_1" };
const MEM: ItemRef = { kind: "memory", id: "mem_1" };
const MAX_WRITES = 40;

async function observationFixture() {
  const r = rig();
  const row = await seedObservation(r, observation("obs_1"), { seed: 1, captureKey: captureKeyOf(1) });
  await seedObservation(r, observation("obs_2"), { seed: 2 });
  const seal = await seedSeal(r, "ses_1", 2);
  await openRun(r);
  return { r, row, seal, ref: OBS, scope: KV.observations("ses_1"), cleared: await candidate(r, "O", row, seal), query: "zebra", seed: 1, keep: "obs_2" };
}

async function memoryFixture() {
  const r = rig();
  const row = await seedMemory(r, memory("mem_1"), { seed: 7 });
  await seedMemory(r, memory("mem_2"), { seed: 8 });
  await openRun(r);
  return { r, row, ref: MEM, scope: KV.memories, cleared: await candidate(r, "X", row), query: "okapi", seed: 7, keep: "mem_2" };
}

async function trimFixture() {
  const r = rig();
  const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
  const seal = await seedSeal(r, "ses_1", 1);
  await openRun(r);
  return { r, row, seal, cleared: await candidate(r, "T", row, seal) };
}

type Fixture = Awaited<ReturnType<typeof observationFixture>> | Awaited<ReturnType<typeof memoryFixture>>;

/** No item is both live and in the vault, nothing is lost, and what is left is wholly the moved state or wholly the live one. */
async function assertSettled(f: Fixture, expectMoved?: boolean) {
  const { r } = f;
  const live = await liveRow<CompressedObservation | Memory>(r, f.scope, f.ref.id);
  const entry = await r.vault.get(RUN, f.ref);
  expect(live !== null && entry !== null, "live and in the vault").toBe(false);
  expect(live !== null || entry !== null, "in neither").toBe(true);
  const hits = await keywordHits(r, f.query);
  const vectors = await vectorHits(r, f.seed);
  if (entry) {
    expect(entry.satellites.vector).toBeDefined();
    expect(hits).toEqual([f.keep]);
    expect(vectors).not.toContain(f.ref.id);
    expect(await r.vault.locate(f.ref)).toEqual({ runId: RUN, stage: entry.stage });
  } else {
    expect(hits).toContain(f.ref.id);
    expect(vectors).toContain(f.ref.id);
    expect(await r.vault.locate(f.ref)).toBeNull();
  }
  if (f.ref.kind === "observation") {
    const rows = (await r.kv.listKeys(f.scope)).length;
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(rows);
    expect(await lookupObservationSession(r.kv, f.ref.id)).toBe(entry ? null : "ses_1");
    const event = await r.kv.get<CompletedEvent>(captureEventScope(captureKeyOf(1)), captureKeyOf(1));
    expect(event?.state === "deleted").toBe(entry !== null);
  }
  if (expectMoved !== undefined) expect(entry !== null).toBe(expectMoved);
}

async function everyCrashPoint(make: () => Promise<Fixture>, drive: (f: Fixture, n: number) => Promise<void>, after: (f: Fixture, crashedHere: boolean) => Promise<void>) {
  let points = 0;
  for (let n = 1; n <= MAX_WRITES; n++) {
    const f = await make();
    let crashedHere = false;
    try {
      await drive(f, n);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      crashedHere = true;
    }
    await recoverRun(f.r.deps, f.r.vault, RUN);
    await after(f, crashedHere);
    if (!crashedHere) return points;
    points++;
  }
  throw new Error(`displace or reinstate still writing after ${MAX_WRITES} writes`);
}

describe.each([
  ["an observation (stage O)", observationFixture, 8],
  ["an expired memory (stage X)", memoryFixture, 5],
] as const)("displace of %s", (_name, make, minPoints) => {
  it("is settled by recoverRun after a crash at every write, in the moved state once the vault entry exists", async () => {
    let entryWritten = false;
    const points = await everyCrashPoint(make, async (f, n) => {
      const crashing = crashingAt(f.r.deps, n);
      await displace(crashing.deps, crashing.vault, RUN, f.cleared);
    }, async (f, crashedHere) => {
      await assertSettled(f);
      if (!crashedHere) await assertSettled(f, true);
      entryWritten ||= (await f.r.vault.get(RUN, f.ref)) !== null;
    });
    expect(points).toBeGreaterThanOrEqual(minPoints);
    expect(entryWritten).toBe(true);
  });

  it("a second recoverRun changes nothing", async () => {
    const f = await make();
    const crashing = crashingAt(f.r.deps, 4);
    expect(await crashed(() => displace(crashing.deps, crashing.vault, RUN, f.cleared))).toBe(true);
    await recoverRun(f.r.deps, f.r.vault, RUN);
    const state = JSON.stringify([...f.r.h.store].map(([scope, rows]) => [scope, [...rows]]));
    expect(await recoverRun(f.r.deps, f.r.vault, RUN)).toMatchObject({ finished: 0 });
    expect(JSON.stringify([...f.r.h.store].map(([scope, rows]) => [scope, [...rows]]))).toBe(state);
  });

  it("a displace re-run after recovery converges on the moved state", async () => {
    const f = await make();
    const crashing = crashingAt(f.r.deps, 5);
    await crashed(() => displace(crashing.deps, crashing.vault, RUN, f.cleared));
    await recoverRun(f.r.deps, f.r.vault, RUN);
    await displace(f.r.deps, f.r.vault, RUN, f.cleared);
    await assertSettled(f);
  });
});

describe("reinstate", () => {
  it.each([
    ["an observation", observationFixture],
    ["an expired memory", memoryFixture],
  ] as const)("of %s is settled by recoverRun after a crash at every write, and a later restore finishes the job", async (_name, make) => {
    const points = await everyCrashPoint(make, async (f, n) => {
      await displace(f.r.deps, f.r.vault, RUN, f.cleared);
      const entry = (await f.r.vault.get(RUN, f.ref))!;
      const crashing = crashingAt(f.r.deps, n);
      await reinstate(crashing.deps, crashing.vault, entry);
    }, async (f, crashedHere) => {
      await assertSettled(f);
      if (!crashedHere) await assertSettled(f, false);
      await restoreRun(f.r.deps, RUN, "finish");
      await assertSettled(f, false);
      const live = (await liveRow<CompressedObservation | Memory>(f.r, f.scope, f.ref.id))!;
      expect(fingerprintRow(live)).toBe(fingerprintRow(f.row));
      expect(f.r.runtime.vector.readVectors([f.ref.id]).get(f.ref.id)).toEqual(vec(f.seed));
    });
    expect(points).toBeGreaterThanOrEqual(5);
  });

  it("a crashed restore is finished by recoverRun, not undone: the restored row is not deleted again", async () => {
    const f = await observationFixture();
    await displace(f.r.deps, f.r.vault, RUN, f.cleared);
    const entry = (await f.r.vault.get(RUN, f.ref))!;
    let crashPoint = 0;
    for (let n = 1; n <= MAX_WRITES; n++) {
      const probe = crashingAt(f.r.deps, n);
      if (!(await crashed(() => reinstate(probe.deps, probe.vault, entry)))) break;
      if ((await liveRow(f.r, f.scope, "obs_1")) !== null && (await f.r.vault.get(RUN, f.ref)) !== null) {
        crashPoint = n;
        break;
      }
    }
    expect(crashPoint, "a crash point with the row back and the entry still held").toBeGreaterThan(0);

    const result = await recoverRun(f.r.deps, f.r.vault, RUN);

    expect(result.finished).toBe(1);
    expect(await liveRow(f.r, f.scope, "obs_1")).toEqual(f.row);
    expect(await f.r.vault.get(RUN, f.ref)).toBeNull();
    expect(await keywordHits(f.r, "zebra")).toEqual(["obs_1", "obs_2"]);
  });
});

describe("stage T", () => {
  it("settles after a crash at every write: the live row is trimmed once the entry exists, and untouched before", async () => {
    let trimmedWhileEntry = false;
    for (let n = 1; n <= MAX_WRITES; n++) {
      const f = await trimFixture();
      const crashing = crashingAt(f.r.deps, n);
      const crashedHere = await crashed(() => displace(crashing.deps, crashing.vault, RUN, f.cleared));
      const recovered = await recoverRun(f.r.deps, f.r.vault, RUN);
      const live = (await liveRow<CompressedObservation>(f.r, KV.observations("ses_1"), "obs_1"))!;
      const entry = (await f.r.vault.get(RUN, OBS)) as TrimEntry | null;
      if (entry) {
        expect(entry.source).toEqual(f.row.source);
        expect(live.source?.truncated).toBe(true);
        trimmedWhileEntry = true;
        expect(fingerprintRow(live)).toBe(entry.rowFingerprint);
      } else {
        expect(live).toEqual(f.row);
      }
      expect(await keywordHits(f.r, "zebra")).toEqual(["obs_1"]);
      expect(recovered.detachedAgain).toBe(0);
      if (!crashedHere) break;
    }
    expect(trimmedWhileEntry).toBe(true);
  });

  it("recoverRun leaves a live row that was rewritten since as it is", async () => {
    const f = await trimFixture();
    const crashing = crashingAt(f.r.deps, 3);
    await crashed(() => displace(crashing.deps, crashing.vault, RUN, f.cleared));
    expect(await f.r.vault.get(RUN, OBS)).not.toBeNull();
    const rewritten = { ...f.row, narrative: "rewritten zebra" };
    await f.r.kv.set(KV.observations("ses_1"), "obs_1", rewritten);

    expect(await recoverRun(f.r.deps, f.r.vault, RUN)).toMatchObject({ finished: 0 });
    expect(await liveRow(f.r, KV.observations("ses_1"), "obs_1")).toEqual(rewritten);
  });

  it("a crashed trim restore is finished by recoverRun, and the raw source stays", async () => {
    const f = await trimFixture();
    await displace(f.r.deps, f.r.vault, RUN, f.cleared);
    const entry = (await f.r.vault.get(RUN, OBS))!;
    const crashing = crashingAt(f.r.deps, 3);
    expect(await crashed(() => reinstate(crashing.deps, crashing.vault, entry))).toBe(true);
    expect(((await liveRow<CompressedObservation>(f.r, KV.observations("ses_1"), "obs_1"))!).source).toEqual(f.row.source);

    await recoverRun(f.r.deps, f.r.vault, RUN);

    expect(((await liveRow<CompressedObservation>(f.r, KV.observations("ses_1"), "obs_1"))!).source).toEqual(f.row.source);
    expect(await f.r.vault.get(RUN, OBS)).toBeNull();
  });
});

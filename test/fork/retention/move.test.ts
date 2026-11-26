import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { captureEventScope, type CompletedEvent } from "../../../src/capture/event-record.js";
import { displace, fingerprintRow, reinstate } from "../../../src/fork/retention/move.js";
import { readSessionFacts } from "../../../src/fork/retention/seal.js";
import { RETENTION_KV, itemKey } from "../../../src/fork/retention/scopes.js";
import type { ItemRef, ObservationRowEntry, SessionSeal, TrimEntry } from "../../../src/fork/retention/types.js";
import { lookupObservationSession } from "../../../src/state/obs-index.js";
import { KV } from "../../../src/state/schema.js";
import { base64ToFloat32 } from "../../../src/state/vector-index.js";
import type { CompressedObservation, Memory, Session } from "../../../src/types.js";
import {
  RUN, candidate, captureKeyOf, keywordHits, liveRow, memory, observation, openRun, rig, seedMemory, seedObservation, seedSeal, seedSession, vec, vectorHits,
} from "./move-fixtures.js";

const ref = (id: string, sessionId = "ses_1"): ItemRef => ({ kind: "observation", sessionId, id });

async function stageO() {
  const r = rig();
  const row = await seedObservation(r, observation("obs_1"), { seed: 1, captureKey: captureKeyOf(1) });
  await seedObservation(r, observation("obs_2"), { seed: 2 });
  const seal = await seedSeal(r, "ses_1", 2);
  return { r, row, seal };
}

describe("fingerprintRow", () => {
  it("hashes an observation without its source, so a trim leaves it unchanged, and any summary field changes it", () => {
    const row = observation("obs_1");
    const trimmed = { ...row, source: { hookType: "post_tool_use" as const, originalBytes: 4000, truncated: true } };
    expect(fingerprintRow(trimmed)).toBe(fingerprintRow(row));
    expect(fingerprintRow({ ...row, title: "other" })).not.toBe(fingerprintRow(row));
    expect(fingerprintRow({ ...row, narrative: "other" })).not.toBe(fingerprintRow(row));
    expect(fingerprintRow({ ...row, facts: ["x"] })).not.toBe(fingerprintRow(row));
  });

  it("hashes the whole memory row", () => {
    const row = memory("mem_1");
    expect(fingerprintRow(row)).toBe(fingerprintRow({ ...row }));
    expect(fingerprintRow({ ...row, strength: 2 })).not.toBe(fingerprintRow(row));
  });
});

describe("displace, stage O", () => {
  it("moves the row to the vault and detaches every satellite", async () => {
    const { r, row, seal } = await stageO();
    const result = await displace(r.deps, r.vault, RUN, candidate("O", row, seal));

    expect(result).toMatchObject({ moved: true });
    expect(result.bytes).toBeGreaterThan(0);
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toBeNull();
    expect(await liveRow(r, KV.observations("ses_1"), "obs_2")).not.toBeNull();
    expect(await keywordHits(r, "zebra")).toEqual(["obs_2"]);
    expect(await vectorHits(r, 1)).not.toContain("obs_1");
    expect(await lookupObservationSession(r.kv, "obs_1")).toBeNull();
    expect(await lookupObservationSession(r.kv, "obs_2")).toBe("ses_1");
    expect((await r.kv.get<CompletedEvent>(captureEventScope(captureKeyOf(1)), captureKeyOf(1)))?.state).toBe("deleted");
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(1);
    expect((await r.kv.get<SessionSeal>(RETENTION_KV.seals, "ses_1"))?.trimmed).toBe(true);

    const entry = (await r.vault.get(RUN, ref("obs_1"))) as ObservationRowEntry;
    expect(entry).toMatchObject({ stage: "O", runId: RUN, project: "proj", row, rowFingerprint: fingerprintRow(row) });
    expect(base64ToFloat32(entry.satellites.vector!)).toEqual(vec(1));
    expect(entry.satellites.captureEvent).toMatchObject({ observationId: "obs_1", eventId: "evc_obs_1" });
    expect(await r.vault.locate(ref("obs_1"))).toEqual({ runId: RUN, stage: "O" });
  });

  it("refuses a row whose vector cannot be read back, and changes nothing", async () => {
    const { r, row, seal } = await stageO();
    const deps = { ...r.deps, vectors: { canRead: false, read: () => Promise.reject(new Error("backend down")) } };
    const writes = r.h.stateOps.length;

    const result = await displace(deps, r.vault, RUN, candidate("O", row, seal));

    expect(result).toMatchObject({ moved: false, skipped: "unreadable" });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(row);
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1", "obs_2"]);
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
    expect((await r.kv.get<SessionSeal>(RETENTION_KV.seals, "ses_1"))?.trimmed).toBe(false);
    expect(r.h.stateOps.slice(writes).filter((op) => /state::(set|delete|update)/.test(op))).toEqual([]);
  });

  it("skips a row that was rewritten after the plan read it", async () => {
    const { r, row, seal } = await stageO();
    await r.kv.set(KV.observations("ses_1"), "obs_1", { ...row, title: "recompressed" });

    const result = await displace(r.deps, r.vault, RUN, candidate("O", row, seal));

    expect(result).toMatchObject({ moved: false, skipped: "row-changed" });
    expect((await liveRow<CompressedObservation>(r, KV.observations("ses_1"), "obs_1"))?.title).toBe("recompressed");
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1", "obs_2"]);
  });

  it("skips a row that is already gone", async () => {
    const { r, row, seal } = await stageO();
    await r.kv.delete(KV.observations("ses_1"), "obs_1");
    expect(await displace(r.deps, r.vault, RUN, candidate("O", row, seal))).toMatchObject({ moved: false, skipped: "gone" });
  });

  it("marks the seal trimmed even when the stored seal was dropped, from the proof it was given", async () => {
    const { r, row, seal } = await stageO();
    await r.kv.delete(RETENTION_KV.seals, "ses_1");
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    expect(await r.kv.get<SessionSeal>(RETENTION_KV.seals, "ses_1")).toMatchObject({ sessionId: "ses_1", trimmed: true });
  });

  it("leaves another session's index doc, vector and session index alone when the observation id repeats", async () => {
    const r = rig();
    const a = await seedObservation(r, observation("obs_dup", "ses_a"), { seed: 1 });
    const seal = await seedSeal(r, "ses_a", 1);
    await seedSession(r, "ses_b");
    const b = observation("obs_dup", "ses_b", { title: "other session", narrative: "narrative of b zebra" });
    await r.kv.set(KV.observations("ses_b"), "obs_dup", b);
    r.runtime.keyword.add(b);
    r.runtime.vector.add("obs_dup", "ses_b", vec(2));

    const result = await displace(r.deps, r.vault, RUN, candidate("O", a, seal));

    expect(result.moved).toBe(true);
    expect(await liveRow(r, KV.observations("ses_b"), "obs_dup")).toEqual(b);
    expect(r.runtime.keyword.sessionOf("obs_dup")).toBe("ses_b");
    expect(await keywordHits(r, "zebra")).toEqual(["obs_dup"]);
    expect(await vectorHits(r, 2)).toEqual(["obs_dup"]);
    const entry = (await r.vault.get(RUN, ref("obs_dup", "ses_a"))) as ObservationRowEntry;
    expect(entry.satellites.vector).toBeUndefined();
  });
});

describe("displace, stage X", () => {
  it("moves an expired memory out of mem:memories and out of both indexes", async () => {
    const r = rig();
    const row = await seedMemory(r, memory("mem_1"), { seed: 7 });
    await seedMemory(r, memory("mem_2"), { seed: 8 });

    const result = await displace(r.deps, r.vault, RUN, candidate("X", row));

    expect(result.moved).toBe(true);
    expect(await liveRow(r, KV.memories, "mem_1")).toBeNull();
    expect(await keywordHits(r, "okapi")).toEqual(["mem_2"]);
    expect(await vectorHits(r, 7)).not.toContain("mem_1");
    const entry = await r.vault.get(RUN, { kind: "memory", id: "mem_1" });
    expect(entry).toMatchObject({ stage: "X", row });
    expect(base64ToFloat32(entry!.satellites.vector!)).toEqual(vec(7));
  });

  it("moves a superseded memory, which is in no index, without inventing a vector", async () => {
    const r = rig();
    const row = await seedMemory(r, memory("mem_old", { isLatest: false }));
    expect((await displace(r.deps, r.vault, RUN, candidate("S", row))).moved).toBe(true);
    expect((await r.vault.get(RUN, { kind: "memory", id: "mem_old" }))?.satellites).toEqual({});
  });
});

describe("displace, stage T", () => {
  it("vaults the raw source and leaves the row live, indexed and fingerprint-equal", async () => {
    const r = rig();
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    const before = await readSessionFacts(r.kv, (await r.kv.get<Session>(KV.sessions, "ses_1"))!);

    const result = await displace(r.deps, r.vault, RUN, candidate("T", row, seal));

    expect(result.moved).toBe(true);
    expect(result.bytes).toBeGreaterThan(300);
    const live = (await liveRow<CompressedObservation>(r, KV.observations("ses_1"), "obs_1"))!;
    expect(live.source).toEqual({ hookType: "post_tool_use", originalBytes: 4000, truncated: true });
    expect({ ...live, source: undefined }).toEqual({ ...row, source: undefined });
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1"]);
    expect(await vectorHits(r, 1)).toEqual(["obs_1"]);
    expect(fingerprintRow(live)).toBe(fingerprintRow(row));
    expect(await readSessionFacts(r.kv, (await r.kv.get<Session>(KV.sessions, "ses_1"))!)).toEqual(before);
    expect((await r.kv.get<SessionSeal>(RETENTION_KV.seals, "ses_1"))?.trimmed).toBe(false);
    const entry = (await r.vault.get(RUN, ref("obs_1"))) as TrimEntry;
    expect(entry).toMatchObject({ stage: "T", source: row.source, rowFingerprint: fingerprintRow(row), satellites: {} });
  });

  it("does nothing for a row whose source is already truncated or absent", async () => {
    const r = rig();
    const truncated = await seedObservation(r, observation("obs_1", "ses_1", { source: { hookType: "post_tool_use", originalBytes: 9, truncated: true } }));
    const bare = await seedObservation(r, observation("obs_2", "ses_1", { source: undefined }));
    const seal = await seedSeal(r, "ses_1", 2);
    expect(await displace(r.deps, r.vault, RUN, candidate("T", truncated, seal))).toMatchObject({ moved: false, skipped: "nothing-to-trim" });
    expect(await displace(r.deps, r.vault, RUN, candidate("T", bare, seal))).toMatchObject({ moved: false, skipped: "nothing-to-trim" });
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
  });
});

describe("reinstate", () => {
  it("puts the row, the index doc, the stored vector, the capture event and the count back, and empties the vault", async () => {
    const { r, row, seal } = await stageO();
    await openRun(r, RUN, 1);
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    const entry = (await r.vault.get(RUN, ref("obs_1")))!;

    const result = await reinstate(r.deps, r.vault, entry);

    expect(result).toEqual({ restored: true, reembedNeeded: false });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(row);
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1", "obs_2"]);
    expect(await vectorHits(r, 1)).toContain("obs_1");
    expect(r.runtime.vector.readVectors(["obs_1"]).get("obs_1")).toEqual(vec(1));
    expect(await lookupObservationSession(r.kv, "obs_1")).toBe("ses_1");
    expect((await r.kv.get<CompletedEvent>(captureEventScope(captureKeyOf(1)), captureKeyOf(1)))?.state).toBeUndefined();
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(2);
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
    expect(await r.vault.locate(ref("obs_1"))).toBeNull();
  });

  it("reports a row that had no stored vector as needing the re-embed loop, and still restores it", async () => {
    const r = rig();
    const row = await seedObservation(r, observation("obs_1"));
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    const result = await reinstate(r.deps, r.vault, (await r.vault.get(RUN, ref("obs_1")))!);
    expect(result).toEqual({ restored: true, reembedNeeded: true });
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1"]);
  });

  it("keeps a live row that was written since the move and drops the entry", async () => {
    const { r, row, seal } = await stageO();
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    const recaptured = { ...row, title: "recaptured" };
    await r.kv.set(KV.observations("ses_1"), "obs_1", recaptured);

    const result = await reinstate(r.deps, r.vault, (await r.vault.get(RUN, ref("obs_1")))!);

    expect(result).toEqual({ restored: false, reembedNeeded: false });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(recaptured);
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
    expect(await keywordHits(r, "zebra")).toEqual(["obs_2"]);
  });

  it("is idempotent: finishing an entry whose row already came back adds nothing twice", async () => {
    const { r, row, seal } = await stageO();
    await displace(r.deps, r.vault, RUN, candidate("O", row, seal));
    const entry = (await r.vault.get(RUN, ref("obs_1")))!;
    await reinstate(r.deps, r.vault, entry);
    const again = await reinstate(r.deps, r.vault, entry);

    expect(again.restored).toBe(true);
    expect(await keywordHits(r, "zebra")).toEqual(["obs_1", "obs_2"]);
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))?.observationCount).toBe(2);
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
  });

  it("puts the raw source back on the trimmed live row", async () => {
    const r = rig();
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, RUN, candidate("T", row, seal));

    const result = await reinstate(r.deps, r.vault, (await r.vault.get(RUN, ref("obs_1")))!);

    expect(result).toEqual({ restored: true, reembedNeeded: false });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(row);
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
  });

  it("keeps a trim entry whose row is not live, because the row may come back, and drops one whose live row was rewritten", async () => {
    const r = rig();
    const row = await seedObservation(r, observation("obs_1"));
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, RUN, candidate("T", row, seal));
    const entry = (await r.vault.get(RUN, ref("obs_1")))!;

    await r.kv.delete(KV.observations("ses_1"), "obs_1");
    expect(await reinstate(r.deps, r.vault, entry)).toEqual({ restored: false, reembedNeeded: false, deferred: true });
    expect(await r.vault.get(RUN, ref("obs_1"))).toEqual(entry);

    await r.kv.set(KV.observations("ses_1"), "obs_1", { ...row, title: "rewritten" });
    expect(await reinstate(r.deps, r.vault, entry)).toEqual({ restored: false, reembedNeeded: false });
    expect(await r.vault.get(RUN, ref("obs_1"))).toBeNull();
  });
});

describe("a trim and a later stage O for one observation (slice 1 note: shared key)", () => {
  it("stacks the locator, newest first, and restore by ref walks it back to the raw source", async () => {
    const r = rig();
    const A = "ret_a" as typeof RUN;
    const B = "ret_b" as typeof RUN;
    const row = await seedObservation(r, observation("obs_1"), { seed: 1 });
    const seal = await seedSeal(r, "ses_1", 1);
    await displace(r.deps, r.vault, A, candidate("T", row, seal));
    const trimmedRow = (await liveRow<CompressedObservation>(r, KV.observations("ses_1"), "obs_1"))!;
    await displace(r.deps, r.vault, B, candidate("O", trimmedRow, seal));

    expect(await r.vault.locate(ref("obs_1"))).toEqual({ runId: B, stage: "O", under: { runId: A, stage: "T" } });
    expect(await r.vault.get(A, ref("obs_1"))).toMatchObject({ stage: "T", source: row.source });
    expect(await r.vault.get(B, ref("obs_1"))).toMatchObject({ stage: "O", row: trimmedRow });

    await reinstate(r.deps, r.vault, (await r.vault.get(B, ref("obs_1")))!);
    expect(await r.vault.locate(ref("obs_1"))).toEqual({ runId: A, stage: "T" });
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(trimmedRow);

    await reinstate(r.deps, r.vault, (await r.vault.get(A, ref("obs_1")))!);
    expect(await liveRow(r, KV.observations("ses_1"), "obs_1")).toEqual(row);
    expect(await r.vault.locate(ref("obs_1"))).toBeNull();
    expect(r.h.store.get(RETENTION_KV.items)?.has(itemKey(ref("obs_1")))).toBe(false);
  });
});

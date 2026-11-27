// Slice 7, images: a shared file survives a purge, the reference is released once, and the hold and the parked embedding follow the row.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

const files = vi.hoisted(() => new Set<string>());
const decrementImageRef = vi.hoisted(() => vi.fn());
vi.mock("../../../src/functions/image-refs.js", () => ({ decrementImageRef }));

import { afterForget } from "../../../src/fork/retention/erase.js";
import type { ImageHold } from "../../../src/fork/retention/images.js";
import { restoreItems, restoreRun } from "../../../src/fork/retention/restore.js";
import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { ItemRef, RunId } from "../../../src/fork/retention/types.js";
import { KV } from "../../../src/state/schema.js";
import type { ImageEmbedding } from "../../../src/state/search-ports.js";
import type { StateKV } from "../../../src/state/kv.js";
import { candidate, memory, observation, rig, seedMemory, seedObservation, seedSeal, type Rig } from "./move-fixtures.js";
import { at, clocked, closedRun, done, purge } from "./purge-fixtures.js";
import { vaultKeys } from "./sweep-fixtures.js";

const A = "ret_a" as RunId;
const obs = (id: string, sessionId = "ses_i"): ItemRef => ({ kind: "observation", sessionId, id });
const embeddingOf = (imageRef: string, seed = 1): ImageEmbedding => ({
  imageRef, vector: [seed, 0.5, 0.25, 0.125], modelName: "clip", dimensions: 4, updatedAt: "2026-04-01T00:00:00.000Z", sessionId: "ses_i", observationId: "first",
});

/** What the real decrementImageRef does to the records: the last reference deletes the embedding, the count and the file. */
async function fakeDecrement(kv: StateKV, _sdk: unknown, path: string): Promise<void> {
  const current = Number(await kv.get<number>(KV.imageRefs, path)) || 0;
  if (current <= 1) {
    await kv.delete(KV.imageEmbeddings, path);
    await kv.delete(KV.imageRefs, path);
    files.delete(path);
  } else {
    await kv.set(KV.imageRefs, path, current - 1);
  }
}

async function world() {
  const r = rig();
  const images = { put: vi.fn(), remove: vi.fn(), search: vi.fn() };
  Object.assign(r.runtime, { images });
  return { r, images, ...clocked(r) };
}

async function image(r: Rig, path: string, refs: number, embed = true): Promise<void> {
  files.add(path);
  await r.kv.set(KV.imageRefs, path, refs);
  if (embed) await r.kv.set(KV.imageEmbeddings, path, embeddingOf(path));
}

async function imaged(r: Rig, id: string, path: string, session = "ses_i") {
  const row = await seedObservation(r, observation(id, session, { imageData: path, imageRef: path }), { seed: 1 });
  return { row, seal: await seedSeal(r, session, 1) };
}

const holdOf = (r: Rig, path: string) => r.kv.get<ImageHold>(KV.retentionImageHolds, path);

beforeEach(() => {
  files.clear();
  decrementImageRef.mockReset();
  decrementImageRef.mockImplementation(fakeDecrement);
});

describe("a shared image file", () => {
  it("survives while one referrer is purged, keeping its embedding and search entry for the live row", async () => {
    const { r, images, clock, deps } = await world();
    await image(r, "/img/shared.png", 2);
    const { row, seal } = await imaged(r, "a1", "/img/shared.png");
    await seedObservation(r, observation("b1", "ses_live", { imageData: "/img/shared.png" }), { seed: 2 });
    await closedRun(r, A, [await candidate(r, "O", row, seal)]);

    expect(await holdOf(r, "/img/shared.png")).toEqual({ holders: [itemKey(obs("a1"))] });
    expect(images.remove).not.toHaveBeenCalled();
    expect(await r.kv.get(KV.imageEmbeddings, "/img/shared.png")).not.toBeNull();

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });

    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(decrementImageRef).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/img/shared.png");
    expect(await r.kv.get(KV.imageRefs, "/img/shared.png")).toBe(1);
    expect(files.has("/img/shared.png")).toBe(true);
    expect(await r.kv.get(KV.imageEmbeddings, "/img/shared.png")).not.toBeNull();
    expect(images.remove).not.toHaveBeenCalled();
    expect(await holdOf(r, "/img/shared.png")).toBeNull();
    expect(await r.kv.get(KV.observations("ses_live"), "b1")).not.toBeNull();
  });

  it("is deleted when the last reference is purged", async () => {
    const { r, clock, deps } = await world();
    await image(r, "/img/solo.png", 1);
    const { row, seal } = await imaged(r, "s1", "/img/solo.png");
    await closedRun(r, A, [await candidate(r, "O", row, seal)]);
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });
    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(files.has("/img/solo.png")).toBe(false);
    expect(await r.kv.get(KV.imageRefs, "/img/solo.png")).toBeNull();
    expect(await r.kv.get(KV.imageEmbeddings, "/img/solo.png")).toBeNull();
    expect(await holdOf(r, "/img/solo.png")).toBeNull();
  });

  it("is released in step with each purged row: two vaulted referrers, two releases, the file goes with the second", async () => {
    const { r, clock, deps } = await world();
    await image(r, "/img/two.png", 2);
    const a = await imaged(r, "t1", "/img/two.png");
    const b = await seedObservation(r, observation("t2", "ses_i", { imageData: "/img/two.png" }), { seed: 2 });
    await closedRun(r, A, [await candidate(r, "O", a.row, a.seal), await candidate(r, "O", b, a.seal)]);
    expect(((await holdOf(r, "/img/two.png")) as ImageHold).holders).toHaveLength(2);
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 2 });
    expect(decrementImageRef).toHaveBeenCalledTimes(2);
    expect(files.has("/img/two.png")).toBe(false);
    expect(await holdOf(r, "/img/two.png")).toBeNull();
  });

  it("releases a memory's image reference once", async () => {
    const { r, clock, deps } = await world();
    await image(r, "/img/mem.png", 1, false);
    await seedMemory(r, memory("m_img", { imageRef: "/img/mem.png" }), { seed: 3 });
    await closedRun(r, A, [await candidate(r, "X", (await r.kv.get(KV.memories, "m_img"))!)]);
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });
    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(decrementImageRef).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/img/mem.png");
    expect(files.has("/img/mem.png")).toBe(false);
  });

  it("leaves no hold for a row without an image", async () => {
    const { r } = await world();
    const row = await seedObservation(r, observation("n1", "ses_i"), { seed: 1 });
    await closedRun(r, A, [await candidate(r, "O", row, await seedSeal(r, "ses_i", 1))]);
    expect(await r.kv.listKeys(KV.retentionImageHolds)).toEqual([]);
  });
});

describe("the embedding of an image no live row references", () => {
  it("leaves the records and the search index with the move, and returns with a restore that embeds nothing", async () => {
    const { r, images, clock, deps } = await world();
    await image(r, "/img/p.png", 1);
    const before = await r.kv.get(KV.imageEmbeddings, "/img/p.png");
    const { row, seal } = await imaged(r, "p1", "/img/p.png");
    await closedRun(r, A, [await candidate(r, "O", row, seal)]);

    expect(await r.kv.get(KV.imageEmbeddings, "/img/p.png")).toBeNull();
    expect(images.remove).toHaveBeenCalledWith("/img/p.png");
    expect(await holdOf(r, "/img/p.png")).toEqual({ holders: [itemKey(obs("p1"))], embedding: before });

    clock.now = at(1);
    expect(await restoreRun(deps, A, "test")).toMatchObject({ restored: 1 });
    expect(await r.kv.get(KV.imageEmbeddings, "/img/p.png")).toEqual(before);
    expect(images.put).toHaveBeenCalledWith(before);
    expect(await holdOf(r, "/img/p.png")).toBeNull();
    expect(await r.kv.get(KV.imageRefs, "/img/p.png")).toBe(1);
  });

  it("returns when any one of two vaulted referrers is restored, and stays with the other until it is purged", async () => {
    const { r, images, clock, deps } = await world();
    await image(r, "/img/q.png", 2);
    const a = await imaged(r, "q1", "/img/q.png");
    const b = await seedObservation(r, observation("q2", "ses_i", { imageData: "/img/q.png" }), { seed: 2 });
    await closedRun(r, A, [await candidate(r, "O", a.row, a.seal), await candidate(r, "O", b, a.seal)]);
    expect(await r.kv.get(KV.imageEmbeddings, "/img/q.png")).toBeNull();

    expect(await restoreItems(deps, [obs("q1")], "test")).toMatchObject({ restored: 1 });
    expect(await r.kv.get(KV.imageEmbeddings, "/img/q.png")).toEqual(embeddingOf("/img/q.png"));
    expect(images.put).toHaveBeenCalledTimes(1);
    expect(await holdOf(r, "/img/q.png")).toEqual({ holders: [itemKey(obs("q2"))] });

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });
    expect(await r.kv.get(KV.imageRefs, "/img/q.png")).toBe(1);
    expect(await r.kv.get(KV.imageEmbeddings, "/img/q.png")).not.toBeNull();
    expect(files.has("/img/q.png")).toBe(true);
  });

  it("is dropped with the last reference at purge, never put back", async () => {
    const { r, images, clock, deps } = await world();
    await image(r, "/img/z.png", 1);
    const { row, seal } = await imaged(r, "z1", "/img/z.png");
    await closedRun(r, A, [await candidate(r, "O", row, seal)]);
    clock.now = at(25);
    await purge(deps);
    expect(images.put).not.toHaveBeenCalled();
    expect(await r.kv.get(KV.imageEmbeddings, "/img/z.png")).toBeNull();
    expect(await holdOf(r, "/img/z.png")).toBeNull();
  });
});

describe("imageReleased goes first", () => {
  it("is on the entry when the decrement runs, so a crash leaks a reference and never frees twice", async () => {
    const { r, clock, deps } = await world();
    await image(r, "/img/o.png", 1);
    const { row, seal } = await imaged(r, "o1", "/img/o.png");
    await closedRun(r, A, [await candidate(r, "O", row, seal)]);
    const seen: unknown[] = [];
    decrementImageRef.mockImplementation(async (kv: StateKV, sdk: unknown, path: string) => {
      seen.push(await r.vault.get(A, obs("o1")));
      await fakeDecrement(kv, sdk, path);
    });
    clock.now = at(25);
    await purge(deps);
    expect(seen).toEqual([expect.objectContaining({ purging: true, imageReleased: true })]);
  });

  it("is not decremented again by a pass that finds the marker, which still drops the hold and finishes the entry", async () => {
    const { r, clock, deps } = await world();
    await image(r, "/img/m.png", 2);
    const { row, seal } = await imaged(r, "m1", "/img/m.png");
    await closedRun(r, A, [await candidate(r, "O", row, seal)]);
    const entry = (await r.vault.get(A, obs("m1")))!;
    await r.vault.update({ ...entry, purging: true, imageReleased: true });
    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1 });
    expect(decrementImageRef).not.toHaveBeenCalled();
    expect(await holdOf(r, "/img/m.png")).toBeNull();
    expect(await vaultKeys(r, A)).toEqual([]);
  });
});

describe("an entry whose reference is already released", () => {
  it("cannot be restored, whoever released it, and purge finishes it at the end of grace without a second decrement", async () => {
    const { r, clock, deps } = await world();
    await image(r, "/img/g.png", 2);
    const { row, seal } = await imaged(r, "g1", "/img/g.png");
    await closedRun(r, A, [await candidate(r, "O", row, seal)]);
    const entry = (await r.vault.get(A, obs("g1")))!;
    await r.vault.update({ ...entry, imageReleased: true });

    expect(await restoreItems(deps, [obs("g1")], "after a crashed forget")).toMatchObject({ restored: 0, deferred: 1 });
    expect(await r.kv.get(KV.observations("ses_i"), "g1")).toBeNull();

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 1, restoredBack: 0 });
    expect(decrementImageRef).not.toHaveBeenCalled();
    expect(await holdOf(r, "/img/g.png")).toBeNull();
  });
});

describe("explicit forget drops the hold too", () => {
  async function displaced() {
    const w = await world();
    await image(w.r, "/img/f.png", 2);
    const { row, seal } = await imaged(w.r, "f1", "/img/f.png");
    const other = await seedObservation(w.r, observation("f2", "ses_i", { imageData: "/img/f.png" }), { seed: 2 });
    await closedRun(w.r, A, [await candidate(w.r, "O", row, seal), await candidate(w.r, "O", other, seal)]);
    return w;
  }
  const forgetRef = (r: Rig, id: string) =>
    afterForget(r.h.sdk as never, r.kv, { sessionId: "ses_i", observationIds: [id], observations: [], memories: [], notFound: [id] });

  it("releases the reference once and drops this row's hold, keeping the parked embedding for the other holder", async () => {
    const { r } = await displaced();
    expect(await forgetRef(r, "f1")).toMatchObject({ trashed: { observationIds: ["f1"] } });
    await forgetRef(r, "f1");
    expect(decrementImageRef).toHaveBeenCalledTimes(1);
    expect(await holdOf(r, "/img/f.png")).toEqual({ holders: [itemKey(obs("f2"))], embedding: embeddingOf("/img/f.png") });
    expect(await r.kv.get(KV.imageRefs, "/img/f.png")).toBe(1);
  });

  it("removes the hold record with the last holder", async () => {
    const { r } = await displaced();
    await forgetRef(r, "f1");
    await forgetRef(r, "f2");
    expect(decrementImageRef).toHaveBeenCalledTimes(2);
    expect(await holdOf(r, "/img/f.png")).toBeNull();
    expect(files.has("/img/f.png")).toBe(false);
  });
});

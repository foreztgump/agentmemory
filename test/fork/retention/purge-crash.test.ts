// Slice 7, R12 for purge: a crash between every two writes, then a re-run. Nothing is restorable-but-gone or gone-but-held,
// image references are released at most once (exactly once but for the one write after the marker), and a second purge changes nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

const files = vi.hoisted(() => new Set<string>());
const decrementImageRef = vi.hoisted(() => vi.fn());
vi.mock("../../../src/functions/image-refs.js", () => ({ decrementImageRef }));

import { loadActiveClock } from "../../../src/fork/retention/clock.js";
import { createProtector } from "../../../src/fork/retention/protect.js";
import { purgeExpired } from "../../../src/fork/retention/purge.js";
import { restoreItems } from "../../../src/fork/retention/restore.js";
import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { DemoteRecord, ItemRef, RunId, Stage, VaultEntry } from "../../../src/fork/retention/types.js";
import type { StateKV } from "../../../src/state/kv.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation, Memory } from "../../../src/types.js";
import { Crash, crashed, crashingAt } from "./crash.js";
import { candidate, memory, observation, rig, seedMemory, seedObservation, seedSeal } from "./move-fixtures.js";
import { at, clocked, closedRun, snapshot, writeCount } from "./purge-fixtures.js";

const A = "ret_a" as RunId;
const B = "ret_b" as RunId;
const obs = (sessionId: string, id: string): ItemRef => ({ kind: "observation", sessionId, id });
const PATHS = ["/img/q.png", "/img/s.png"] as const;

const started = new Map<string, number>();
const completed = new Map<string, number>();
const bump = (counter: Map<string, number>, path: string) => counter.set(path, (counter.get(path) ?? 0) + 1);

async function fakeDecrement(kv: StateKV, _sdk: unknown, path: string): Promise<void> {
  bump(started, path);
  const current = Number(await kv.get<number>(KV.imageRefs, path)) || 0;
  if (current <= 1) {
    await kv.delete(KV.imageEmbeddings, path);
    await kv.delete(KV.imageRefs, path);
    files.delete(path);
  } else {
    await kv.set(KV.imageRefs, path, current - 1);
  }
  bump(completed, path);
}

interface Held {
  readonly name: string;
  readonly ref: ItemRef;
  readonly runId: RunId;
  readonly stage: Stage;
  readonly path?: string;
}

const HELD: readonly Held[] = [
  { name: "c_sole", ref: obs("ses_c", "c_sole"), runId: A, stage: "O", path: PATHS[0] },
  { name: "c_shared", ref: obs("ses_c", "c_shared"), runId: A, stage: "O", path: PATHS[1] },
  { name: "c_plain", ref: obs("ses_c", "c_plain"), runId: A, stage: "O" },
  { name: "c_trim", ref: obs("ses_c", "c_trim"), runId: A, stage: "T" },
  { name: "tt1/T", ref: obs("ses_t", "tt1"), runId: A, stage: "T" },
  { name: "tt1/O", ref: obs("ses_t", "tt1"), runId: B, stage: "O" },
  { name: "m_x", ref: { kind: "memory", id: "m_x" }, runId: B, stage: "X" },
];

async function build() {
  files.clear();
  started.clear();
  completed.clear();
  const r = rig();
  const { clock, deps } = clocked(r);
  Object.assign(r.runtime, { images: { put: vi.fn(), remove: vi.fn(), search: vi.fn() } });
  for (const [path, refs] of [[PATHS[0], 1], [PATHS[1], 2]] as const) {
    files.add(path);
    await r.kv.set(KV.imageRefs, path, refs);
    await r.kv.set(KV.imageEmbeddings, path, { imageRef: path, vector: [1, 2, 3, 4], modelName: "clip", dimensions: 4, updatedAt: "2026-04-01T00:00:00.000Z" });
  }
  const rows = {
    sole: await seedObservation(r, observation("c_sole", "ses_c", { imageData: PATHS[0] }), { seed: 1 }),
    shared: await seedObservation(r, observation("c_shared", "ses_c", { imageData: PATHS[1] }), { seed: 2 }),
    plain: await seedObservation(r, observation("c_plain", "ses_c"), { seed: 4 }),
    trim: await seedObservation(r, observation("c_trim", "ses_c"), { seed: 5 }),
    tt: await seedObservation(r, observation("tt1", "ses_t"), { seed: 6 }),
  };
  await seedObservation(r, observation("lv1", "ses_live", { imageData: PATHS[1] }), { seed: 3 });
  await r.kv.set(KV.accessLog, "c_plain", { memoryId: "c_plain", count: 1, lastAt: "2025-01-01T00:00:00.000Z", recent: [] });
  await seedMemory(r, memory("m_x"), { seed: 7 });
  await r.kv.set(KV.accessLog, "m_x", { memoryId: "m_x", count: 1, lastAt: "2025-01-01T00:00:00.000Z", recent: [] });
  await r.kv.set(KV.retentionScores, "m_x", { memoryId: "m_x", score: 0.01 });
  await r.kv.set<DemoteRecord>(RETENTION_KV.demoted, "m_x", { memoryId: "m_x", runId: A, demotedAt: "2026-01-01T00:00:00.000Z", reason: { stage: "C", ageActiveDays: 400, note: "cold" } });
  const sealC = await seedSeal(r, "ses_c", 4);
  const sealT = await seedSeal(r, "ses_t", 1);
  await closedRun(r, A, [
    await candidate(r, "O", rows.sole, sealC), await candidate(r, "O", rows.shared, sealC), await candidate(r, "O", rows.plain, sealC),
    await candidate(r, "T", rows.trim, sealC), await candidate(r, "T", rows.tt, sealT),
  ]);
  const trimmed = (await r.kv.get<CompressedObservation>(KV.observations("ses_t"), "tt1"))!;
  await closedRun(r, B, [await candidate(r, "O", trimmed, sealT), await candidate(r, "X", (await r.kv.get<Memory>(KV.memories, "m_x"))!)]);
  clock.now = at(25);
  decrementImageRef.mockReset();
  decrementImageRef.mockImplementation(fakeDecrement);
  const protector = () => loadActiveClock(r.kv, deps.now).then((clockNow) => createProtector(r.kv, { supersededDays: 0, coldDays: 0 }, clockNow));
  return { r, deps, protector };
}

type World = Awaited<ReturnType<typeof build>>;

async function entryOf(w: World, held: Held): Promise<VaultEntry | null> {
  return w.r.vault.get(held.runId, held.ref);
}

/** Crashes at write `n`; false once `n` is past the pass's last write. */
async function crashAt(w: World, n: number): Promise<boolean> {
  const crashing = crashingAt(w.deps, n);
  return crashed(async () => purgeExpired(crashing.deps, await w.protector(), at(25), { pauseMs: 0 }));
}

const total = (counter: Map<string, number>) => [...counter.values()].reduce((a, b) => a + b, 0);

beforeEach(() => {
  decrementImageRef.mockReset();
});

describe("a crash between every two writes of a purge", () => {
  it("writes more than a handful of times, so the sweep below covers every step", async () => {
    const w = await build();
    const before = writeCount(w.r);
    await purgeExpired(w.deps, await w.protector(), at(25), { pauseMs: 0 });
    expect(writeCount(w.r) - before).toBeGreaterThan(40);
  });

  it("leaves an entry either fully restorable or fully committed, and never under-counts `held`", async () => {
    let crashes = 0;
    for (let n = 1; ; n++) {
      const w = await build();
      if (!(await crashAt(w, n))) break;
      crashes++;
      const runs = { [A]: (await w.r.runs.get(A))!, [B]: (await w.r.runs.get(B))! };
      const present: Record<string, number> = { [A]: 0, [B]: 0 };
      for (const held of HELD) {
        const entry = await entryOf(w, held);
        const at = `crash ${n}, ${held.name}`;
        if (entry) present[held.runId]!++;
        if (!entry) {
          if (held.stage !== "T") expect(await w.r.kv.get(RETENTION_KV.tombstones, itemKey(held.ref)) !== null || held.ref.kind === "memory", at).toBe(true);
          if (held.path) expect(completed.get(held.path) ?? 0, at).toBe(1);
          if (held.name === "c_plain") expect(await w.r.kv.get(KV.accessLog, "c_plain"), at).toBeNull();
          if (held.name === "m_x") {
            expect(await w.r.kv.get(RETENTION_KV.demoted, "m_x"), at).toBeNull();
            expect(await w.r.kv.get(KV.retentionScores, "m_x"), at).toBeNull();
          }
        } else if (!entry.purging) {
          expect(entry.imageReleased, at).toBeFalsy();
          if (held.path) expect(started.get(held.path) ?? 0, at).toBe(0);
          if (held.stage !== "T") expect(await w.r.kv.get(RETENTION_KV.tombstones, itemKey(held.ref)), at).toBeNull();
          if (held.name === "c_plain") expect(await w.r.kv.get(KV.accessLog, "c_plain"), at).not.toBeNull();
          if (held.name === "m_x") {
            expect(await w.r.kv.get(RETENTION_KV.demoted, "m_x"), at).not.toBeNull();
            expect(await w.r.kv.get(KV.retentionScores, "m_x"), at).not.toBeNull();
          }
        }
      }
      for (const id of [A, B]) expect(runs[id]!.held, `crash ${n}, held of ${id}`).toBeGreaterThanOrEqual(present[id]!);
    }
    expect(crashes).toBeGreaterThan(40);
  });

  it("restores exactly the entries purge had not committed, and brings back nothing that is gone", async () => {
    for (let n = 1; ; n++) {
      const w = await build();
      if (!(await crashAt(w, n))) break;
      const before = new Map<string, VaultEntry | null>();
      for (const held of HELD) before.set(held.name, await entryOf(w, held));
      await restoreItems(w.deps, [...new Map(HELD.map((h) => [itemKey(h.ref), h.ref])).values()], "after a crash");
      for (const held of HELD) {
        const entry = before.get(held.name);
        const at = `crash ${n}, ${held.name}`;
        const restorable = entry !== null && entry !== undefined && !entry.purging;
        if (held.stage === "T") continue;
        const live = await w.r.kv.get(held.ref.kind === "memory" ? KV.memories : KV.observations(held.ref.sessionId), held.ref.id);
        expect(live !== null, at).toBe(restorable);
        if (restorable) {
          const keyword = w.r.runtime.keyword.has(held.ref.id);
          expect(keyword, at).toBe(true);
          if (held.path) expect(await w.r.kv.get(KV.imageEmbeddings, held.path), at).not.toBeNull();
        } else {
          expect(w.r.runtime.keyword.has(held.ref.id) && held.name !== "tt1/O", at).toBe(false);
        }
      }
    }
  });

  it("settles on a re-run: everything purged, `held` 0, each reference released once, and a second purge changes nothing", async () => {
    let crashes = 0;
    for (let n = 1; ; n++) {
      const w = await build();
      if (!(await crashAt(w, n))) break;
      crashes++;
      const leaked = new Set<string>();
      for (const held of HELD) {
        const entry = held.path ? await entryOf(w, held) : null;
        if (held.path && entry?.imageReleased && (completed.get(held.path) ?? 0) === 0) leaked.add(held.path);
      }
      const at25 = at(25);
      await purgeExpired(w.deps, await w.protector(), at25, { pauseMs: 0 });
      const label = `crash ${n}`;

      for (const held of HELD) expect(await entryOf(w, held), `${label}, ${held.name}`).toBeNull();
      expect(await w.r.kv.listKeys(RETENTION_KV.items), label).toEqual([]);
      for (const id of [A, B]) expect(await w.r.runs.get(id), `${label}, ${id}`).toMatchObject({ held: 0, purgedAt: at25.toISOString() });
      for (const [session, id] of [["ses_c", "c_sole"], ["ses_c", "c_shared"], ["ses_c", "c_plain"], ["ses_t", "tt1"]] as const) {
        expect(await w.r.kv.get(KV.observations(session), id), `${label}, ${id}`).toBeNull();
        expect(await w.r.kv.get(RETENTION_KV.tombstones, itemKey(obs(session, id))), `${label}, tombstone ${id}`).toMatchObject({ sessionId: session });
        expect(w.r.runtime.keyword.has(id) || w.r.runtime.vector.has(id), `${label}, index ${id}`).toBe(false);
      }
      expect(await w.r.kv.listKeys(RETENTION_KV.tombstones), label).toHaveLength(4);
      expect(await w.r.kv.get(KV.memories, "m_x"), label).toBeNull();
      expect(await w.r.kv.get(RETENTION_KV.demoted, "m_x"), label).toBeNull();
      expect(await w.r.kv.get(KV.accessLog, "c_plain"), label).toBeNull();
      expect(await w.r.kv.get(KV.accessLog, "m_x"), label).toBeNull();
      expect(await w.r.kv.get(KV.retentionScores, "m_x"), label).toBeNull();
      const trimmedRow = await w.r.kv.get<CompressedObservation>(KV.observations("ses_c"), "c_trim");
      expect(trimmedRow!.source, label).toMatchObject({ truncated: true });
      expect(w.r.runtime.keyword.has("c_trim"), label).toBe(true);
      expect(await w.r.kv.get(KV.observations("ses_live"), "lv1"), label).not.toBeNull();

      for (const path of PATHS) {
        expect(started.get(path) ?? 0, `${label}, ${path} started`).toBeLessThanOrEqual(1);
        expect(completed.get(path) ?? 0, `${label}, ${path} completed`).toBeLessThanOrEqual(1);
      }
      expect(await w.r.kv.get(KV.imageRefs, PATHS[0]), `${label}, sole`).toBe(leaked.has(PATHS[0]) ? 1 : null);
      expect(files.has(PATHS[0]), `${label}, sole file`).toBe(leaked.has(PATHS[0]));
      expect(await w.r.kv.get(KV.imageRefs, PATHS[1]), `${label}, shared`).toBe(leaked.has(PATHS[1]) ? 2 : 1);
      expect(files.has(PATHS[1]), `${label}, shared file`).toBe(true);
      expect(await w.r.kv.get(KV.imageEmbeddings, PATHS[1]), `${label}, shared embedding`).not.toBeNull();
      for (const path of PATHS) expect(await w.r.kv.get(KV.retentionImageHolds, path), `${label}, hold ${path}`).toBeNull();

      const settled = snapshot(w.r);
      const writes = writeCount(w.r);
      const second = await purgeExpired(w.deps, await w.protector(), at25, { pauseMs: 0 });
      expect(second, label).toMatchObject({ purged: 0, restoredBack: 0, runsEmptied: 0 });
      expect(snapshot(w.r), label).toBe(settled);
      expect(writeCount(w.r), label).toBe(writes);
      expect(total(completed), label).toBeLessThanOrEqual(2);
    }
    expect(crashes).toBeGreaterThan(40);
  });

  it("completes the same whether or not it is ever interrupted", async () => {
    const clean = await build();
    await purgeExpired(clean.deps, await clean.protector(), at(25), { pauseMs: 0 });
    const crashedWorld = await build();
    expect(await crashAt(crashedWorld, 25)).toBe(true);
    await purgeExpired(crashedWorld.deps, await crashedWorld.protector(), at(25), { pauseMs: 0 });
    for (const scope of [KV.observations("ses_c"), KV.observations("ses_t"), KV.memories, KV.imageRefs, RETENTION_KV.tombstones]) {
      expect(await crashedWorld.r.kv.listKeys(scope)).toEqual(await clean.r.kv.listKeys(scope));
    }
    expect(Crash).toBeDefined();
  });
});

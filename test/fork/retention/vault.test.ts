import { describe, expect, it } from "vitest";
import { Vault } from "../../../src/fork/retention/vault.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { newRunRow, RunStore } from "../../../src/fork/retention/run-store.js";
import type { RowEntry, RunId, TrimEntry } from "../../../src/fork/retention/types.js";
import type { CompressedObservation } from "../../../src/types.js";
import { retentionHarness } from "./harness.js";

const RUN_A = "ret_a" as RunId;
const RUN_B = "ret_b" as RunId;

function observation(id: string, sessionId = "ses_1"): CompressedObservation {
  return {
    id, sessionId, timestamp: "2026-01-01T00:00:00.000Z", type: "file_read", title: `title ${id}`,
    facts: [], narrative: "n", concepts: [], files: [], importance: 5,
  };
}

function rowEntry(runId: RunId, id: string, sessionId = "ses_1"): RowEntry {
  return {
    stage: "O", ref: { kind: "observation", sessionId, id }, runId,
    reason: { stage: "O", ageActiveDays: 200, note: "aged" }, movedAt: "2026-06-01T00:00:00.000Z",
    rowFingerprint: `fp_${id}`, satellites: { vector: "AAAA" }, row: observation(id, sessionId),
  };
}

function trimEntry(runId: RunId, id: string): TrimEntry {
  return {
    stage: "T", ref: { kind: "observation", sessionId: "ses_1", id }, runId,
    reason: { stage: "T", ageActiveDays: 50, note: "aged" }, movedAt: "2026-06-01T00:00:00.000Z",
    rowFingerprint: `fp_${id}`, satellites: {}, source: { type: "tool", tool: "Read" } as never,
  };
}

async function collect(vault: Vault, runId: RunId, size: number) {
  const pages: string[][] = [];
  for await (const page of vault.pages(runId, size)) pages.push(page.map((e) => e.ref.id));
  return pages;
}

describe("Vault", () => {
  it("puts an entry in its run's scope and a locator, and reads both back by id", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    const entry = rowEntry(RUN_A, "obs_1");
    await vault.put(entry);

    expect(h.store.get(RETENTION_KV.vault(RUN_A))?.get("obs_1")).toEqual(entry);
    expect(await vault.locate("obs_1")).toEqual({ runId: RUN_A, stage: "O", sessionId: "ses_1" });
    expect(await vault.get(RUN_A, "obs_1")).toEqual(entry);
    expect(await vault.locate("obs_missing")).toBeNull();
    expect(await vault.get(RUN_A, "obs_missing")).toBeNull();
    expect(await vault.get(RUN_B, "obs_1")).toBeNull();
  });

  it("records no session on the locator of a memory", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    const entry: RowEntry = { ...rowEntry(RUN_A, "mem_1"), stage: "S", ref: { kind: "memory", id: "mem_1" } };
    await vault.put(entry);
    expect(await vault.locate("mem_1")).toEqual({ runId: RUN_A, stage: "S" });
  });

  it("is idempotent: a second put of the same entry leaves one entry and one locator", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    const entry = rowEntry(RUN_A, "obs_1");
    await vault.put(entry);
    await vault.put(entry);
    expect(h.store.get(RETENTION_KV.vault(RUN_A))?.size).toBe(1);
    expect(h.store.get(RETENTION_KV.items)?.size).toBe(1);
    expect(await vault.get(RUN_A, "obs_1")).toEqual(entry);
  });

  it("stores a trim entry with its source and locates it as stage T", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    const entry = trimEntry(RUN_A, "obs_t");
    await vault.put(entry);
    expect(await vault.locate("obs_t")).toMatchObject({ runId: RUN_A, stage: "T" });
    expect(await vault.get(RUN_A, "obs_t")).toEqual(entry);
  });

  it("pages one run in groups of the requested size and never reads another run's scope", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    for (let i = 0; i < 7; i++) await vault.put(rowEntry(RUN_A, `obs_${i}`));
    await vault.put(rowEntry(RUN_B, "obs_other"));

    const pages = await collect(vault, RUN_A, 3);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    expect(pages.flat().sort()).toEqual(Array.from({ length: 7 }, (_, i) => `obs_${i}`).sort());
    expect(await collect(vault, "ret_empty" as RunId, 3)).toEqual([]);
    expect(h.calls.filter((id) => id === "state::list")).toEqual([]);
  });

  it("holds one page, not the run, in memory: values are fetched page by page", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    for (let i = 0; i < 10; i++) await vault.put(rowEntry(RUN_A, `obs_${i}`));
    h.calls.length = 0;
    const gets: number[] = [];
    for await (const page of vault.pages(RUN_A, 4)) {
      gets.push(h.calls.filter((id) => id === "state::get").length);
      expect(page.length).toBeLessThanOrEqual(4);
    }
    expect(gets).toEqual([4, 8, 10]);
  });

  it("take removes the entry and its locator, and a repeat take is a no-op", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    await vault.put(rowEntry(RUN_A, "obs_1"));
    await vault.put(rowEntry(RUN_A, "obs_2"));
    await vault.take(RUN_A, "obs_1");
    await vault.take(RUN_A, "obs_1");

    expect(await vault.get(RUN_A, "obs_1")).toBeNull();
    expect(await vault.locate("obs_1")).toBeNull();
    expect(await vault.get(RUN_A, "obs_2")).not.toBeNull();
    expect(await vault.locate("obs_2")).not.toBeNull();
  });

  it("take leaves a locator that a later run now owns", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    await vault.put(rowEntry(RUN_A, "obs_1"));
    await vault.put(rowEntry(RUN_B, "obs_1"));
    await vault.take(RUN_A, "obs_1");
    expect(await vault.get(RUN_A, "obs_1")).toBeNull();
    expect(await vault.locate("obs_1")).toMatchObject({ runId: RUN_B });
    expect(await vault.get(RUN_B, "obs_1")).not.toBeNull();
  });

  it("lists only the runs that still hold restorable entries", async () => {
    const h = retentionHarness();
    const vault = new Vault(h.kv);
    const runs = new RunStore(h.kv, () => new Date("2026-06-01T00:00:00.000Z"));
    const settings = { windows: { trimDays: 1, observationDays: 1, supersededDays: 1, coldDays: 1 }, graceDays: 30 };
    await runs.create({ ...newRunRow({ id: RUN_A, dryRun: false, ranBy: "p1", startedAt: "2026-06-01T00:00:00.000Z", ...settings }), held: 2 });
    await runs.create({ ...newRunRow({ id: RUN_B, dryRun: false, ranBy: "p1", startedAt: "2026-06-01T00:00:00.000Z", ...settings }), held: 0 });
    expect((await vault.runsHolding()).map((r) => r.id)).toEqual([RUN_A]);
  });
});

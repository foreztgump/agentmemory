// R8, replay half, memory mode: nothing retention moved comes back by replaying the capture log or by a boot rebuild.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { captureEventScope } from "../../../src/capture/event-record.js";
import { registerCaptureFunctions } from "../../../src/functions/capture.js";
import { DedupMap } from "../../../src/functions/dedup.js";
import { registerObserveFunction } from "../../../src/functions/observe.js";
import { rebuildIndex, setEmbeddingProvider, setVectorIndex } from "../../../src/functions/search.js";
import { displace } from "../../../src/fork/retention/move.js";
import { restoreRun } from "../../../src/fork/retention/restore.js";
import { createSearchRuntime, getSearchRuntime } from "../../../src/state/search-ports.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation, EmbeddingProvider, Session } from "../../../src/types.js";
import { DIMS, RUN, candidate, openRun, rig, seedSeal } from "./move-fixtures.js";

const SESSION = "ses_r8";
const embed = vi.fn(async () => new Float32Array(DIMS).fill(0.5));
const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.5)));
const provider = { name: "spy", dimensions: DIMS, embed, embedBatch } as unknown as EmbeddingProvider;

const payload = (n: number) => ({
  hookType: "post_tool_use", sessionId: SESSION, project: "proj", cwd: "/w", timestamp: `2026-04-0${n}T09:00:00.000Z`,
  data: { tool_name: "Bash", tool_input: { command: `echo ${n}` }, tool_output: `output number ${n} zebra` },
});
const eventId = (n: number) => `evc_00000000020${n}`;

async function boot() {
  const runtime = createSearchRuntime({ kv: {} as never, embeddingProvider: provider }, "memory");
  runtime.keyword.clear();
  setEmbeddingProvider(provider);
  setVectorIndex(runtime.vector);
  const r = rig(getSearchRuntime);
  await r.kv.set(KV.sessions, SESSION, { id: SESSION, project: "proj", cwd: "/w", startedAt: "2026-04-01T08:00:00.000Z", status: "completed", observationCount: 0 } satisfies Session);
  registerObserveFunction(r.h.sdk as never, r.kv, new DedupMap());
  registerCaptureFunctions(r.h.sdk as never, r.kv);
  const capture = (n: number) => r.h.call("mem::capture", { payload: payload(n), eventId: eventId(n) }) as Promise<Record<string, unknown>>;
  return { r, runtime, capture };
}

const rowsOf = async (r: Awaited<ReturnType<typeof boot>>["r"]) => r.kv.list<CompressedObservation>(KV.observations(SESSION));

beforeEach(() => {
  embed.mockClear();
  embedBatch.mockClear();
});

describe("R8 replay", () => {
  it("replaying the capture log after a move brings back no displaced observation, and a boot rebuild indexes none", async () => {
    const { r, runtime, capture } = await boot();
    for (const n of [1, 2, 3]) expect(await capture(n)).toMatchObject({ status: "accepted", state: "completed" });
    const rows = await rowsOf(r);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => typeof row.captureKey === "string")).toBe(true);
    expect(rows.map((row) => runtime.keyword.has(row.id))).toEqual([true, true, true]);
    await openRun(r);
    const seal = await seedSeal(r, SESSION, 3);
    const [kept, ...moved] = rows;
    for (const row of moved) expect((await displace(r.deps, r.vault, RUN, await candidate(r, "O", row, seal))).moved).toBe(true);

    for (const n of [1, 2, 3]) expect(await capture(n)).toMatchObject({ status: "duplicate", deduplicated: true });
    expect((await rowsOf(r)).map((row) => row.id)).toEqual([kept!.id]);
    expect(moved.map((row) => runtime.keyword.has(row.id))).toEqual([false, false]);

    await rebuildIndex(r.kv);
    expect(runtime.keyword.has(kept!.id)).toBe(true);
    expect(moved.map((row) => runtime.keyword.has(row.id))).toEqual([false, false]);
    expect((await rowsOf(r)).map((row) => row.id)).toEqual([kept!.id]);
    expect((await r.kv.get<Session>(KV.sessions, SESSION))!.observationCount).toBe(1);
  });

  it("without the capture tombstone the same replay does bring a row back, so the tombstone is what holds it", async () => {
    const { r, capture } = await boot();
    await capture(1);
    const [row] = await rowsOf(r);
    await openRun(r);
    const seal = await seedSeal(r, SESSION, 1);
    await displace(r.deps, r.vault, RUN, await candidate(r, "O", row!, seal));
    const entry = (await r.vault.get(RUN, { kind: "observation", sessionId: SESSION, id: row!.id }))!;
    const event = entry.satellites.captureEvent as { key: string };
    await r.kv.set(captureEventScope(event.key), event.key, event);

    expect(await capture(1)).toMatchObject({ status: "accepted" });
    expect((await rowsOf(r)).map((x) => x.id)).toEqual([row!.id]);
  });

  it("after a restore, a replay finds the live row and neither duplicates nor embeds it", async () => {
    const { r, runtime, capture } = await boot();
    await capture(1);
    const [row] = await rowsOf(r);
    runtime.vector.add(row!.id, SESSION, new Float32Array(DIMS).fill(0.25));
    embed.mockClear();
    embedBatch.mockClear();
    await openRun(r);
    const seal = await seedSeal(r, SESSION, 1);
    await displace(r.deps, r.vault, RUN, await candidate(r, "O", row!, seal));
    await restoreRun(r.deps, RUN, "test");

    expect(await capture(1)).toMatchObject({ status: "duplicate", deduplicated: true });
    expect((await rowsOf(r)).map((x) => x.id)).toEqual([row!.id]);
    expect(runtime.keyword.has(row!.id)).toBe(true);
    expect(runtime.vector.has(row!.id)).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });
});

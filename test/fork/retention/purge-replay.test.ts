// Slice 7, R8 after purge: the tombstone and the capture marker keep a replay of a purged observation a duplicate.
import { describe, expect, it, vi } from "vitest";

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
import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { ObservationTombstone, RunId } from "../../../src/fork/retention/types.js";
import { createSearchRuntime, getSearchRuntime } from "../../../src/state/search-ports.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation, EmbeddingProvider, Session } from "../../../src/types.js";
import { DIMS, candidate, rig, seedSeal } from "./move-fixtures.js";
import { at, clocked, closedRun, done, purge } from "./purge-fixtures.js";

const SESSION = "ses_r8p";
const A = "ret_a" as RunId;
const provider = {
  name: "spy", dimensions: DIMS,
  embed: vi.fn(async () => new Float32Array(DIMS).fill(0.5)),
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(DIMS).fill(0.5))),
} as unknown as EmbeddingProvider;

const payload = (n: number) => ({
  hookType: "post_tool_use", sessionId: SESSION, project: "proj", cwd: "/w", timestamp: `2026-04-0${n}T09:00:00.000Z`,
  data: { tool_name: "Bash", tool_input: { command: `echo ${n}` }, tool_output: `output number ${n} zebra` },
});
const eventId = (n: number) => `evc_00000000030${n}`;

describe("R8 after purge", () => {
  it("replaying the capture log brings back no purged observation, and the tombstone names the run and the session", async () => {
    const runtime = createSearchRuntime({ kv: {} as never, embeddingProvider: provider }, "memory");
    runtime.keyword.clear();
    setEmbeddingProvider(provider);
    setVectorIndex(runtime.vector);
    const r = rig(getSearchRuntime);
    const { clock, deps } = clocked(r);
    await r.kv.set(KV.sessions, SESSION, { id: SESSION, project: "proj", cwd: "/w", startedAt: "2026-04-01T08:00:00.000Z", status: "completed", observationCount: 0 } satisfies Session);
    registerObserveFunction(r.h.sdk as never, r.kv, new DedupMap());
    registerCaptureFunctions(r.h.sdk as never, r.kv);
    const capture = (n: number) => r.h.call("mem::capture", { payload: payload(n), eventId: eventId(n) }) as Promise<Record<string, unknown>>;
    for (const n of [1, 2, 3]) expect(await capture(n)).toMatchObject({ status: "accepted" });
    const rows = await r.kv.list<CompressedObservation>(KV.observations(SESSION));
    const [kept, ...moved] = rows;
    const seal = await seedSeal(r, SESSION, 3);
    await closedRun(r, A, await Promise.all(moved.map((row) => candidate(r, "O", row, seal))));

    clock.now = at(25);
    expect(done(await purge(deps))).toMatchObject({ purged: 2, runsEmptied: 1 });

    for (const row of moved) {
      const key = itemKey({ kind: "observation", sessionId: SESSION, id: row.id });
      expect(await r.kv.get<ObservationTombstone>(RETENTION_KV.tombstones, key)).toMatchObject({ sessionId: SESSION, runId: A, summarySessionId: SESSION });
      const captureKey = (row as { captureKey: string }).captureKey;
      expect(await r.kv.get(captureEventScope(captureKey), captureKey)).toMatchObject({ state: "deleted" });
    }
    for (const n of [1, 2, 3]) expect(await capture(n)).toMatchObject({ status: "duplicate", deduplicated: true });
    expect((await r.kv.list<CompressedObservation>(KV.observations(SESSION))).map((row) => row.id)).toEqual([kept!.id]);

    await rebuildIndex(r.kv);
    expect(moved.map((row) => runtime.keyword.has(row.id))).toEqual([false, false]);
    expect(runtime.keyword.has(kept!.id)).toBe(true);
    expect((await r.kv.get<Session>(KV.sessions, SESSION))!.observationCount).toBe(1);
  });
});

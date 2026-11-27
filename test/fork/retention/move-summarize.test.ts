// Slice 3 note: stage O deletes rows and sets `trimmed` under the lock summarize publishes under.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { registerSummarizeFunction } from "../../../src/functions/summarize.js";
import { displace } from "../../../src/fork/retention/move.js";
import { registerRetention } from "../../../src/fork/retention/register.js";
import { sealSession } from "../../../src/fork/retention/seal.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import type { SessionSeal } from "../../../src/fork/retention/types.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation, MemoryProvider, SessionSummary } from "../../../src/types.js";
import { NOW, RUN, candidate, observation, rig, seedObservation } from "./move-fixtures.js";

const SESSION = "ses_1";

const xml = (title: string) => `<summary><title>${title}</title><narrative>a narrative that is long enough to validate</narrative>`
  + `<decisions><decision>d</decision></decisions><files><file>a.ts</file></files><concepts><concept>c</concept></concepts></summary>`;

/** A provider whose summarize can be held mid-generation. */
function gatedProvider() {
  const state = { calls: 0, release: () => {}, gate: null as Promise<void> | null, started: () => {} };
  const provider: MemoryProvider = {
    name: "test",
    compress: async () => "",
    summarize: async () => {
      const call = ++state.calls;
      if (call > 1 && state.gate) {
        state.started();
        await state.gate;
      }
      return xml(`Summary ${call}`);
    },
  };
  const hold = () => {
    const started = new Promise<void>((resolve) => { state.started = resolve; });
    state.gate = new Promise<void>((resolve) => { state.release = resolve; });
    return started;
  };
  return { provider, state, hold };
}

async function setup() {
  const r = rig();
  const g = gatedProvider();
  const rows: CompressedObservation[] = [];
  for (const n of [1, 2, 3]) rows.push(await seedObservation(r, observation(`obs_${n}`, SESSION, { timestamp: `2026-04-01T09:0${n}:00.000Z` })));
  registerSummarizeFunction(r.h.sdk as never, r.kv, g.provider);
  registerRetention(r.h.sdk as never, r.kv);
  const summarize = () => r.h.call("mem::summarize", { sessionId: SESSION }) as Promise<{ success: boolean; unchanged?: boolean; error?: string; summary?: SessionSummary }>;
  expect((await summarize()).success).toBe(true);
  const sealed = await sealSession(r.kv, SESSION, { now: NOW, llmCompression: false });
  expect(sealed.kind).toBe("sealed");
  const seal = (await r.kv.get<SessionSeal>(RETENTION_KV.seals, SESSION))!;
  const stored = async () => JSON.stringify(await r.kv.get(KV.summaries, SESSION));
  return { r, g, rows, seal, summarize, stored };
}

beforeEach(() => resetSummarizeVeto());
afterEach(() => resetSummarizeVeto());

describe("stage O against a summarize that is generating", () => {
  it("the stored summary stays byte-identical when a stage O move lands while a rebuild is mid-generation", async () => {
    const { r, g, rows, seal, summarize, stored } = await setup();
    const before = await stored();
    await seedObservation(r, observation("obs_4", SESSION, { timestamp: "2026-04-01T09:04:00.000Z" }));
    const generating = g.hold();

    const rebuild = summarize();
    await generating;
    for (const row of rows) expect((await displace(r.deps, r.vault, RUN, await candidate(r, "O", row, seal))).moved).toBe(true);
    expect((await r.kv.get<SessionSeal>(RETENTION_KV.seals, SESSION))?.trimmed).toBe(true);
    g.state.release();

    expect(await rebuild).toMatchObject({ success: false, error: "source_changed" });
    expect(await stored()).toBe(before);
    const calls = g.state.calls;
    expect(await summarize()).toMatchObject({ success: true, unchanged: true });
    expect(await stored()).toBe(before);
    expect(g.state.calls).toBe(calls);
  });

  it("takes the obs lock for the row delete and the trimmed flag: a move waits for a summarize that is publishing", async () => {
    const { r, g, rows, seal, summarize, stored } = await setup();
    await seedObservation(r, observation("obs_4", SESSION, { timestamp: "2026-04-01T09:04:00.000Z" }));
    const before = await stored();

    let publishing!: () => void;
    const atPublish = new Promise<void>((resolve) => { publishing = resolve; });
    let letPublishGo!: () => void;
    const publishGate = new Promise<void>((resolve) => { letPublishGo = resolve; });
    const trigger = r.h.sdk.trigger.bind(r.h.sdk);
    let held = false;
    r.h.sdk.trigger = (async (req: { function_id: string; payload: { scope?: string } }) => {
      if (req.function_id === "state::set" && req.payload.scope === KV.summaries && !held) {
        held = true;
        publishing();
        await publishGate;
      }
      return trigger(req as never);
    }) as typeof r.h.sdk.trigger;

    const rebuild = summarize();
    await atPublish;
    const move = displace(r.deps, r.vault, RUN, await candidate(r, "O", rows[0]!, seal));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await r.kv.get(KV.observations(SESSION), "obs_1")).not.toBeNull();
    expect((await r.kv.get<SessionSeal>(RETENTION_KV.seals, SESSION))?.trimmed).toBe(false);
    expect(await r.vault.get(RUN, { kind: "observation", sessionId: SESSION, id: "obs_1" })).toBeNull();

    letPublishGo();
    expect((await rebuild).success).toBe(true);
    expect((await move).moved).toBe(true);
    expect(await stored()).not.toBe(before);
    const published = await stored();
    const calls = g.state.calls;
    expect(await summarize()).toMatchObject({ success: true, unchanged: true });
    expect(await stored()).toBe(published);
    expect(g.state.calls).toBe(calls);
  });
});

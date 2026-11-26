import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { registerSummarizeFunction } from "../../../src/functions/summarize.js";
import { registerRetention } from "../../../src/fork/retention/register.js";
import { sealSession } from "../../../src/fork/retention/seal.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { Vault } from "../../../src/fork/retention/vault.js";
import {
  resetSummarizeVeto, setSummarizeVeto, summaryRebuildVetoed, trimmedSealVeto,
} from "../../../src/fork/retention/veto.js";
import type { RunId, SessionSeal, TrimEntry } from "../../../src/fork/retention/types.js";
import { KV } from "../../../src/state/schema.js";
import type { CompressedObservation, MemoryProvider, Session, SessionSummary } from "../../../src/types.js";
import { retentionHarness } from "./harness.js";

const RUN = "ret_r7" as RunId;
const SESSION_ID = "ses_r7";
const NOW = new Date("2026-09-01T00:00:00.000Z");

function summaryXml(title: string): string {
  return `<summary><title>${title}</title><narrative>a narrative that is long enough to validate</narrative>`
    + `<decisions><decision>d</decision></decisions><files><file>a.ts</file></files><concepts><concept>c</concept></concepts></summary>`;
}

function provider(titles: string[]): MemoryProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    name: "test",
    get calls() { return state.calls; },
    compress: async () => "",
    summarize: async () => summaryXml(titles[Math.min(state.calls++, titles.length - 1)]!),
  };
}

function observation(id: string): CompressedObservation {
  return {
    id, sessionId: SESSION_ID, timestamp: `2026-05-01T09:0${id.at(-1)}:00.000Z`, type: "file_read", title: `title ${id}`,
    facts: ["f"], narrative: `narrative ${id}`, concepts: [], files: ["a.ts"], importance: 5,
    source: { hookType: "post_tool_use", originalBytes: 4000, truncated: false, toolOutput: "x".repeat(400) },
  };
}

async function setup(titles: string[]) {
  const h = retentionHarness();
  const llm = provider(titles);
  const session: Session = {
    id: SESSION_ID, project: "proj", cwd: "/w", startedAt: "2026-05-01T08:00:00.000Z", status: "completed", observationCount: 3,
  };
  await h.kv.set(KV.sessions, SESSION_ID, session);
  const rows = ["obs_1", "obs_2", "obs_3"].map(observation);
  for (const r of rows) await h.kv.set(KV.observations(SESSION_ID), r.id, r);
  registerSummarizeFunction(h.sdk as never, h.kv, llm);
  registerRetention(h.sdk as never, h.kv);
  return { h, llm, rows };
}

async function summarize(h: Awaited<ReturnType<typeof setup>>["h"]) {
  return (await h.call("mem::summarize", { sessionId: SESSION_ID })) as { success: boolean; unchanged?: boolean; summary?: SessionSummary; error?: string };
}

async function storedSummary(h: Awaited<ReturnType<typeof setup>>["h"]): Promise<string> {
  return JSON.stringify(await h.kv.get(KV.summaries, SESSION_ID));
}

async function trimAndSoftDelete(h: Awaited<ReturnType<typeof setup>>["h"], rows: CompressedObservation[], markTrimmed: boolean) {
  const vault = new Vault(h.kv);
  const seal = (await h.kv.get<SessionSeal>(RETENTION_KV.seals, SESSION_ID))!;
  if (markTrimmed) await h.kv.set(RETENTION_KV.seals, SESSION_ID, { ...seal, trimmed: true });
  for (const r of rows) {
    const trim: TrimEntry = {
      stage: "T", ref: { kind: "observation", sessionId: SESSION_ID, id: r.id }, runId: RUN,
      reason: { stage: "T", ageActiveDays: 50, note: "aged" }, movedAt: NOW.toISOString(), project: "proj",
      rowFingerprint: `fp_${r.id}`, satellites: {}, source: r.source!,
    };
    await vault.put(trim);
    await h.kv.set(KV.observations(SESSION_ID), r.id, { ...r, source: { hookType: "post_tool_use", originalBytes: 4000, truncated: true } });
  }
  for (const r of rows) {
    await vault.put({
      stage: "O", ref: { kind: "observation", sessionId: SESSION_ID, id: r.id }, runId: RUN,
      reason: { stage: "O", ageActiveDays: 200, note: "aged" }, movedAt: NOW.toISOString(), project: "proj",
      rowFingerprint: `fp_${r.id}`, satellites: {}, row: r,
    });
    await h.kv.delete(KV.observations(SESSION_ID), r.id);
  }
}

beforeEach(() => resetSummarizeVeto());
afterEach(() => resetSummarizeVeto());

describe("mem::summarize veto (R7)", () => {
  it("returns the stored summary byte-identical after the rows were trimmed and soft-deleted", async () => {
    const { h, llm, rows } = await setup(["First summary", "Rewritten from nothing"]);
    expect((await summarize(h)).success).toBe(true);
    expect(await sealSession(h.kv, SESSION_ID, { now: NOW, llmCompression: false })).toMatchObject({ kind: "sealed" });
    const before = await storedSummary(h);
    expect(llm.calls).toBe(1);

    await trimAndSoftDelete(h, rows, true);
    expect(await h.kv.list(KV.observations(SESSION_ID))).toEqual([]);
    const again = await summarize(h);

    expect(again).toMatchObject({ success: true, unchanged: true });
    expect(JSON.stringify(again.summary)).toBe(before);
    expect(await storedSummary(h)).toBe(before);
    expect(llm.calls).toBe(1);
  });

  it("the veto is what holds it: with the seal not trimmed, the same deletion lets the summary be rebuilt", async () => {
    const { h, llm, rows } = await setup(["First summary", "Rebuilt from the remaining row"]);
    await summarize(h);
    await sealSession(h.kv, SESSION_ID, { now: NOW, llmCompression: false });
    const before = await storedSummary(h);

    await trimAndSoftDelete(h, rows.slice(0, 2), false);
    const again = await summarize(h);

    expect(again.success).toBe(true);
    expect(llm.calls).toBe(2);
    expect(await storedSummary(h)).not.toBe(before);
  });

  it("a trimmed session whose summary was removed falls through to the normal path", async () => {
    const { h, rows } = await setup(["First summary"]);
    await summarize(h);
    await sealSession(h.kv, SESSION_ID, { now: NOW, llmCompression: false });
    await trimAndSoftDelete(h, rows, true);
    await h.kv.delete(KV.summaries, SESSION_ID);

    expect(await summarize(h)).toMatchObject({ success: false, error: "no_observations" });
  });

  it("with no seal at all nothing is vetoed, and the first summarize is untouched", async () => {
    const { h, llm } = await setup(["First summary"]);
    expect(await summaryRebuildVetoed(SESSION_ID)).toBe(false);
    expect((await summarize(h)).unchanged).toBeUndefined();
    expect(llm.calls).toBe(1);
  });
});

describe("trimmedSealVeto", () => {
  it("is a point read of the seal: true only for a trimmed one", async () => {
    const h = retentionHarness();
    const seal = (trimmed: boolean): SessionSeal => ({
      sessionId: "s", sealedAt: NOW.toISOString(), summaryFingerprint: "f", observationCount: 1, graphExtracted: false, trimmed,
    });
    await h.kv.set(RETENTION_KV.seals, "yes", seal(true));
    await h.kv.set(RETENTION_KV.seals, "no", seal(false));
    const veto = trimmedSealVeto(h.kv);
    h.stateOps.length = 0;

    expect(await veto("yes")).toBe(true);
    expect(await veto("no")).toBe(false);
    expect(await veto("missing")).toBe(false);
    expect(h.stateOps).toEqual([`state::get ${RETENTION_KV.seals}`, `state::get ${RETENTION_KV.seals}`, `state::get ${RETENTION_KV.seals}`]);
  });
});

describe("the veto singleton", () => {
  it("refuses a second registration instead of replacing the first, and a reset allows one again", async () => {
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => false);
    setSummarizeVeto(first);

    expect(() => setSummarizeVeto(second)).toThrow(/already registered/);
    expect(await summaryRebuildVetoed("s")).toBe(true);
    expect(second).not.toHaveBeenCalled();

    resetSummarizeVeto();
    expect(await summaryRebuildVetoed("s")).toBe(false);
    setSummarizeVeto(second);
    expect(await summaryRebuildVetoed("s")).toBe(false);
    expect(second).toHaveBeenCalledWith("s");
  });

  it("registerRetention registers the veto once and a second call is refused", () => {
    registerRetention(retentionHarness().sdk as never, retentionHarness().kv);
    expect(() => registerRetention(retentionHarness().sdk as never, retentionHarness().kv)).toThrow(/already registered/);
  });
});

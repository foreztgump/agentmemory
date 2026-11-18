import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { GuardedStateKV, ScopeReadInventory } from "../src/fork/scope-guard.js";
import {
  observationStatsOf,
  registerObservationStatsRepair,
  withObservationStats,
} from "../src/fork/kv/observation-stats.js";
import {
  budgetLiveObservationSource,
  observationSourceTotals,
  SESSION_SOURCE_MAX_BYTES,
} from "../src/functions/observation-source-budget.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import { normalizeObservationSource, OBSERVATION_SOURCE_MAX_BYTES, withoutObservationSource } from "../src/functions/observation-source.js";
import { payloadByteLength, SAFE_PAYLOAD_BYTES } from "../src/state/frame-guard.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { registerAutoForgetFunction } from "../src/functions/auto-forget.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { getSearchIndex, setEmbeddingProvider, setVectorIndex } from "../src/functions/search.js";
import type { CompressedObservation, ExportData, RawObservation } from "../src/types.js";

type Req = { function_id: string; payload: Record<string, unknown> };

function harness(opts: { guard?: boolean } = {}) {
  const store = new Map<string, Map<string, unknown>>();
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const sdk = {
    registerFunction: (id: string | { id: string }, fn: (payload: unknown) => Promise<unknown>) =>
      functions.set(typeof id === "string" ? id : id.id, fn),
    registerTrigger: () => {},
    trigger: async (req: Req) => {
      const p = req.payload as { scope: string; key: string; value?: unknown };
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return p.value;
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list": return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
        case "state::list_groups": return { groups: [...store.keys()].filter((k) => store.get(k)!.size > 0) };
      }
      const fn = functions.get(req.function_id);
      return fn ? fn(req.payload) : null;
    },
  };
  const inventory = new ScopeReadInventory();
  const base = opts.guard
    ? new GuardedStateKV(sdk as never, { backend: "redis" }, inventory)
    : new StateKV(sdk as never, { backend: "redis" });
  const kv = withObservationStats(base);
  const call = (id: string, payload: unknown) => sdk.trigger({ function_id: id, payload: payload as Record<string, unknown> });
  const rows = (sessionId: string) => store.get(KV.observations(sessionId))?.size ?? 0;
  return { store, sdk, kv, call, rows, inventory };
}

function capture(h: ReturnType<typeof harness>, sessionId: string, i: number) {
  return h.call("mem::observe", {
    sessionId,
    project: "proj",
    cwd: "/tmp/proj",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: { tool_name: "Read", tool_input: { file: `${sessionId}-${i}.ts` }, tool_output: "x".repeat(200 + i) },
  }) as Promise<{ observationId?: string; success?: boolean; error?: string }>;
}

async function expectConsistent(h: ReturnType<typeof harness>, sessionIds: string[]) {
  const stats = observationStatsOf(h.kv)!;
  for (const sessionId of sessionIds) {
    const stored = [...(h.store.get(KV.observations(sessionId))?.values() ?? [])] as CompressedObservation[];
    const totals = await stats.totals(sessionId);
    expect({ sessionId, rows: totals.rows }).toEqual({ sessionId, rows: stored.length });
    expect(totals.sourceBytes).toBe(observationSourceTotals(stored).sourceBytes);
    expect(totals.summaryBytes).toBe(observationSourceTotals(stored).summaryBytes);
    const session = h.store.get(KV.sessions)?.get(sessionId) as { observationCount?: number } | undefined;
    if (session) expect({ sessionId, sessionCount: session.observationCount }).toEqual({ sessionId, sessionCount: stored.length });
  }
}

beforeEach(() => {
  vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
  getSearchIndex().clear();
  setVectorIndex(null);
  setEmbeddingProvider(null);
});

describe("session observation stats", () => {
  it("stay equal to the stored rows through capture, forget, evict, auto-forget and import", async () => {
    const h = harness();
    registerObserveFunction(h.sdk as never, h.kv, undefined, 500);
    registerRememberFunction(h.sdk as never, h.kv);
    registerEvictFunction(h.sdk as never, h.kv);
    registerAutoForgetFunction(h.sdk as never, h.kv);
    registerExportImportFunction(h.sdk as never, h.kv);

    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await capture(h, "ses_a", i)).observationId!);
    for (let i = 0; i < 5; i++) await capture(h, "ses_b", i);
    await expectConsistent(h, ["ses_a", "ses_b"]);

    await h.call("mem::forget", { sessionId: "ses_a", observationIds: ids.slice(0, 3) });
    expect(h.rows("ses_a")).toBe(9);
    await expectConsistent(h, ["ses_a", "ses_b"]);

    await h.kv.set(KV.config, "eviction", { maxObservationsPerProject: 10, staleSessionDays: 36500 });
    await h.call("mem::evict", {});
    expect(h.rows("ses_a") + h.rows("ses_b")).toBe(10);
    await expectConsistent(h, ["ses_a", "ses_b"]);

    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await h.kv.set(KV.observations("ses_b"), "obs_old_low", {
      ...buildSyntheticCompression({ id: "obs_old_low", sessionId: "ses_b", timestamp: old, hookType: "post_tool_use", raw: {} } as RawObservation),
      importance: 1,
    });
    const before = h.rows("ses_b");
    await h.call("mem::auto-forget", {});
    expect(h.rows("ses_b")).toBe(before - 1);
    await expectConsistent(h, ["ses_a", "ses_b"]);

    const imported = (n: number, sessionId: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `obs_${sessionId}_imp_${i}`, sessionId, timestamp: new Date().toISOString(), type: "file_edit",
        title: `imported ${i}`, facts: [], narrative: "n", concepts: [], files: [], importance: 5,
      }));
    const exportData: ExportData = {
      version: "0.9.33",
      exportedAt: new Date().toISOString(),
      sessions: [
        { id: "ses_c", project: "proj2", cwd: "/tmp", startedAt: new Date().toISOString(), status: "completed", observationCount: 99 },
      ],
      observations: { ses_c: imported(4, "ses_c"), ses_a: imported(2, "ses_a") },
      memories: [],
      summaries: [],
    } as ExportData;
    const result = (await h.call("mem::import", { exportData, strategy: "merge" })) as { success: boolean };
    expect(result.success).toBe(true);
    expect(h.rows("ses_c")).toBe(4);
    await expectConsistent(h, ["ses_a", "ses_b", "ses_c"]);
  });

  it("refuses at the cap from the counter, and repair recounts drifted stats", async () => {
    const h = harness();
    registerObserveFunction(h.sdk as never, h.kv, undefined, 3);
    registerObservationStatsRepair(h.sdk as never, h.kv);
    for (let i = 0; i < 3; i++) expect((await capture(h, "ses_cap", i)).observationId).toBeTruthy();
    expect(await capture(h, "ses_cap", 3)).toEqual({ success: false, error: "Session observation limit reached (3)" });

    h.store.get(KV.obsStats)!.set("ses_cap", { rows: 1, sourceBytes: 0, summaryBytes: 0, updatedAt: "x" });
    h.store.get(KV.sessions)!.set("ses_cap", { ...(h.store.get(KV.sessions)!.get("ses_cap") as object), observationCount: 40 });
    expect(await h.call("mem::obs-stats-repair", {})).toEqual({ success: true, sessions: 1, observations: 3 });
    await expectConsistent(h, ["ses_cap"]);
    expect(await capture(h, "ses_cap", 4)).toMatchObject({ success: false });
  });

  it("recounts a session whose stats row went missing after the ready marker, and repair fixes a drifted session count", async () => {
    const h = harness();
    registerObserveFunction(h.sdk as never, h.kv, undefined, 3);
    registerObservationStatsRepair(h.sdk as never, h.kv);
    await h.call("mem::obs-stats-repair", {});
    for (let i = 0; i < 3; i++) await capture(h, "ses_lost", i);
    h.store.get(KV.obsStats)!.delete("ses_lost");
    expect(await capture(h, "ses_lost", 3)).toMatchObject({ success: false });
    await expectConsistent(h, ["ses_lost"]);
    h.store.get(KV.sessions)!.set("ses_lost", { ...(h.store.get(KV.sessions)!.get("ses_lost") as object), observationCount: 9 });
    await h.call("mem::obs-stats-repair", { sessionId: "ses_lost" });
    await expectConsistent(h, ["ses_lost"]);
  });

  it("serializes concurrent captures into one session so the counter stays exact", async () => {
    const h = harness();
    registerObserveFunction(h.sdk as never, h.kv, undefined, 0);
    registerRememberFunction(h.sdk as never, h.kv);
    const ids = await Promise.all(Array.from({ length: 40 }, (_, i) => capture(h, "ses_race", i)));
    await Promise.all(ids.slice(0, 15).map((r) => h.call("mem::forget", { sessionId: "ses_race", observationIds: [r.observationId] })));
    expect(h.rows("ses_race")).toBe(25);
    await expectConsistent(h, ["ses_race"]);
  });

  it("does no whole-collection read of the session when capturing at and below the cap", async () => {
    const h = harness({ guard: true });
    registerObserveFunction(h.sdk as never, h.kv, undefined, 5);
    registerObservationStatsRepair(h.sdk as never, h.kv);
    await h.call("mem::obs-stats-repair", {});
    const seen = h.inventory.snapshot().reads.length;
    for (let i = 0; i < 6; i++) await capture(h, "ses_guard", i);
    expect(h.rows("ses_guard")).toBe(5);
    const reads = h.inventory.snapshot().reads.slice(seen).filter((r) => r.collection.startsWith("mem:obs"));
    expect(reads).toEqual([]);
  });
});

function upstreamBudget(observation: CompressedObservation, existing: CompressedObservation[]): CompressedObservation {
  const row = { ...observation, source: normalizeObservationSource(observation.source) };
  const kept = existing.filter((r) => r.id !== row.id);
  const envelope = { message_type: "invocation_result", invocation_id: "00000000-0000-0000-0000-000000000000", result: [...kept, withoutObservationSource(row)] };
  if (payloadByteLength(envelope) > SAFE_PAYLOAD_BYTES) return withoutObservationSource(observation);
  const existingSourceBytes = kept.reduce((sum, r) => sum + (r.source ? payloadByteLength(r.source) + 10 : 0), 0);
  const available = Math.max(0, Math.min(SESSION_SOURCE_MAX_BYTES - existingSourceBytes, SAFE_PAYLOAD_BYTES - payloadByteLength(envelope) - 64 * 1024));
  if (row.source === undefined) return row;
  const incoming = payloadByteLength(row.source) + 10;
  const perSource = incoming <= available ? OBSERVATION_SOURCE_MAX_BYTES : Math.min(OBSERVATION_SOURCE_MAX_BYTES, Math.floor(available) - 10);
  const metadata = { hookType: row.source.hookType, originalBytes: row.source.originalBytes, truncated: true };
  if (payloadByteLength(metadata) > perSource) {
    delete row.source;
    return row;
  }
  row.source = normalizeObservationSource(row.source, perSource);
  return row;
}

describe("source budget from session totals", () => {
  it("matches the upstream budget computed from the listed rows", () => {
    const output = "evidence ".repeat(3000);
    const raw = (id: string): RawObservation => ({
      id, sessionId: "s", timestamp: "2026-09-30T00:00:00Z", hookType: "post_tool_use", toolName: "Read", toolOutput: output, raw: {},
    });
    const rows: CompressedObservation[] = [];
    let totals = observationSourceTotals([]);
    for (let i = 0; i < 530; i++) {
      const next = buildSyntheticCompression(raw(`r${i}`));
      const fromTotals = budgetLiveObservationSource(next, totals);
      if (i % 40 === 0 || i > 505) expect(fromTotals).toEqual(upstreamBudget(next, rows));
      rows.push(fromTotals);
      const added = observationSourceTotals([fromTotals]);
      totals = { rows: totals.rows + 1, sourceBytes: totals.sourceBytes + added.sourceBytes, summaryBytes: totals.summaryBytes + added.summaryBytes };
    }
    expect(totals.sourceBytes).toBeLessThanOrEqual(SESSION_SOURCE_MAX_BYTES);
    expect(rows.at(-1)!.source).toBeUndefined();
    expect(rows.some((r) => r.source?.truncated)).toBe(true);
  }, 60_000);

  it("counts the kept rows' sources toward the one-response limit, as upstream does", () => {
    const source = (id: string, narrative: string): CompressedObservation => ({
      ...buildSyntheticCompression({ id, sessionId: "s", timestamp: "2026-09-30T00:00:00Z", hookType: "post_tool_use", toolOutput: "o".repeat(20_000), raw: {} } as RawObservation),
      narrative,
    });
    const chunk = Math.floor(SAFE_PAYLOAD_BYTES / 4);
    const base = [0, 1, 2].map((i) => budgetLiveObservationSource(source(`k${i}`, "n".repeat(chunk)), []));
    const keptBytes = payloadByteLength(base);
    const next = source("new", "");
    const nextSummary = payloadByteLength(withoutObservationSource(next));
    const room = SAFE_PAYLOAD_BYTES - 64 * 1024 - keptBytes - nextSummary - 120;
    for (const slack of [-20_000, 2_000, 9_000, 15_000, 40_000]) {
      const rows = [...base, source("pad", "p".repeat(Math.max(0, room - slack - 1500)))];
      expect(budgetLiveObservationSource(next, observationSourceTotals(rows))).toEqual(upstreamBudget(next, rows));
    }
  }, 60_000);

  it("drops the source when the session summaries would not fit one response", () => {
    const next = buildSyntheticCompression({ id: "big", sessionId: "s", timestamp: "2026-09-30T00:00:00Z", hookType: "post_tool_use", toolOutput: "x".repeat(4000), raw: {} } as RawObservation);
    expect(next.source).toBeDefined();
    const full = { rows: 10, sourceBytes: 0, summaryBytes: SAFE_PAYLOAD_BYTES };
    expect(budgetLiveObservationSource(next, full).source).toBeUndefined();
  });
});

describe("capture inbox paging", () => {
  it("sweeps, prunes, lists and reports the inbox without listing it whole", async () => {
    const h = harness({ guard: true });
    const { registerCaptureFunctions } = await import("../src/functions/capture.js");
    registerObserveFunction(h.sdk as never, h.kv, undefined, 500);
    const controller = registerCaptureFunctions(h.sdk as never, h.kv);
    const accepted = (await h.call("mem::capture", {
      payload: { sessionId: "ses_inbox", project: "proj", cwd: "/tmp", hookType: "post_tool_use", timestamp: new Date().toISOString(), data: { tool_name: "Read" } },
    })) as { status: string; state?: string };
    expect(accepted).toMatchObject({ status: "accepted", state: "completed" });
    const now = new Date().toISOString();
    for (const [key, status] of [["k_pending", "pending"], ["k_dead", "dead"]] as const) {
      await h.kv.set(KV.captureInbox, key, {
        key, eventId: `evs_${key}`, eventSource: "server", sessionId: "ses_inbox", project: "proj", hookType: "post_tool_use",
        observationId: `obs_${key}_0000000000`, status, attempts: status === "dead" ? 5 : 0, acceptedAt: now, updatedAt: now,
        ...(status === "dead" ? { deadAt: "2000-01-01T00:00:00Z" } : {}),
        payload: { sessionId: "ses_inbox", project: "proj", cwd: "/tmp", hookType: "post_tool_use", timestamp: now, data: { tool_name: key } },
      });
    }
    expect(await h.call("mem::capture-list", {})).toMatchObject({ total: 2 });
    expect(await controller.sweep()).toMatchObject({ processed: 1, recovered: 1 });
    expect(await controller.prune()).toBeGreaterThanOrEqual(1);
    expect((await controller.status()).inbox).toMatchObject({ pending: 0, dead: 0 });
    expect(h.rows("ses_inbox")).toBe(2);
    const whole = h.inventory.snapshot().reads.filter((r) => r.collection.startsWith("mem:capture") && r.op === "list");
    expect(whole).toEqual([]);
  });
});

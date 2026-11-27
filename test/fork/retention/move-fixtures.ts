import { vi } from "vitest";
import { captureEventScope } from "../../../src/capture/event-record.js";
import { loadActiveClock } from "../../../src/fork/retention/clock.js";
import { proveChain, successorIndex } from "../../../src/fork/retention/plan.js";
import { createProtector, type Candidate, type Cleared } from "../../../src/fork/retention/protect.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { RetentionDeps } from "../../../src/fork/retention/satellites.js";
import { RunStore, newRunRow } from "../../../src/fork/retention/run-store.js";
import type { RunId, SessionSeal } from "../../../src/fork/retention/types.js";
import { Vault } from "../../../src/fork/retention/vault.js";
import { activeVectorReader } from "../../../src/fork/retention/vectors.js";
import { withObservationStats } from "../../../src/fork/kv/observation-stats.js";
import { indexObservationSession } from "../../../src/state/obs-index.js";
import { KV } from "../../../src/state/schema.js";
import type { SearchRuntime } from "../../../src/state/search-ports.js";
import { SearchIndex } from "../../../src/state/search-index.js";
import { VectorIndex } from "../../../src/state/vector-index.js";
import { memoryToObservation } from "../../../src/state/memory-utils.js";
import type { CompressedObservation, Memory, Session } from "../../../src/types.js";
import { retentionHarness } from "./harness.js";

export const RUN = "ret_s4" as RunId;
export const NOW = new Date("2026-09-01T00:00:00.000Z");
export const DIMS = 8;

export const vec = (seed: number): Float32Array => Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed * 3 + i));

export function observation(id: string, sessionId = "ses_1", over: Partial<CompressedObservation> = {}): CompressedObservation {
  return {
    id, sessionId, timestamp: "2026-04-01T09:00:00.000Z", type: "file_read", title: `title ${id}`, facts: [`fact ${id}`],
    narrative: `narrative about ${id} zebra`, concepts: ["c"], files: ["a.ts"], importance: 5,
    source: { hookType: "post_tool_use", originalBytes: 4000, truncated: false, toolOutput: "x".repeat(400) }, ...over,
  };
}

export function memory(id: string, over: Partial<Memory> = {}): Memory {
  return {
    id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", type: "fact", title: `memory ${id}`,
    content: `content of ${id} okapi`, concepts: ["m"], files: [], sessionIds: ["ses_1"], strength: 1, version: 1, isLatest: true,
    forgetAfter: "2026-02-01T00:00:00.000Z", ...over,
  };
}

export function captureKeyOf(n: number): string {
  return `cap_${n.toString(16).padStart(40, "0")}`;
}

export function memoryRuntime(): SearchRuntime & { keyword: SearchIndex; vector: VectorIndex } {
  return {
    backend: "memory", keyword: new SearchIndex(), vector: new VectorIndex(),
    openPersistence: () => ({ scheduleSave: () => {} }),
  } as never;
}

export type Rig = ReturnType<typeof rig>;

export function rig(search?: () => SearchRuntime) {
  const h = retentionHarness();
  const kv = withObservationStats(h.kv);
  const runtime = memoryRuntime();
  const embed = vi.fn(async () => new Float32Array(DIMS));
  const deps: RetentionDeps = {
    sdk: h.sdk as never, kv, search: search ?? (() => runtime), vectors: activeVectorReader(search ?? (() => runtime)), now: () => NOW,
  };
  const vault = new Vault(kv);
  const runs = new RunStore(kv, () => NOW);
  return { h, kv, runtime, deps, vault, runs, embed };
}

export async function seedSession(r: Rig, id: string, over: Partial<Session> = {}): Promise<void> {
  await r.kv.set(KV.sessions, id, {
    id, project: "proj", cwd: "/w", startedAt: "2026-03-01T08:00:00.000Z", status: "completed", observationCount: 0, ...over,
  } satisfies Session);
}

export function sealFor(sessionId: string, count: number): SessionSeal {
  return { sessionId, sealedAt: "2026-04-10T00:00:00.000Z", summaryFingerprint: "fp", observationCount: count, graphExtracted: false, trimmed: false };
}

/** A live observation with everything that hangs off it: index doc, vector, session index, capture event. */
export async function seedObservation(r: Rig, row: CompressedObservation, opts: { seed?: number; captureKey?: string; indexed?: boolean } = {}): Promise<CompressedObservation> {
  const stored = opts.captureKey ? { ...row, captureKey: opts.captureKey } : row;
  if (!(await r.kv.get(KV.sessions, row.sessionId))) await seedSession(r, row.sessionId);
  await r.kv.set(KV.observations(row.sessionId), row.id, stored);
  await indexObservationSession(r.kv, row.id, row.sessionId);
  if (opts.indexed !== false) {
    r.runtime.keyword.add(stored);
    if (opts.seed !== undefined) r.runtime.vector.add(row.id, row.sessionId, vec(opts.seed));
  }
  if (opts.captureKey) {
    await r.kv.set(captureEventScope(opts.captureKey), opts.captureKey, {
      key: opts.captureKey, eventId: `evc_${row.id}`, sessionId: row.sessionId, project: "proj", observationId: row.id,
      acceptedAt: "2026-04-01T09:00:00.000Z", completedAt: "2026-04-01T09:00:01.000Z", attempts: 1,
    });
  }
  return stored;
}

export async function seedMemory(r: Rig, row: Memory, opts: { seed?: number } = {}): Promise<Memory> {
  await r.kv.set(KV.memories, row.id, row);
  if (row.isLatest) {
    r.runtime.keyword.add(memoryToObservation(row), "memory");
    if (opts.seed !== undefined) r.runtime.vector.add(row.id, memoryToObservation(row).sessionId, vec(opts.seed));
  }
  return row;
}

export async function seedSeal(r: Rig, sessionId: string, count: number): Promise<SessionSeal> {
  const seal = sealFor(sessionId, count);
  await r.kv.set(RETENTION_KV.seals, sessionId, seal);
  return seal;
}

/**
 * A candidate through the real `Protector`: `Cleared` is minted by `judge`, and a stage S candidate carries the
 * proof `proveChain` returns over a successor memory that this seeds when the memory has none.
 */
export async function candidate(r: Rig, stage: "T" | "O", row: CompressedObservation, seal: SessionSeal): Promise<Cleared>;
export async function candidate(r: Rig, stage: "S" | "X", row: Memory): Promise<Cleared>;
export async function candidate(r: Rig, stage: "T" | "O" | "S" | "X", row: CompressedObservation | Memory, seal?: SessionSeal): Promise<Cleared> {
  const reason = { stage, ageActiveDays: 200, note: "aged" };
  let item: Candidate;
  if (stage === "T" || stage === "O") {
    const obs = row as CompressedObservation;
    item = { project: "proj", stage, ref: { kind: "observation", sessionId: obs.sessionId, id: obs.id }, row: obs, proof: { seal: seal! }, reason };
  } else if (stage === "X") {
    item = { project: "proj", stage, ref: { kind: "memory", id: row.id }, row: row as Memory, reason };
  } else {
    const old = row as Memory;
    const next = memory(`${old.id}_next`, { version: old.version + 1, supersedes: [old.id], parentId: old.id, createdAt: old.createdAt, forgetAfter: undefined });
    if (!(await r.kv.get(KV.memories, next.id))) await r.kv.set(KV.memories, next.id, next);
    const proof = await proveChain(r.kv, old, await successorIndex(r.kv));
    if (!proof) throw new Error(`no chain proof for ${old.id}`);
    item = { project: "proj", stage, ref: { kind: "memory", id: old.id }, row: old, proof, reason };
  }
  const windows = { trimDays: 0, observationDays: 0, supersededDays: 0, coldDays: 0 };
  const verdict = await (await createProtector(r.kv, windows, await loadActiveClock(r.kv, () => NOW))).judge(item);
  if (verdict.kind !== "clear") throw new Error(`fixture candidate is protected by ${verdict.signal}`);
  return verdict.item;
}

/** The sweep owns `RunRow.held`; tests that move items stand in for it. */
export async function openRun(r: Rig, id: RunId = RUN, held = 0): Promise<void> {
  await r.runs.save({ ...newRunRow({ id, dryRun: false, windows: { trimDays: 1, observationDays: 1, supersededDays: 1, coldDays: 1 }, graceDays: 30, ranBy: "test", startedAt: NOW.toISOString() }), held });
}

export const liveRow = <T>(r: Rig, scope: string, key: string) => r.kv.get<T>(scope, key);
export const keywordHits = async (r: Rig, query: string) => (await r.runtime.keyword.search(query, 10)).map((h) => h.obsId).sort();
export const vectorHits = async (r: Rig, seed: number) => (await r.runtime.vector.search(vec(seed), 10)).map((h) => h.obsId).sort();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { indexObservationSession } from "../src/state/obs-index.js";
import { KV } from "../src/state/schema.js";
import { captureFunctions, readCostKV } from "./helpers/read-cost-kv.js";

const NOW = Date.parse("2026-04-01T00:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// mem::diagnose (memory_diagnose) over every category it checks, each seeded with healthy rows and a few broken
// ones (TEE-1451). Facets point at live and deleted memories, lessons, actions and observations. With
// observationScan, one live observation target has no session index row and another is gone, so the facets
// check has to scan every session's observations; without it every observation target resolves through the index.
async function fixture(opts: { observationScan: boolean }) {
  const { kv, seed, measure } = readCostKV();
  for (let a = 0; a < 60; a++) {
    const status = ["active", "blocked", "pending", "done", "done"][a % 5];
    seed(KV.actions, `act_${a}`, { id: `act_${a}`, title: `action ${a}`, status, createdAt: iso(NOW - a * HOUR) });
  }
  for (let e = 0; e < 80; e++) {
    const id = `edge_${e}`;
    seed(KV.actionEdges, id, { id, type: e % 3 ? "requires" : "unlocks", sourceActionId: `act_${e % 60}`, targetActionId: `act_${(e * 7) % 65}`, createdAt: iso(NOW - e * HOUR) });
  }
  for (let l = 0; l < 30; l++) {
    const id = `lease_${l}`;
    seed(KV.leases, id, { id, actionId: `act_${(l * 5) % 64}`, agentId: "a", acquiredAt: iso(NOW - 2 * HOUR), expiresAt: iso(NOW + (l % 4 ? HOUR : -HOUR)), status: l % 6 ? "active" : "released" });
  }
  for (let s = 0; s < 10; s++) {
    const id = `snt_${s}`;
    seed(KV.sentinels, id, { id, name: `sentinel ${s}`, type: "timer", status: s % 3 ? "watching" : "triggered", config: {}, createdAt: iso(NOW - HOUR), expiresAt: s % 4 ? iso(NOW + HOUR) : iso(NOW - HOUR), linkedActionIds: [`act_${s * 7}`] });
  }
  for (let s = 0; s < 8; s++) {
    const id = `skt_${s}`;
    seed(KV.sketches, id, { id, title: `sketch ${s}`, description: "", status: s % 2 ? "active" : "promoted", actionIds: [], createdAt: iso(NOW - HOUR), expiresAt: iso(NOW + (s % 3 ? HOUR : -HOUR)) });
  }
  for (let s = 0; s < 20; s++) {
    const id = `sig_${s}`;
    seed(KV.signals, id, { id, from: `agent-${s}`, createdAt: iso(NOW - HOUR), ...(s % 5 ? {} : { expiresAt: iso(NOW - HOUR) }) });
  }
  for (let s = 0; s < 120; s++) {
    const id = `ses_${String(s).padStart(3, "0")}`;
    seed(KV.sessions, id, { id, project: "p", cwd: "/repo", startedAt: iso(NOW - (s % 30) * 2 * HOUR), status: s % 9 ? "completed" : "active", observationCount: 3 });
    if (s < 60) seed(KV.summaries, id, { sessionId: id, project: "p", createdAt: iso(NOW - s * HOUR), title: s % 25 ? `summary ${s}` : "", narrative: "", keyDecisions: [], filesModified: [], concepts: [], observationCount: 3 });
    for (let o = 0; o < 3; o++) {
      const obsId = `obs_${s}x${o}`;
      seed(KV.observations(id), obsId, { id: obsId, sessionId: id, timestamp: iso(NOW - s * HOUR), type: "file_edit", title: "t", narrative: "n", concepts: [], facts: [], files: [], importance: 5 });
    }
  }
  for (let m = 0; m < 200; m++) {
    const id = `mem_${m}`;
    seed(KV.memories, id, { id, createdAt: iso(NOW - m * HOUR), updatedAt: iso(NOW - m * HOUR), type: "fact", title: `memory ${m}`, content: "c", concepts: [], files: [], sessionIds: [], strength: 5, version: 1, isLatest: m % 50 !== 1, ...(m % 40 === 0 ? { supersedes: [`mem_${m + 1}`, "mem_missing"] } : {}), ...(m % 30 === 7 ? {} : { project: "p" }) });
  }
  for (let l = 0; l < 40; l++) {
    const id = `lsn_${l}`;
    seed(KV.lessons, id, { id, content: "c", context: "", confidence: l % 13 ? 0.5 : 1.5, reinforcements: 0, source: "manual", sourceIds: [], tags: [], createdAt: iso(NOW - l * HOUR), updatedAt: iso(NOW), decayRate: 0, ...(l % 10 === 3 ? { deleted: true } : {}) });
  }
  for (let i = 0; i < 40; i++) seed(KV.semantic, `sem_${i}`, { id: `sem_${i}`, fact: "f", confidence: i % 17 ? 0.7 : Number.NaN, createdAt: iso(NOW - i * HOUR) });
  for (let i = 0; i < 15; i++) seed(KV.procedural, `proc_${i}`, { id: `proc_${i}`, name: `proc ${i}`, steps: i % 7 ? ["a"] : [], createdAt: iso(NOW - i * HOUR) });
  for (let i = 0; i < 15; i++) seed(KV.crystals, `crys_${i}`, { id: `crys_${i}`, narrative: i % 6 ? "n" : " ", createdAt: iso(NOW - i * HOUR) });
  for (let i = 0; i < 15; i++) seed(KV.insights, `ins_${i}`, { id: `ins_${i}`, confidence: i % 8 ? 0.4 : -1, createdAt: iso(NOW - i * HOUR) });
  for (let i = 0; i < 4; i++) seed(KV.mesh, `peer_${i}`, { id: `peer_${i}`, url: "http://peer", name: `peer ${i}`, status: i === 2 ? "error" : "connected", sharedScopes: [], lastSyncAt: iso(NOW - (i === 1 ? 2 : 0.1) * HOUR) });

  const facetTargets = ([
    ["mem_3", "memory"], ["mem_gone", "memory"], ["lsn_1", "memory"], ["lsn_3", "memory"],
    ["act_4", "action"], ["act_missing", "action"],
    ["obs_5x1", "observation"], ["obs_gone", "observation"], ["obs_7x2", "observation"],
    ["obs_9x0", "memory"], ["sem_4", "memory"],
  ] as Array<[string, string]>).filter(([id]) => opts.observationScan || id !== "obs_gone");
  for (let f = 0; f < 40; f++) {
    const [targetId, targetType] = facetTargets[f % facetTargets.length];
    seed(KV.facets, `fct_${f}`, { id: `fct_${f}`, targetId, targetType, dimension: `d${f % 3}`, value: "v", createdAt: iso(NOW - f * HOUR) });
  }
  for (const [obsId, sessionId] of [["obs_5x1", "ses_005"], ["obs_9x0", "ses_009"], ["obs_gone", "ses_010"]]) {
    await indexObservationSession(kv, obsId, sessionId);
  }
  if (!opts.observationScan) await indexObservationSession(kv, "obs_7x2", "ses_007");

  const { sdk, call } = captureFunctions();
  registerDiagnosticsFunction(sdk as never, kv);
  return { diagnose: (data: Record<string, unknown>) => measure(() => call("mem::diagnose", data)) };
}

describe("diagnose read cost (TEE-1451)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["every category", {}],
    ["a few categories", { categories: ["facets", "leases", "actions", "nonsense"] }],
  ])("returns the same report for %s", async (name, data) => {
    for (const observationScan of [true, false]) {
      const { out } = await (await fixture({ observationScan })).diagnose(data);
      expect(out).toMatchSnapshot(`${name}, ${observationScan ? "with" : "without"} an observation scan`);
    }
  });

  // Before TEE-1451 the categories ran one after another, each reading its scopes again, and the facets check
  // looked its targets up one at a time: 1,372 reads, 129 round trips deep for every category here (1,006 and
  // 102 with no observation scan), and 490 reads, 51 deep for the facets check alone. Reading each scope once and
  // running the categories and the target lookups together brought them to 1,037 and 25, 792 and 14, and 490 and
  // 34; the ceilings sit just above that. The facets check keeps its reads: the scan is what proves an observation
  // target gone when the session index has no row for it.
  it.each([
    ["every category", {}, { observationScan: true }, { reads: 1045, depth: 27 }],
    ["every category, no observation scan", {}, { observationScan: false }, { reads: 800, depth: 16 }],
    ["facets", { categories: ["facets"] }, { observationScan: true }, { reads: 495, depth: 36 }],
  ])("keeps the reads of a %s diagnose under its ceiling", async (_name, data, opts, ceiling) => {
    const r = await (await fixture(opts)).diagnose(data);
    expect({ reads: r.reads, depth: r.depth }).toEqual({
      reads: Math.min(r.reads, ceiling.reads),
      depth: Math.min(r.depth, ceiling.depth),
    });
  });
});

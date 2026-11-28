import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { KV } from "../src/state/schema.js";
import { captureFunctions, readCostKV } from "./helpers/read-cost-kv.js";

const START = Date.parse("2026-01-10T00:00:00Z");
const at = (n: number) => new Date(START + n * 60_000).toISOString();

const COLLECTIONS: Array<[string, number]> = [
  [KV.graphNodes, 20], [KV.graphEdges, 20], [KV.semantic, 50], [KV.procedural, 10], [KV.actions, 40],
  [KV.actionEdges, 30], [KV.sentinels, 5], [KV.sketches, 5], [KV.crystals, 10], [KV.facets, 30],
  [KV.lessons, 40], [KV.insights, 10], [KV.routines, 5], [KV.signals, 10], [KV.checkpoints, 5],
];

// mem::export (memory_export) over 30 sessions, 300 memories, and every other exported collection (TEE-1451).
// An agent that asks for a few collections should not pay to read the rest.
function fixture() {
  const { kv, seed, measure } = readCostKV();
  for (let s = 0; s < 30; s++) {
    const id = `ses_${String(s).padStart(2, "0")}`;
    const project = ["api", "web", "cli"][s % 3];
    seed(KV.sessions, id, { id, project, cwd: "/repo", startedAt: at(s * 10), status: "completed", observationCount: 4 });
    seed(KV.summaries, id, { sessionId: id, project, createdAt: at(s * 10 + 5), title: `summary ${s}`, narrative: "n", keyDecisions: [], filesModified: [], concepts: [], observationCount: 4 });
    for (let o = 0; o < 4; o++) {
      const obsId = `obs_${s}x${o}`;
      seed(KV.observations(id), obsId, { id: obsId, sessionId: id, timestamp: at(s * 10 + o), type: "file_edit", title: `obs ${s}/${o}`, narrative: "n", concepts: [], facts: [], files: [], importance: 5 });
    }
  }
  for (const project of ["api", "web"]) seed(KV.profiles, project, { project, updatedAt: at(1), topConcepts: [], topFiles: [], conventions: [], commonErrors: [], recentActivity: [], sessionCount: 10, totalObservations: 40 });
  for (let m = 0; m < 300; m++) {
    const id = `mem_${m}`;
    seed(KV.memories, id, { id, createdAt: at(m), updatedAt: at(m), type: "fact", title: `memory ${m}`, content: "c", concepts: [], files: [], sessionIds: [], strength: 5, version: 1, isLatest: true, project: "api" });
    if (m % 6 === 0) seed(KV.accessLog, id, { memoryId: id, count: m % 7, lastAt: at(m + 1), recent: [START + m] });
  }
  for (const [scope, count] of COLLECTIONS) {
    for (let i = 0; i < count; i++) {
      const id = `${scope.split(":").pop()}_${i}`;
      seed(scope, id, { id, createdAt: at(i), name: `${scope} ${i}`, targetId: `mem_${i}`, status: "active" });
    }
  }
  const { sdk, call } = captureFunctions();
  registerExportImportFunction(sdk as never, kv);
  return { exportData: (data: Record<string, unknown>) => measure(() => call<Record<string, unknown>>("mem::export", data)) };
}

function digest(out: Record<string, unknown>) {
  const counts: Record<string, number> = {};
  for (const [field, value] of Object.entries(out)) {
    if (Array.isArray(value)) counts[field] = value.length;
    else if (field === "observations") counts[field] = Object.keys(value as object).length;
  }
  return {
    fields: Object.keys(out),
    counts,
    pagination: out.pagination,
    collectionPagination: out.collectionPagination,
    sha256: createHash("sha256").update(JSON.stringify(out)).digest("hex"),
  };
}

const shapes: Array<[string, Record<string, unknown>]> = [
  ["everything", {}],
  ["everything, one session page", { maxSessions: 10, offset: 5 }],
  ["memories only", { collections: "memories" }],
  ["two collections, paged", { collections: "facets,lessons", collectionLimit: 5, collectionOffset: 2 }],
  ["actions with a session page", { collections: "actions", maxSessions: 5 }],
  ["sessions page only", { collections: "sessions", maxSessions: 10, offset: 5 }],
  ["access logs only", { collections: "accessLogs" }],
  ["memories and their access logs, paged", { collections: ["memories", "accessLogs"], collectionLimit: 10 }],
  ["summaries and graph", { collections: "summaries,graphNodes,graphEdges" }],
  ["no known collection", { collections: "bogus" }],
];

describe("export read cost (TEE-1451)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns the same export for the requests agents send", async () => {
    const f = fixture();
    for (const [name, data] of shapes) {
      const { out } = await f.exportData(data);
      expect(digest(out)).toMatchSnapshot(name);
    }
  });

  // Before TEE-1451 an export of a few collections still read every row of the sessions, memories, summaries
  // and each other collection, then dropped the rows it was not asked for.
  it.each([
    ["memories only", { collections: "memories" }, { reads: 330, depth: 40 }],
    ["two collections, paged", { collections: "facets,lessons", collectionLimit: 5, collectionOffset: 2 }, { reads: 100, depth: 30 }],
    ["access logs only", { collections: "accessLogs" }, { reads: 80, depth: 30 }],
  ])("keeps the reads of a %s export under its ceiling", async (_name, data, ceiling) => {
    const r = await fixture().exportData(data);
    expect({ reads: r.reads, depth: r.depth }).toEqual({
      reads: Math.min(r.reads, ceiling.reads),
      depth: Math.min(r.depth, ceiling.depth),
    });
  });
});

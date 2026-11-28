import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/functions/access-tracker.js", () => ({ recordAccessBatch: vi.fn(async () => {}) }));

import { registerFileIndexFunction } from "../src/functions/file-index.js";
import { KV } from "../src/state/schema.js";
import { captureFunctions, readCostKV } from "./helpers/read-cost-kv.js";

const START = Date.parse("2026-02-01T00:00:00Z");

// mem::file-context (memory_file_history) over 60 sessions in 2 projects, 12 observations each (TEE-1451).
// It reads the 15 newest other sessions, so the fixture's newest sessions hold most of the file hits.
function fixture() {
  const { kv, seed, measure } = readCostKV();
  for (let s = 0; s < 60; s++) {
    const id = `ses_${String(s).padStart(2, "0")}`;
    seed(KV.sessions, id, { id, project: s % 2 ? "web" : "api", cwd: "/repo", startedAt: new Date(START + ((s * 37) % 60) * 3_600_000).toISOString(), status: "completed", observationCount: 12 });
    for (let o = 0; o < 12; o++) {
      const obsId = `obs_${s}x${o}`;
      seed(KV.observations(id), obsId, {
        id: obsId,
        sessionId: id,
        timestamp: new Date(START + s * 3_600_000 + o * 60_000).toISOString(),
        type: o % 3 ? "file_edit" : "decision",
        title: o === 7 ? "" : `change ${o} in ${id}`,
        narrative: `narrative ${s}/${o}`,
        concepts: [],
        facts: [],
        files: [`src/${["kv", "timeline", "export"][o % 3]}.ts`, o % 4 === 0 ? "/abs/repo/src/diagnostics.ts" : "README.md"],
        importance: (s * 3 + o) % 11,
      });
    }
  }
  const { sdk, call } = captureFunctions();
  registerFileIndexFunction(sdk as never, kv);
  return { history: (data: Record<string, unknown>) => measure(() => call("mem::file-context", data)) };
}

const shapes: Array<[string, Record<string, unknown>]> = [
  ["one file", { files: ["src/kv.ts"] }],
  ["several files, one excluded session", { sessionId: "ses_59", files: ["./src/timeline.ts", "src/diagnostics.ts", "README.md"] }],
  ["one project", { project: "web", files: ["src/export.ts", "src/kv.ts"] }],
  ["no history", { files: ["src/none.ts"] }],
  ["no files", { files: [] }],
];

describe("file history read cost (TEE-1451)", () => {
  it("returns the same file context for the requests agents send", async () => {
    const f = fixture();
    for (const [name, data] of shapes) {
      const { out } = await f.history(data);
      expect(out).toMatchSnapshot(name);
    }
  });

  // Before TEE-1451 it listed the 15 newest sessions' observations one session at a time: 91 reads,
  // 35 round trips deep here.
  it("keeps the reads of a file history under its ceiling", async () => {
    const r = await fixture().history({ files: ["src/kv.ts"] });
    expect({ reads: r.reads, depth: r.depth }).toEqual({ reads: Math.min(r.reads, 95), depth: Math.min(r.depth, 10) });
  });
});

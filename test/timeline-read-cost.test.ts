import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/functions/access-tracker.js", () => ({ recordAccessBatch: vi.fn(async () => {}) }));

import { registerTimelineFunction } from "../src/functions/timeline.js";
import { KV } from "../src/state/schema.js";
import { captureFunctions, readCostKV } from "./helpers/read-cost-kv.js";

const PROJECTS = ["alpha", "beta", "gamma"];
const SESSIONS = 120;
const PER_SESSION = 8;
const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-03-01T00:00:00Z");

// mem::timeline over 120 sessions in 3 projects, 8 observations each (TEE-1451). Some observations share a
// timestamp across sessions, so the window's order depends on the order sessions are read in. Some have no
// title: the keyword step still matches them, the window leaves them out.
function fixture() {
  const { kv, seed, measure } = readCostKV();
  for (let s = 0; s < SESSIONS; s++) {
    const id = `ses_${String(s).padStart(3, "0")}`;
    const project = PROJECTS[s % PROJECTS.length];
    seed(KV.sessions, id, { id, project, cwd: "/repo", startedAt: new Date(START + s * 3_600_000).toISOString(), status: "completed", observationCount: PER_SESSION });
    for (let o = 0; o < PER_SESSION; o++) {
      const at = START + ((s * 7 + o * 13) % 40) * (DAY / 4) + (o === 3 ? 0 : s * 1000);
      const obsId = `obs_${s}x${o}`;
      seed(KV.observations(id), obsId, {
        id: obsId,
        sessionId: id,
        timestamp: new Date(at).toISOString(),
        type: o % 2 ? "file_edit" : "decision",
        title: o === 5 && s % 10 === 0 ? "" : `${o % 4 === 0 ? "rollback" : "deploy"} step ${o} of ${id}`,
        narrative: s === 77 && o === 5 ? "untitled kvrocks outage note" : `narrative ${s}/${o}`,
        concepts: o === 2 ? ["kvrocks", "latency"] : ["deploy"],
        facts: [],
        files: [`src/${o}.ts`],
        importance: (s + o) % 10,
      });
    }
  }
  const { sdk, call } = captureFunctions();
  registerTimelineFunction(sdk as never, kv);
  return { timeline: (data: Record<string, unknown>) => measure(() => call("mem::timeline", data)) };
}

const shapes: Array<[string, Record<string, unknown>]> = [
  ["keyword in one project", { anchor: "rollback", project: "alpha", before: 3, after: 3 }],
  ["keyword everywhere", { anchor: "Rollback" }],
  ["keyword in concepts", { anchor: "kvrocks", before: 2, after: 6 }],
  ["keyword only an untitled observation matches", { anchor: "outage", before: 2, after: 2 }],
  ["keyword with no match", { anchor: "no-such-word" }],
  ["iso anchor in one project", { anchor: "2026-03-05T12:00:00Z", project: "beta", before: 4, after: 2 }],
  ["iso anchor everywhere", { anchor: "2026-03-08", before: 0, after: 5 }],
  ["invalid iso anchor", { anchor: "2026-13-45" }],
  ["project with no sessions", { anchor: "rollback", project: "missing" }],
];

describe("timeline read cost (TEE-1451)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns the same timeline for the anchors agents send", async () => {
    const f = fixture();
    for (const [name, data] of shapes) {
      const { out } = await f.timeline(data);
      expect(out).toMatchSnapshot(name);
    }
  });

  // Before TEE-1451 a keyword anchor listed every session's observations twice, one session at a time
  // (once to find the keyword, once for the window): 722 reads, 498 round trips deep here. One scan, 16 sessions
  // at a time, brought it to 361 reads, 25 deep (201 and 15 in one project); the ceilings sit just above that.
  it.each([
    ["keyword everywhere", { anchor: "rollback" }, { reads: 370, depth: 27 }],
    ["keyword in one project", { anchor: "rollback", project: "alpha" }, { reads: 210, depth: 17 }],
    ["iso anchor everywhere", { anchor: "2026-03-08" }, { reads: 370, depth: 27 }],
  ])("keeps the reads of a %s timeline under its ceiling", async (_name, data, ceiling) => {
    const r = await fixture().timeline(data);
    expect({ reads: r.reads, depth: r.depth }).toEqual({
      reads: Math.min(r.reads, ceiling.reads),
      depth: Math.min(r.depth, ceiling.depth),
    });
  });
});

// TEE-1450: replays one fixed mix of normal traffic for a set number of minutes, so a
// before and an after run send the same requests: hook captures (observe), pre-tool-use
// enrich, smart-search, lesson recall and status. Pair it with access-tally.mjs over the
// Qdrant container's log for the same window. Runs on the replica network (replica.sh client).
//
//   node --import tsx bench/fork/qdrant/count-traffic.ts [--minutes 30] [--url http://agentmemory:3111]
//     [--per-minute observe=4,enrich=2,search=1,lessons=1,status=1]
import { parseArgs } from "node:util";
import { mulberry32 } from "../lib/stats.js";
import { Corpus } from "../lib/synthetic.js";

const { values: args } = parseArgs({
  options: {
    minutes: { type: "string", default: "30" },
    url: { type: "string", default: "http://agentmemory:3111" },
    secret: { type: "string", default: "replica-dummy-secret" },
    "per-minute": { type: "string", default: "observe=4,enrich=2,search=1,lessons=1,status=1" },
  },
});
const minutes = Number(args.minutes);
const KINDS = new Set(["observe", "enrich", "search", "lessons", "status"]);
const perMinute = Object.fromEntries(args["per-minute"]!.split(",").map((kv) => {
  const [k, v, extra] = kv.split("=");
  const n = Number(v);
  if (!k || !KINDS.has(k) || extra !== undefined || !Number.isFinite(n) || n < 0) throw new Error(`bad --per-minute entry ${JSON.stringify(kv)}`);
  return [k, n];
}));
const rand = mulberry32(1450);
const corpus = new Corpus(20_000);
const runId = Date.now().toString(36);
const sessions = Array.from({ length: 4 }, (_, i) => `ses_traffic_${runId}_${i}`);
const QUERIES = ["redis connection timeout", "qdrant facet", "kvrocks migration", "search worker", "hook latency", "retention sweep", "vector backfill", "status endpoint"];

type Kind = "observe" | "enrich" | "search" | "lessons" | "status";
const request = (kind: Kind, i: number): { method: string; path: string; body?: unknown } => {
  const sessionId = sessions[i % sessions.length]!;
  switch (kind) {
    case "observe":
      return {
        method: "POST", path: "/agentmemory/observe",
        body: {
          hookType: "post_tool_use", sessionId, project: "count-traffic", cwd: "/work/count-traffic", timestamp: new Date().toISOString(), eventId: `traffic-${runId}-${i}`,
          data: { tool_name: "Bash", tool_input: { command: `echo ${i}` }, tool_output: `traffic ${runId} ${i} ${corpus.text(400 + Math.floor(rand() * 1200), rand)}` },
        },
      };
    case "enrich":
      return { method: "POST", path: "/agentmemory/enrich", body: { sessionId, files: [`/work/count-traffic/src/file${i % 7}.ts`], toolName: "Edit", project: "count-traffic" } };
    case "search":
      return { method: "POST", path: "/agentmemory/smart-search", body: { query: QUERIES[i % QUERIES.length], limit: 10 } };
    case "lessons":
      return { method: "POST", path: "/agentmemory/lessons/search", body: { query: QUERIES[(i + 3) % QUERIES.length], limit: 5 } };
    case "status":
      return { method: "GET", path: "/agentmemory/status" };
  }
};

// Every request's offset in the run, fixed by the seed, spread evenly per kind with jitter.
const schedule: Array<{ at: number; kind: Kind; i: number }> = [];
for (const [kind, n] of Object.entries(perMinute) as Array<[Kind, number]>) {
  const total = Math.round(n * minutes);
  for (let i = 0; i < total; i++) schedule.push({ at: ((i + rand()) / total) * minutes * 60_000, kind, i });
}
schedule.sort((a, b) => a.at - b.at);

const started = Date.now();
const results: Record<string, { ok: number; failed: number; ms: number[] }> = {};
const pending: Promise<void>[] = [];
console.error(`count-traffic: ${schedule.length} requests over ${minutes} min, started ${new Date(started).toISOString()}`);
for (const { at, kind, i } of schedule) {
  const wait = started + at - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const { method, path, body } = request(kind, i);
  const t0 = performance.now();
  pending.push(
    fetch(`${args.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    }).then(async (res) => {
      await res.arrayBuffer();
      const r = (results[kind] ??= { ok: 0, failed: 0, ms: [] });
      if (res.ok) r.ok++;
      else r.failed++;
      r.ms.push(performance.now() - t0);
    }, () => {
      (results[kind] ??= { ok: 0, failed: 0, ms: [] }).failed++;
    }),
  );
}
await Promise.all(pending);
const summary = Object.fromEntries(Object.entries(results).map(([k, r]) => {
  const ms = r.ms.sort((a, b) => a - b);
  const at = (q: number) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * q))]!) : null);
  return [k, { ok: r.ok, failed: r.failed, samples: ms.length, p50: at(0.5), p95: at(0.95) }];
}));
console.log(JSON.stringify({ started: new Date(started).toISOString(), ended: new Date().toISOString(), minutes, perMinute, summary }, null, 2));

// Replays a compressed day of agentmemory traffic against a running server so
// the scope guard (AGENTMEMORY_SCOPE_GUARD=warn) records every whole-collection
// read a real day causes. Never point it at production: it writes data and runs
// auto-forget.
//
// Usage:
//   AGENTMEMORY_SECRET=... npx tsx scripts/fork/replay-day.ts \
//     --url http://127.0.0.1:3111 --container <agentmemory container> \
//     [--obs-per-day 20000] [--factor 24] [--sessions-per-day 60] \
//     [--searches-per-day 600] [--project replay]
//
// --factor compresses time: 24 plays one day in one hour, every rate and every
// timer runs 24x faster. Timer jobs without a REST endpoint are triggered on the
// engine from inside --container (docker exec); without --container they are skipped.
// With no LLM provider configured, summaries and consolidation return without
// work, but their calls and the reads they make before that still happen.

import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3111" },
    container: { type: "string" },
    "obs-per-day": { type: "string", default: "20000" },
    factor: { type: "string", default: "24" },
    "sessions-per-day": { type: "string", default: "60" },
    "searches-per-day": { type: "string", default: "600" },
    project: { type: "string", default: "replay" },
  },
});

const DAY_S = 86_400;
const base = args.url!.replace(/\/$/, "");
const factor = Number(args.factor);
const obsPerDay = Number(args["obs-per-day"]);
const sessionsPerDay = Math.max(1, Number(args["sessions-per-day"]));
const searchesPerDay = Number(args["searches-per-day"]);
const project = args.project!;
const durationS = DAY_S / factor;
const secret = process.env.AGENTMEMORY_SECRET;
const headers: Record<string, string> = {
  "content-type": "application/json",
  ...(secret ? { authorization: `Bearer ${secret}` } : {}),
};

type Timer = { name: string; everyS: number; rest?: { path: string; body: unknown }; fn?: string };
// Real intervals from src/index.ts, in day-seconds. Minute-scale timers (session
// finalize, capture sweeps) are left to the server, which runs them in real time.
const timers: Timer[] = [
  { name: "auto-forget", everyS: 3600, rest: { path: "/agentmemory/auto-forget", body: { dryRun: false } } },
  { name: "consolidate-pipeline", everyS: 6 * 3600, rest: { path: "/agentmemory/consolidate-pipeline", body: {} } },
  { name: "session-sweep", everyS: 3600, fn: "mem::session-sweep" },
  { name: "recent-searches-sweep", everyS: 3600, fn: "mem::diagnostic::recent-searches-sweep" },
  { name: "lesson-decay-sweep", everyS: DAY_S, fn: "mem::lesson-decay-sweep" },
  { name: "insight-decay-sweep", everyS: DAY_S, fn: "mem::insight-decay-sweep" },
  { name: "audit-retention-sweep", everyS: DAY_S, fn: "mem::audit-retention-sweep" },
];

const counts = new Map<string, { ok: number; failed: number; firstError?: string }>();
function tally(name: string, ok: boolean, error?: string) {
  const entry = counts.get(name) ?? { ok: 0, failed: 0 };
  if (ok) entry.ok++;
  else {
    entry.failed++;
    entry.firstError ??= error?.replace(/\s+/g, " ").slice(0, 160);
  }
  counts.set(name, entry);
}

async function post(name: string, path: string, body: unknown): Promise<void> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    tally(name, response.ok, `${response.status} ${text}`);
  } catch (error) {
    tally(name, false, String(error));
  }
}

const ENGINE_TRIGGER = `
import { registerWorker } from "iii-sdk";
const sdk = registerWorker("ws://127.0.0.1:" + (process.env.III_ENGINE_PORT || "49134"), { workerName: "replay-driver-" + process.pid + "-" + Date.now(), namespace: process.env.III_NAMESPACE || "agentmemory" });
try { await sdk.trigger({ function_id: process.env.REPLAY_FN, payload: {}, timeoutMs: 120000 }); }
finally { await sdk.shutdown(); }
`;

async function triggerInContainer(name: string, fn: string): Promise<void> {
  if (!args.container) return tally(`${name} (skipped: no --container)`, true);
  try {
    await promisify(execFile)("docker", ["exec", "-e", `REPLAY_FN=${fn}`, "-w", "/opt/agentmemory", args.container,
      "node", "--input-type=module", "-e", ENGINE_TRIGGER], { timeout: 150_000 });
    tally(name, true);
  } catch (error) {
    tally(name, false, String((error as { stderr?: string }).stderr || error).split("\n").find((line) => /Error/.test(line)));
  }
}

const words = ["parser", "cache", "retry", "index", "schema", "router", "migration", "worker", "queue", "token",
  "session", "vector", "graph", "lease", "budget", "snapshot", "compactor", "handler", "config", "fixture"];
const tools = ["Read", "Edit", "Bash", "Grep", "Write", "Glob"];
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;
const phrase = (n: number) => Array.from({ length: n }, () => pick(words)).join(" ");

function observation(sessionId: string, seq: number) {
  const tool = pick(tools);
  return {
    hookType: "post_tool_use",
    sessionId,
    project,
    cwd: `/work/${project}`,
    timestamp: new Date().toISOString(),
    eventId: `${sessionId}-${seq}`,
    data: {
      tool_name: tool,
      tool_input: { file_path: `src/${pick(words)}/${pick(words)}.ts`, command: `${tool.toLowerCase()} ${phrase(3)}` },
      tool_output: `${phrase(40)}\n`.repeat(1 + Math.floor(Math.random() * 6)),
    },
  };
}

const sessionLengthS = DAY_S / sessionsPerDay;
const obsIntervalMs = (DAY_S / obsPerDay / factor) * 1000;
const searchIntervalMs = searchesPerDay > 0 ? (DAY_S / searchesPerDay / factor) * 1000 : Infinity;
const startedAt = Date.now();
const elapsedDayS = () => ((Date.now() - startedAt) / 1000) * factor;

console.log(
  `replay: factor=${factor} (one day in ${(durationS / 60).toFixed(1)} min), ` +
    `${obsPerDay} obs/day = ${(1000 / obsIntervalMs).toFixed(2)} obs/s, ` +
    `${sessionsPerDay} sessions/day, ${searchesPerDay} searches/day, ` +
    `engine timers ${args.container ? `via ${args.container}` : "skipped"}`,
);

let sessionIndex = -1;
let sessionId = "";
let seq = 0;
const inFlight = new Set<Promise<void>>();
const track = (promise: Promise<void>) => {
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise));
};

async function rollSession(): Promise<void> {
  const index = Math.floor(elapsedDayS() / sessionLengthS);
  if (index === sessionIndex) return;
  if (sessionId) {
    await post("session/end", "/agentmemory/session/end", { sessionId });
    await post("summarize", "/agentmemory/summarize", { sessionId });
  }
  sessionIndex = index;
  sessionId = `ses_replay_${startedAt.toString(36)}_${index}`;
  seq = 0;
  await post("session/start", "/agentmemory/session/start", { sessionId, project, cwd: `/work/${project}`, title: phrase(4) });
}

const nextTimerAt = new Map(timers.map((timer) => [timer.name, timer.everyS / 2]));
let nextObsAt = Date.now();
let nextSearchAt = Date.now() + searchIntervalMs / 2;
let lastReport = Date.now();

while (elapsedDayS() < DAY_S) {
  await rollSession();
  const now = Date.now();
  while (nextObsAt <= now) {
    seq++;
    track(post("observe", "/agentmemory/observe", observation(sessionId, seq)));
    if (seq % 10 === 0) {
      track(post("observe (prompt)", "/agentmemory/observe", {
        hookType: "prompt_submit", sessionId, project, cwd: `/work/${project}`,
        timestamp: new Date().toISOString(), eventId: `${sessionId}-p${seq}`, data: { prompt: phrase(12) },
      }));
    }
    nextObsAt += obsIntervalMs;
  }
  while (nextSearchAt <= now) {
    const query = phrase(3);
    const kind = Math.floor(Math.random() * 3);
    if (kind === 0) track(post("smart-search", "/agentmemory/smart-search", { query, limit: 10, project }));
    else if (kind === 1) track(post("search", "/agentmemory/search", { query, limit: 10 }));
    else track(post("context", "/agentmemory/context", { sessionId, project }));
    nextSearchAt += searchIntervalMs;
  }
  for (const timer of timers) {
    if (elapsedDayS() < nextTimerAt.get(timer.name)!) continue;
    nextTimerAt.set(timer.name, nextTimerAt.get(timer.name)! + timer.everyS);
    if (timer.rest) track(post(timer.name, timer.rest.path, timer.rest.body));
    else track(triggerInContainer(timer.name, timer.fn!));
  }
  if (inFlight.size > 64) await Promise.race(inFlight);
  if (Date.now() - lastReport > 30_000) {
    lastReport = Date.now();
    console.log(`replay: day ${(elapsedDayS() / 3600).toFixed(1)}h, session ${sessionIndex}, in flight ${inFlight.size}`);
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(nextObsAt, nextSearchAt) - Date.now())));
}

await post("session/end", "/agentmemory/session/end", { sessionId });
await Promise.allSettled(inFlight);
console.log(`replay: done in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
for (const [name, { ok, failed, firstError }] of [...counts].sort()) {
  console.log(`  ${name.padEnd(32)} ok=${ok} failed=${failed}${firstError ? ` first error: ${firstError}` : ""}`);
}
console.log("The server writes scope-guard-inventory.json to its data dir every 30 s; wait 30 s, then read it.");

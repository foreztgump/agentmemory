// Replays hook-shaped capture load against a running agentmemory and reports observe and
// session/start latency. With --verify it then waits for the capture inbox to drain and checks
// that every acknowledged event is stored exactly once. A capture that fails (connection error,
// timeout, 5xx) is resent with the same eventId until it is acknowledged, as the hook spool does,
// so the run survives a kill -9 of the server and the check covers it.
//
//   AGENTMEMORY_SECRET=... node --import tsx bench/fork/capture-replay.ts \
//     --url http://agentmemory:3111 --sessions 40 --captures 4000 --concurrency 16 --burst 3 --verify \
//     --max-observe-p99-ms 100 --max-session-start-p99-ms 300
// Exits 1 when a ceiling is exceeded or the exactly-once check fails.
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { captureKey } from "../../src/functions/capture.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://agentmemory:3111" },
    sessions: { type: "string", default: "40" },
    captures: { type: "string", default: "4000" },
    concurrency: { type: "string", default: "16" },
    burst: { type: "string", default: "3" },
    run: { type: "string", default: Date.now().toString(36) },
    "output-bytes": { type: "string", default: "1500" },
    "timeout-ms": { type: "string", default: "3000" },
    "session-inject": { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    "drain-timeout-s": { type: "string", default: "900" },
    out: { type: "string" },
    "max-observe-p99-ms": { type: "string" },
    "max-session-start-p99-ms": { type: "string" },
  },
});

const base = values.url!.replace(/\/$/, "");
const secret = process.env["AGENTMEMORY_SECRET"];
const headers = { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
const sessions = Number(values.sessions);
const total = Number(values.captures);
const concurrency = Number(values.concurrency);
const burst = Math.max(1, Number(values.burst));
const outputBytes = Number(values["output-bytes"]);
const timeoutMs = Number(values["timeout-ms"]);
const run = values.run!;
const project = "bench-replay";
const sessionIds = Array.from({ length: sessions }, (_, i) => `ses_replay_${run}_${i}`);

type Sample = { ms: number; status: number };
const observe: Sample[] = [];
const sessionStart: Sample[] = [];
const statuses = new Map<string, number>();
const acked = new Map<string, string>();
let resends = 0;

async function post(path: string, body: unknown): Promise<Sample & { text: string }> {
  const started = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    return { ms: performance.now() - started, status: res.status, text };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ms: performance.now() - started, status: name === "TimeoutError" ? -1 : 0, text: "" };
  }
}

function note(kind: string) {
  statuses.set(kind, (statuses.get(kind) ?? 0) + 1);
}

function captureBody(sessionId: string, n: number) {
  const tool = ["Read", "Bash", "Edit", "Grep"][n % 4]!;
  return {
    hookType: "post_tool_use",
    sessionId,
    project,
    cwd: `/work/${project}`,
    timestamp: new Date().toISOString(),
    eventId: `evr_${run}_${n.toString().padStart(7, "0")}`,
    data: {
      tool_name: tool,
      tool_input: { file_path: `src/mod${n % 97}/f${n}.ts`, command: `echo ${n}` },
      tool_output: `result ${n} `.padEnd(outputBytes, "x"),
    },
  };
}

async function deliver(sessionId: string, n: number): Promise<void> {
  const body = captureBody(sessionId, n);
  for (let attempt = 0; ; attempt++) {
    const r = await post("/agentmemory/observe", body);
    observe.push({ ms: r.ms, status: r.status });
    note(`observe ${r.status}`);
    if (r.status >= 200 && r.status < 300) {
      acked.set(body.eventId, sessionId);
      return;
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return;
    resends++;
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 250 * 2 ** Math.min(attempt, 4))));
  }
}

async function startSession(sessionId: string): Promise<void> {
  const r = await post("/agentmemory/session/start", {
    sessionId,
    project,
    cwd: `/work/${project}`,
    ...(values["session-inject"] ? {} : { injectContext: false }),
  });
  sessionStart.push({ ms: r.ms, status: r.status });
  note(`session/start ${r.status}`);
}

function quantiles(samples: Sample[]) {
  const ms = samples.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms).sort((a, b) => a - b);
  const q = (p: number) => (ms.length ? Number(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]!.toFixed(1)) : null);
  return { ok: ms.length, all: samples.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: ms.length ? Number(ms.at(-1)!.toFixed(1)) : null };
}

const started = performance.now();
let next = 0;
let startedSessions = 0;
async function lane(): Promise<void> {
  for (;;) {
    const first = next;
    if (first >= total) return;
    const size = Math.min(burst, total - first);
    next += size;
    const s = Math.floor(first / burst) % sessions;
    if (s >= startedSessions && first / burst < sessions) {
      startedSessions = s + 1;
      await startSession(sessionIds[s]!);
    }
    await Promise.all(Array.from({ length: size }, (_, i) => deliver(sessionIds[s]!, first + i)));
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.floor(concurrency / burst)) }, lane));
const loadSeconds = (performance.now() - started) / 1000;

const report: Record<string, unknown> = {
  run,
  sessions,
  captures: total,
  concurrency,
  burst,
  loadSeconds: Number(loadSeconds.toFixed(1)),
  throughputPerS: Number((observe.length / loadSeconds).toFixed(1)),
  resends,
  observe: quantiles(observe),
  sessionStart: quantiles(sessionStart),
  statuses: Object.fromEntries(statuses),
};

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

if (values.verify) {
  const deadline = Date.now() + Number(values["drain-timeout-s"]) * 1000;
  const drainStarted = performance.now();
  let inbox: { pending?: number; retrying?: number; dead?: number } | null = null;
  for (;;) {
    inbox = ((await get("/agentmemory/capture?limit=1").catch(() => null)) as { capture?: { inbox?: typeof inbox } } | null)?.capture?.inbox ?? null;
    if (inbox && (inbox.pending ?? 0) + (inbox.retrying ?? 0) === 0) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const expected = new Map<string, string>();
  for (const [eventId, sessionId] of acked) expected.set(captureKey(project, sessionId, eventId), eventId);
  const seen = new Map<string, number>();
  let rows = 0;
  for (const sessionId of sessionIds) {
    const body = (await get(`/agentmemory/observations?sessionId=${encodeURIComponent(sessionId)}`)) as {
      observations: Array<{ captureKey?: string }>;
    };
    for (const row of body.observations) {
      rows++;
      if (row.captureKey) seen.set(row.captureKey, (seen.get(row.captureKey) ?? 0) + 1);
    }
  }
  const missing = [...expected.keys()].filter((key) => !seen.has(key));
  const duplicates = [...seen.values()].filter((count) => count > 1).length;
  const unexpected = [...seen.keys()].filter((key) => !expected.has(key)).length;
  report["verify"] = {
    drainSeconds: Number(((performance.now() - drainStarted) / 1000).toFixed(1)),
    inbox,
    acked: acked.size,
    rows,
    missing: missing.length,
    duplicates,
    unexpected,
    exactlyOnce: missing.length === 0 && duplicates === 0 && rows === acked.size,
    missingSample: missing.slice(0, 5).map((key) => expected.get(key)),
  };
}

const failures: string[] = [];
const ceiling = (name: string, limit: string | undefined, actual: number | null) => {
  if (limit !== undefined && (actual === null || actual > Number(limit))) failures.push(`${name} p99 ${actual} ms > ${limit} ms`);
};
ceiling("observe", values["max-observe-p99-ms"], (report["observe"] as { p99: number | null }).p99);
ceiling("session/start", values["max-session-start-p99-ms"], (report["sessionStart"] as { p99: number | null }).p99);
if (values.verify && !(report["verify"] as { exactlyOnce: boolean }).exactlyOnce) failures.push("not every acknowledged capture is stored exactly once");
report["failures"] = failures;

const text = JSON.stringify(report, null, 2);
console.log(text);
if (values.out) writeFileSync(values.out, text + "\n");
if (failures.length > 0) process.exit(1);

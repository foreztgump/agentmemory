// Capture throughput over REST, as hooks deliver events: POST /agentmemory/observe
// with the profile's hook-type mix and payload sizes, then wait until every event
// is stored as an observation (counted in Valkey). Reports end-to-end obs/s.
// Runs on the replica network (replica.sh client).
//
//   node --import tsx bench/fork/capture.ts --profile <file> [--count 2000] [--concurrency 8]
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { parseArgs } from "node:util";
import { mulberry32, pickWeighted, sampleQuantile } from "./lib/stats.js";
import { Corpus, type Profile } from "./lib/synthetic.js";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    count: { type: "string", default: "2000" },
    concurrency: { type: "string", default: "8" },
    sessions: { type: "string", default: "20" },
    url: { type: "string", default: "http://agentmemory:3111" },
    valkey: { type: "string", default: "valkey" },
    secret: { type: "string", default: "replica-dummy-secret" },
    "timeout-s": { type: "string", default: "900" },
  },
});
if (!args.profile) throw new Error("--profile is required");
const profile = JSON.parse(readFileSync(args.profile, "utf8")) as Profile;
const count = Number(args.count);
const rand = mulberry32(42);
const corpus = new Corpus(20_000);
const runId = Date.now().toString(36);
const sessions = Array.from({ length: Number(args.sessions) }, (_, i) => `ses_bench_${runId}_${i}`);
const hookWeights = Object.fromEntries(Object.entries(profile.hookTypes).map(([k, v]) => [k, v.count]));

function event(i: number) {
  const hookType = pickWeighted(hookWeights, rand());
  const size = Math.max(40, Math.round(sampleQuantile(profile.hookTypes[hookType].originalBytes, rand())));
  const text = `bench event ${runId} ${i} ${corpus.text(size, rand)}`;
  let data: Record<string, unknown> = { text };
  if (hookType === "post_tool_use" || hookType === "post_tool_failure") {
    data = { tool_name: "Bash", tool_input: { command: `echo ${i}` }, tool_output: text };
  } else if (hookType === "prompt_submit") {
    data = { prompt: text };
  }
  return {
    hookType,
    sessionId: sessions[i % sessions.length],
    project: "capture-bench",
    cwd: "/work/capture-bench",
    timestamp: new Date().toISOString(),
    eventId: `bench-${runId}-${i}`,
    data,
  };
}

function valkey(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(6379, args.valkey!, () => socket.write(`${command}\r\n`));
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      if (buf.endsWith("\r\n")) { socket.end(); resolve(buf); }
    });
    socket.on("error", reject);
  });
}

async function stored(): Promise<number> {
  let n = 0;
  for (const s of sessions) n += Number((await valkey(`HLEN state:mem:obs:${s}`)).slice(1));
  return n;
}

const statuses: Record<string, number> = {};
let next = 0;
const started = performance.now();
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < count) {
    const i = next++;
    try {
      const res = await fetch(`${args.url}/agentmemory/observe`, {
        method: "POST",
        headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
        body: JSON.stringify(event(i)),
        signal: AbortSignal.timeout(60_000),
      });
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      await res.arrayBuffer();
    } catch {
      statuses.error = (statuses.error ?? 0) + 1;
    }
  }
}));
const acceptedS = (performance.now() - started) / 1000;

const deadline = performance.now() + Number(args["timeout-s"]) * 1000;
let n = await stored();
while (n < count && performance.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  n = await stored();
}
const storedS = (performance.now() - started) / 1000;
console.log(JSON.stringify({
  events: count,
  statuses,
  acceptedPerSecond: Math.round((count / acceptedS) * 10) / 10,
  stored: n,
  storedPerSecond: n >= count ? Math.round((count / storedS) * 10) / 10 : 0,
  seconds: Math.round(storedS * 10) / 10,
}));

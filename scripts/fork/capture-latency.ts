// Measures REST capture latency into one session that is pre-filled near MAX_OBS_PER_SESSION.
// AGENTMEMORY_SECRET=local-replay-secret npx tsx scripts/fork/capture-latency.ts \
//   --url http://127.0.0.1:31111 --session ses_bench --prefill 4900 --samples 200
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:31111" },
    session: { type: "string", default: `ses_bench_${Date.now().toString(36)}` },
    prefill: { type: "string", default: "0" },
    samples: { type: "string", default: "100" },
    concurrency: { type: "string", default: "8" },
    "output-bytes": { type: "string", default: "1500" },
  },
});

const base = values.url!.replace(/\/$/, "");
const sessionId = values.session!;
const secret = process.env["AGENTMEMORY_SECRET"];
const outputBytes = Number(values["output-bytes"]);
const run = Date.now().toString(36);
let seq = 0;

async function capture(): Promise<{ ms: number; status: number; body: string }> {
  const n = seq++;
  const started = performance.now();
  const response = await fetch(`${base}/agentmemory/observe`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({
      hookType: "post_tool_use",
      sessionId,
      project: "bench",
      cwd: "/work/bench",
      timestamp: new Date().toISOString(),
      eventId: `${sessionId}-${run}-${n}`,
      data: { tool_name: "Read", tool_input: { file_path: `src/f${n}.ts` }, tool_output: `line ${n} `.padEnd(outputBytes, "x") },
    }),
  });
  const body = await response.text();
  return { ms: performance.now() - started, status: response.status, body };
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const prefill = Number(values.prefill);
const prefillStarted = performance.now();
for (let done = 0; done < prefill; ) {
  const batch = Math.min(Number(values.concurrency), prefill - done);
  await Promise.all(Array.from({ length: batch }, capture));
  done += batch;
}
const prefillS = (performance.now() - prefillStarted) / 1000;

const latencies: number[] = [];
const outcomes = new Map<string, number>();
for (let i = 0; i < Number(values.samples); i++) {
  const { ms, status, body } = await capture();
  latencies.push(ms);
  const kind = `${status} ${/limit reached/.test(body) ? "cap-refused" : status === 201 ? "stored" : body.slice(0, 80)}`;
  outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
}
latencies.sort((a, b) => a - b);
console.log(JSON.stringify({
  sessionId,
  prefill,
  prefillSeconds: Number(prefillS.toFixed(1)),
  samples: latencies.length,
  p50ms: Number(quantile(latencies, 0.5).toFixed(1)),
  p95ms: Number(quantile(latencies, 0.95).toFixed(1)),
  maxms: Number(latencies.at(-1)!.toFixed(1)),
  outcomes: Object.fromEntries(outcomes),
}));

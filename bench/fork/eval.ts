// Recall eval: runs each case's query through smart search and scores the
// returned ids against the expected ids. Deterministic: fixed case order, one
// query at a time, no LLM. Runs on the replica network (replica.sh client).
//
//   node --import tsx bench/fork/eval.ts --cases <file> [--cases <file>] [--url URL] [--details]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { aggregate, K, latencySummary, scoreCase, type EvalCase } from "./lib/score.js";

const { values: args } = parseArgs({
  options: {
    cases: { type: "string", multiple: true },
    url: { type: "string", default: "http://agentmemory:3111" },
    secret: { type: "string", default: "replica-dummy-secret" },
    details: { type: "boolean", default: false },
  },
});
if (!args.cases?.length) throw new Error("--cases is required");

const suites = args.cases.map((file) => ({ file, cases: (JSON.parse(readFileSync(file, "utf8")) as { cases: EvalCase[] }).cases }));

async function search(query: string): Promise<string[]> {
  const res = await fetch(`${args.url}/agentmemory/smart-search`, {
    method: "POST",
    headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ query, limit: K }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`smart-search ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { results?: { obsId: string }[] };
  return (body.results ?? []).map((r) => r.obsId);
}

const report: Record<string, unknown> = {};
for (const suite of suites) {
  const latencies: number[] = [];
  const results = [];
  for (const c of suite.cases) {
    const started = performance.now();
    const ids = await search(c.query);
    latencies.push(performance.now() - started);
    results.push(scoreCase(c, ids));
  }
  report[suite.file] = {
    scores: aggregate(results),
    latencyMs: latencySummary(latencies),
    ...(args.details ? { results } : {}),
  };
}
console.log(JSON.stringify(report, null, 2));

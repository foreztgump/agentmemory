// Keyword latency of the engine against Qdrant's own sparse query on the same
// collection, interleaved so host load hits both alike. Exits 1 when the
// engine costs more than its budget over the raw query.
//
//   node --import tsx bench/fork/qdrant/keyword-latency.ts --cases <cases.json> [--qdrant http://127.0.0.1:16344] [--collection parity_200000]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { querySparse } from "../../../src/fork/worker/bm25-sparse.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";

const { values: args } = parseArgs({
  options: {
    cases: { type: "string" },
    qdrant: { type: "string", default: "http://127.0.0.1:16344" },
    key: { type: "string", default: "" },
    collection: { type: "string", default: "parity_200000" },
    rounds: { type: "string", default: "3" },
    // Budget over the raw query: p50 may add this many ms, p99 may be this many times the raw p99.
    "p50-extra-ms": { type: "string", default: "3" },
    "p99-ratio": { type: "string", default: "2" },
  },
});
if (!args.cases) throw new Error("--cases is required");
const queries = (JSON.parse(readFileSync(args.cases, "utf8")) as { cases: Array<{ query: string }> }).cases.map((c) => c.query);
const qdrant = new Qdrant({ url: args.qdrant!, apiKey: args.key || undefined, collection: args.collection!, dimensions: 16, oversampling: 6, timeoutMs: 60_000 });
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
await engine.keyword(queries[0]!, 10, "all");
await engine.settled();
if (!engine.prefixes?.isReady) throw new Error("the prefix vocabulary did not fill");

async function raw(query: string, limit: number): Promise<void> {
  const prefixes = engine.prefixes!;
  await qdrant.call("POST", `${qdrant.path}/points/query`, {
    query: querySparse(query, (terms) => prefixes.expand(terms)), using: "bm25", limit,
    filter: { must_not: [{ key: "deleted", match: { value: true } }] }, with_payload: ["doc_id", "session_id"],
  });
}

const timings: Record<string, number[]> = {};
const time = async (label: string, run: () => Promise<unknown>) => {
  const started = performance.now();
  await run();
  (timings[label] ??= []).push(performance.now() - started);
};
for (let r = 0; r < Number(args.rounds); r++) {
  for (const q of queries) {
    for (const limit of [10, 40]) {
      await time(`raw@${limit}`, () => raw(q, limit));
      await time(`engine@${limit}`, () => engine.keyword(q, limit, "all"));
    }
  }
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const summary = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { n: v.length, p50: +pct(v, 0.5).toFixed(2), p95: +pct(v, 0.95).toFixed(2), p99: +pct(v, 0.99).toFixed(2) }]));
const failures: string[] = [];
for (const limit of [10, 40]) {
  const r = summary[`raw@${limit}`]!, e = summary[`engine@${limit}`]!;
  if (e.p50 > r.p50 + Number(args["p50-extra-ms"])) failures.push(`limit ${limit}: p50 ${e.p50} ms > raw ${r.p50} + ${args["p50-extra-ms"]}`);
  if (e.p99 > r.p99 * Number(args["p99-ratio"])) failures.push(`limit ${limit}: p99 ${e.p99} ms > ${args["p99-ratio"]} x raw ${r.p99}`);
}
console.log(JSON.stringify({ summary, failures }, null, 1));
if (failures.length > 0) process.exit(1);

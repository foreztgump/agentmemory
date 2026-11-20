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
    key: { type: "string", default: process.env.AM_QDRANT_API_KEY ?? "" },
    collection: { type: "string", default: "parity_200000" },
    rounds: { type: "string", default: "3" },
    // Budget over the raw query: p50 may add this many ms, p99 may be this many times the raw p99.
    "p50-extra-ms": { type: "string", default: "3" },
    "p99-ratio": { type: "string", default: "2" },
  },
});
if (!args.cases) throw new Error("--cases is required");
const queries = (JSON.parse(readFileSync(args.cases, "utf8")) as { cases: Array<{ query: string }> }).cases.map((c) => c.query);
const rounds = Number(args.rounds), p50Extra = Number(args["p50-extra-ms"]), p99Ratio = Number(args["p99-ratio"]);
if (queries.length === 0) throw new Error("--cases holds no queries");
if (!(Number.isInteger(rounds) && rounds > 0) || !(Number.isFinite(p50Extra) && p50Extra >= 0) || !(Number.isFinite(p99Ratio) && p99Ratio > 0)) throw new Error("--rounds must be a positive whole number, --p50-extra-ms a finite number at least 0, --p99-ratio a finite number above 0");
const qdrant = new Qdrant({ url: args.qdrant!, apiKey: args.key || undefined, collection: args.collection!, dimensions: 16, oversampling: 6, timeoutMs: 60_000 });
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
await engine.keyword(queries[0]!, 10, "all");
await engine.settled();
if (!engine.prefixes?.isReady) throw new Error("the prefix vocabulary did not fill");

// The raw query uses the capped prefix expansion, cheaper than the engine's complete one, so the budget errs strict.
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
for (let r = 0; r < rounds; r++) {
  for (const q of queries) {
    for (const limit of [10, 40]) {
      await time(`raw@${limit}`, () => raw(q, limit));
      await time(`engine@${limit}`, () => engine.keyword(q, limit, "all"));
    }
  }
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const round = (x: number) => +x.toFixed(2);
const summary = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { n: v.length, p50: round(pct(v, 0.5)), p95: round(pct(v, 0.95)), p99: round(pct(v, 0.99)) }]));
const failures: string[] = [];
for (const limit of [10, 40]) {
  const r = timings[`raw@${limit}`]!, e = timings[`engine@${limit}`]!;
  const [rp50, ep50, rp99, ep99] = [pct(r, 0.5), pct(e, 0.5), pct(r, 0.99), pct(e, 0.99)];
  if (ep50 > rp50 + p50Extra) failures.push(`limit ${limit}: p50 ${round(ep50)} ms > raw ${round(rp50)} + ${p50Extra}`);
  if (ep99 > rp99 * p99Ratio) failures.push(`limit ${limit}: p99 ${round(ep99)} ms > ${p99Ratio} x raw ${round(rp99)}`);
}
console.log(JSON.stringify({ summary, failures }, null, 1));
if (failures.length > 0) process.exit(1);

// Where a disk keyword search spends its time: per query, the Qdrant calls it makes (by kind), their latency,
// and the size of each query term's complete prefix expansion. Runs against a filled collection (score-parity's).
// Ids and numbers only.
//
//   node --import tsx bench/fork/qdrant/keyword-anatomy.ts [--qdrant http://127.0.0.1:16413] [--collection parity_200000] [--count 200000]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { queryTerms } from "../../../src/state/term-extraction.js";
import { Generator } from "../lib/synthetic.js";

const { values: args } = parseArgs({
  options: {
    qdrant: { type: "string", default: "http://127.0.0.1:16413" },
    collection: { type: "string", default: "parity_200000" },
    count: { type: "string", default: "200000" },
    queries: { type: "string", default: "300" },
    k: { type: "string", default: "10" },
  },
});
const profile = JSON.parse(readFileSync(new URL("../profiles/buddy-2026-11-16.json", import.meta.url), "utf8"));
const qdrant = new Qdrant({ url: args.qdrant!, collection: args.collection!, dimensions: 16, oversampling: 6, timeoutMs: 120_000 });
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
const calls: Array<{ kind: string; ms: number }> = [];
const call = qdrant.call.bind(qdrant);
qdrant.call = (async (method: string, path: string, body?: unknown) => {
  const t0 = performance.now();
  try {
    return await call(method, path, body);
  } finally {
    const b = body as { limit?: number; with_payload?: unknown; ids?: unknown[]; searches?: unknown[] } | undefined;
    let kind = path;
    if (path.endsWith("/points/query/batch")) kind = `batch${b?.searches?.length ?? 0}`;
    else if (path.endsWith("/points/query")) kind = `${b?.with_payload === false ? "ids" : "shallow"}@${b?.limit}`;
    else if (path.endsWith("/points")) kind = `payload${b?.ids?.length ?? 0}`;
    calls.push({ kind, ms: performance.now() - t0 });
  }
}) as typeof qdrant.call;

const COUNT = Number(args.count), N = Number(args.queries), K = Number(args.k);
function queries(seed: number, truncate: boolean): string[] {
  const gen = new Generator(profile, COUNT, seed);
  const cut = (w: string) => (truncate ? w.slice(0, Math.max(3, Math.ceil(w.length * 0.6))) : w);
  return Array.from({ length: N }, () => `${cut(gen.word())} ${cut(gen.word())}`);
}
await engine.keyword("warmup", K, "all");
await engine.settled();
if (!engine.prefixes?.isReady) throw new Error("the prefix vocabulary did not fill");
const vocabulary = engine.prefixes as unknown as { completePrefixes(term: string): string[] | null };
const pct = (xs: number[], p: number) => +([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? NaN).toFixed(1);

for (const [label, qs] of [["capture", queries(9001, false)], ["capture-prefix", queries(9101, true)]] as const) {
  const total: number[] = [];
  const deep: number[] = [];
  const kinds = new Map<string, number[]>();
  const expansion: number[] = [];
  let uncapped = 0;
  const slow: unknown[] = [];
  for (const q of qs) {
    calls.length = 0;
    const t0 = performance.now();
    await engine.keyword(q, K, "all");
    const ms = performance.now() - t0;
    total.push(ms);
    if (calls.length > 1) deep.push(ms);
    for (const c of calls) {
      const key = c.kind.replace(/\d+$/, "");
      const bucket = kinds.get(key) ?? [];
      bucket.push(c.ms);
      kinds.set(key, bucket);
    }
    const sizes = queryTerms(q).map(({ term }) => vocabulary.completePrefixes(term)?.length ?? null);
    for (const size of sizes) if (size === null) uncapped++; else expansion.push(size);
    if (ms > 20) slow.push({ ms: +ms.toFixed(1), sizes, calls: calls.map((c) => `${c.kind}:${c.ms.toFixed(1)}`) });
  }
  console.log(JSON.stringify({
    label, n: total.length, p50: pct(total, 0.5), p95: pct(total, 0.95), p99: pct(total, 0.99), deepShare: +(deep.length / total.length).toFixed(3),
    deepP50: pct(deep, 0.5),
    calls: Object.fromEntries([...kinds].map(([k, v]) => [k, { n: v.length, p50: pct(v, 0.5), p99: pct(v, 0.99) }])),
    expansion: { p50: pct(expansion, 0.5), p90: pct(expansion, 0.9), p99: pct(expansion, 0.99), max: Math.max(...expansion), pastCompleteMax: uncapped },
    slow: slow.slice(0, 12),
  }));
}

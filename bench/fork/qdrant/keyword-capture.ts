// Keyword search latency under capture writes (TEE-1164's perf bench, TEE-1195's ceiling).
// Loads --count synthetic documents through SearchEngine.apply into a fresh collection, fills the
// prefix vocabulary, then runs each phase twice for --seconds while it measures keyword(q, 10):
//   idle            no writes
//   capture         10 documents a second, as capture hooks write them
//   capture-prefix  the same, with every query word cut to 60% of its length
//   import          256-document batches back to back
// Exits 1 when, in either run, the capture phase's p99 passes --ceiling-p99-ms or the capture-prefix phase's passes
// --ceiling-prefix-p99-ms; idle and import are reported, not gated.
//
//   node --import tsx bench/fork/qdrant/keyword-capture.ts --qdrant http://127.0.0.1:16345 [--count 200000] [--seconds 60] [--ceiling-p99-ms 20] [--ceiling-prefix-p99-ms 60]
//
// Measured 2026-11-28 at 200,000 documents, Qdrant 1.20.2 with a 1 GB limit (TEE-1213): capture p99 10.6-12.2 ms,
// capture-prefix p99 26.7-40.8 ms. The prefix tail is two-letter stems whose ~1,700 completions the exact re-score reads.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { docOp, type DocOp } from "../../../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import type { CompressedObservation } from "../../../src/types.js";
import { Generator } from "../lib/synthetic.js";

const { values: args } = parseArgs({
  options: {
    qdrant: { type: "string", default: "http://127.0.0.1:16345" },
    key: { type: "string", default: process.env.AM_QDRANT_API_KEY ?? "" },
    collection: { type: "string", default: "keyword_capture" },
    count: { type: "string", default: "200000" },
    seconds: { type: "string", default: "60" },
    phases: { type: "string", default: "idle,capture,capture-prefix,import" },
    "ceiling-p99-ms": { type: "string", default: "20" },
    "ceiling-prefix-p99-ms": { type: "string", default: "60" },
  },
});
const COUNT = Number(args.count), SECONDS = Number(args.seconds), CEILING = Number(args["ceiling-p99-ms"]), PREFIX_CEILING = Number(args["ceiling-prefix-p99-ms"]);
const PHASES = ["idle", "capture", "capture-prefix", "import"];
const phases = new Set(args.phases!.split(","));
const unknown = [...phases].filter((p) => !PHASES.includes(p));
if (unknown.length > 0) throw new Error(`--phases takes ${PHASES.join(",")}; got ${unknown.join(",")}`);
if (!(Number.isInteger(COUNT) && COUNT >= 1000) || !(Number.isFinite(SECONDS) && SECONDS > 0) || !(Number.isFinite(CEILING) && CEILING > 0) || !(Number.isFinite(PREFIX_CEILING) && PREFIX_CEILING > 0)) {
  throw new Error("--count must be a whole number of at least 1000, --seconds, --ceiling-p99-ms and --ceiling-prefix-p99-ms finite numbers above 0");
}
const profile = JSON.parse(readFileSync(new URL("../profiles/buddy-2026-11-16.json", import.meta.url), "utf8"));
const qdrant = new Qdrant({ url: args.qdrant!, apiKey: args.key || undefined, collection: args.collection!, dimensions: 1024, oversampling: 6, timeoutMs: 120_000 });
const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

function docs(seed: number, count: number): DocOp[] {
  const gen = new Generator(profile, COUNT, seed);
  const out: DocOp[] = [];
  for (let s = 0; out.length < count; s++) {
    const session = gen.session(s);
    const size = Math.min(gen.sessionSize(), count - out.length);
    for (let i = 0; i < size; i++) out.push(docOp(gen.observation(session, i * 30_000) as unknown as CompressedObservation, "observation"));
  }
  return out;
}
async function apply(batch: DocOp[]): Promise<void> {
  const r = await engine.apply(batch);
  if (r.failed.length > 0 || r.applied !== batch.length) throw new Error(`apply: ${JSON.stringify(r).slice(0, 300)}`);
}
function queries(seed: number, truncate = false): string[] {
  const gen = new Generator(profile, COUNT, seed);
  const cut = (w: string) => (truncate ? w.slice(0, Math.max(3, Math.ceil(w.length * 0.6))) : w);
  return Array.from({ length: 100_000 }, () => `${cut(gen.word())} ${cut(gen.word())}`);
}
async function settle(): Promise<void> {
  await engine.settled();
  for (;;) {
    const info = await qdrant.call<{ status: string; optimizer_status: unknown }>("GET", qdrant.path);
    if (info.status === "green" && info.optimizer_status === "ok") return;
    await sleep(500);
  }
}
const pct = (xs: number[], p: number) => +[...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!.toFixed(1);

async function phase(name: string, run: number, qs: string[], writer?: (stop: { v: boolean }) => Promise<void>): Promise<number> {
  await settle();
  const stop = { v: false };
  const writing = writer?.(stop) ?? Promise.resolve();
  if (writer) await sleep(2000);
  const latency: number[] = [];
  const started = performance.now();
  try {
    for (let i = 0; latency.length < 500 || performance.now() - started < SECONDS * 1000; i++) {
      const t0 = performance.now();
      await engine.keyword(qs[i % qs.length]!, 10, "all");
      latency.push(performance.now() - t0);
    }
  } finally {
    stop.v = true;
    await writing;
  }
  const p99 = pct(latency, 0.99);
  log({ phase: name, run, searches: latency.length, p50: pct(latency, 0.5), p95: pct(latency, 0.95), p99, max: pct(latency, 1) });
  return p99;
}
const trickle = (batch: DocOp[]) => async (stop: { v: boolean }) => {
  for (let i = 0; !stop.v; i += 10) {
    const t0 = performance.now();
    await apply(batch.slice(i % batch.length, (i % batch.length) + 10));
    await sleep(Math.max(0, 1000 - (performance.now() - t0)));
  }
};

await qdrant.drop();
const corpus = docs(1156, COUNT);
const loadStarted = performance.now();
for (let i = 0; i < corpus.length; i += 256) await apply(corpus.slice(i, i + 256));
log({ phase: "load", docs: corpus.length, s: Math.round((performance.now() - loadStarted) / 1000) });
engine.prefixes!.fillInBackground();
await settle();
if (!engine.prefixes!.isReady) throw new Error("the prefix vocabulary did not fill; the run would measure search without prefix expansion");
log({ phase: "prefix-vocabulary", terms: engine.prefixes!.size, ready: engine.prefixes!.isReady });
for (const q of queries(555).slice(0, 100)) await engine.keyword(q, 10, "all");

const failures: string[] = [];
const tail = corpus.slice(-20_000);
for (const run of [1, 2]) {
  const qs = queries(9000 + run);
  if (phases.has("idle")) await phase("idle", run, qs);
  if (phases.has("capture")) {
    const p99 = await phase("capture", run, qs, trickle(docs(7000 + run, 20_000)));
    if (p99 > CEILING) failures.push(`capture run ${run}: p99 ${p99} ms above the ceiling ${CEILING} ms`);
  }
  if (phases.has("capture-prefix")) {
    const p99 = await phase("capture-prefix", run, queries(9100 + run, true), trickle(docs(7100 + run, 20_000)));
    if (p99 > PREFIX_CEILING) failures.push(`capture-prefix run ${run}: p99 ${p99} ms above the ceiling ${PREFIX_CEILING} ms`);
  }
  if (phases.has("import")) {
    await phase("import", run, qs, async (stop) => {
      for (let i = 0; !stop.v; i = (i + 256) % (tail.length - 256)) await apply(tail.slice(i, i + 256));
    });
  }
}
await engine.settled();
await qdrant.drop();
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);

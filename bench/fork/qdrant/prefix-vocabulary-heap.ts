// Heap the am-search prefix vocabulary holds at its term bound, checked against a ceiling.
//   node --expose-gc --import tsx bench/fork/qdrant/prefix-vocabulary-heap.ts [--offer 2000000] [--ceiling-mib 78]
// It offers more distinct terms than the bound, so the run also proves the bound holds.
// Measured 2026-11-19: 67.5 MiB at the 1,000,000-term bound with these 12-14 character terms (71 B per term); the ceiling is that +15%.
// The 200k-doc synthetic corpus (153,742 terms) took 13.6 MiB.
import { parseArgs } from "node:util";
import { DEFAULT_VOCABULARY_LIMITS, PrefixVocabulary } from "../../../src/fork/worker/prefix-vocabulary.js";
import type { Qdrant } from "../../../src/fork/worker/qdrant.js";

const { values } = parseArgs({ options: { offer: { type: "string", default: "2000000" }, "ceiling-mib": { type: "string", default: "78" } } });
const offer = Number(values.offer);
const ceilingMiB = Number(values["ceiling-mib"]);
if (!Number.isInteger(offer) || offer <= 0 || !(ceilingMiB > 0)) throw new Error("--offer must be a positive integer and --ceiling-mib a positive number");
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc");

const emptyCollection = { path: "/collections/heap", call: async () => ({ points: [], next_page_offset: null }) } as unknown as Qdrant;
gc();
const before = process.memoryUsage().heapUsed;
const vocabulary = new PrefixVocabulary(emptyCollection, async () => {});
vocabulary.fillInBackground();
await vocabulary.settled();
const started = performance.now();
let slowestDocMs = 0;
for (let i = 0; i < offer; i += 40) {
  const terms = Array.from({ length: Math.min(40, offer - i) }, (_, j) => `t${(i + j).toString(36)}_${((i + j) * 7919).toString(36)}`);
  const docStart = performance.now();
  vocabulary.observe(terms);
  slowestDocMs = Math.max(slowestDocMs, performance.now() - docStart);
}
const observeMs = performance.now() - started;
gc();
const heapMiB = (process.memoryUsage().heapUsed - before) / 2 ** 20;
const maxTerms = DEFAULT_VOCABULARY_LIMITS.maxTerms;
const result = { offered: offer, terms: vocabulary.size, maxTerms, refused: vocabulary.refusals, heapMiB: +heapMiB.toFixed(1), ceilingMiB, bytesPerTerm: Math.round((heapMiB * 2 ** 20) / vocabulary.size), observeMs: Math.round(observeMs), slowestDocMs: +slowestDocMs.toFixed(1) };
console.log(JSON.stringify(result));
const failures = [
  ...(vocabulary.size > maxTerms ? [`terms ${vocabulary.size} above the bound ${maxTerms}`] : []),
  ...(heapMiB > ceilingMiB ? [`heap ${heapMiB.toFixed(1)} MiB above the ceiling ${ceilingMiB} MiB`] : []),
];
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);

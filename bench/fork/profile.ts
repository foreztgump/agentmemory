// Measures the shape of a replica's observations without reading content out:
// type mix, size and length distributions, list-field counts, vocabulary size.
// Output is counts and quantiles only, safe to commit.
//
//   node --import tsx bench/fork/profile.ts --container <valkey container> [--out file.json]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { histogram, quantiles } from "./lib/stats.js";
import { ALL_OBSERVATIONS, valueLines } from "./lib/valkey.js";

const { values: args } = parseArgs({
  options: { container: { type: "string" }, out: { type: "string" } },
});
if (!args.container) throw new Error("--container is required");

const SIZE_EDGES = [0, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536];

const TOKEN = /[\p{L}\p{N}]{2,}/gu;

const types: Record<string, number> = {};
const jsonBytes: number[] = [];
const titleLen: number[] = [];
const narrativeLen: number[] = [];
const termsPerDoc: number[] = [];
const facts: number[] = [];
const concepts: number[] = [];
const files: number[] = [];
const factLen: number[] = [];
const vocab = new Set<string>();
const perSession = new Map<string, number>();
let observations = 0;
let indexable = 0;
let withSubtitle = 0;
let withSource = 0;
const hookBytes = new Map<string, number[]>();

interface StoredObservation {
  sessionId: string;
  type?: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  facts?: unknown[];
  concepts?: unknown[];
  files?: unknown[];
  source?: { hookType?: string; originalBytes?: number };
}

for await (const line of valueLines(args.container, ALL_OBSERVATIONS)) {
  const obs = JSON.parse(line) as StoredObservation;
  observations++;
  perSession.set(obs.sessionId, (perSession.get(obs.sessionId) ?? 0) + 1);
  types[obs.type ?? "none"] = (types[obs.type ?? "none"] ?? 0) + 1;
  jsonBytes.push(Buffer.byteLength(line));
  if (obs.subtitle) withSubtitle++;
  if (obs.source) {
    withSource++;
    const hook = String(obs.source.hookType ?? "unknown");
    if (!hookBytes.has(hook)) hookBytes.set(hook, []);
    hookBytes.get(hook)!.push(Number(obs.source.originalBytes) || 0);
  }
  if (!obs.title || !obs.narrative) continue;
  indexable++;
  titleLen.push(obs.title.length);
  narrativeLen.push(obs.narrative.length);
  facts.push(obs.facts?.length ?? 0);
  concepts.push(obs.concepts?.length ?? 0);
  files.push(obs.files?.length ?? 0);
  for (const f of obs.facts ?? []) factLen.push(String(f).length);
  const text = [obs.title, obs.subtitle ?? "", obs.narrative, ...(obs.facts ?? []), ...(obs.concepts ?? [])].join(" ").toLowerCase();
  let terms = 0;
  for (const m of text.matchAll(TOKEN)) {
    terms++;
    vocab.add(m[0]);
  }
  termsPerDoc.push(terms);
}

const memoryBytes: number[] = [];
for await (const line of valueLines(args.container, "valkey-cli --raw hvals state:mem:memories")) {
  memoryBytes.push(Buffer.byteLength(line));
}
if (observations === 0) throw new Error(`no observations in ${args.container}`);
if (indexable === 0) throw new Error(`no indexable observations in ${args.container}`);

const counts = (xs: number[]) => histogram(xs, [0, 1, 2, 3, 4, 5, 6, 8, 10, 16]);
const profile = {
  observations,
  indexable,
  withSubtitle,
  withSource,
  sessions: perSession.size,
  types: Object.fromEntries(Object.entries(types).sort(([a, x], [b, y]) => y - x || Number(a > b) - Number(a < b))),
  hookTypes: Object.fromEntries([...hookBytes].sort((a, b) => b[1].length - a[1].length || Number(a[0] > b[0]) - Number(a[0] < b[0]))
    .map(([hook, bytes]) => [hook, { count: bytes.length, originalBytes: quantiles(bytes, 21) }])),
  jsonBytes: {
    mean: Math.round(jsonBytes.reduce((a, b) => a + b, 0) / jsonBytes.length),
    histogram: histogram(jsonBytes, SIZE_EDGES),
    quantiles: quantiles(jsonBytes, 1001),
  },
  indexed: {
    titleLength: quantiles(titleLen),
    narrativeLength: quantiles(narrativeLen),
    termsPerDoc: quantiles(termsPerDoc),
    factLength: quantiles(factLen),
    facts: counts(facts),
    concepts: counts(concepts),
    files: counts(files),
    vocabulary: vocab.size,
  },
  observationsPerSession: quantiles([...perSession.values()]),
  memories: { count: memoryBytes.length, jsonBytes: quantiles(memoryBytes) },
};
const json = JSON.stringify(profile, null, 2);
if (args.out) writeFileSync(args.out, json + "\n");
else console.log(json);

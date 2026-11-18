// Builds the private recall-eval tier from a replica's own data, without an LLM
// and without printing content. Writes the cases (which contain private text)
// to --out, which must live outside the repository; prints counts only.
//
// keyword: a seeded sample of indexed observations and memories. The query is the
//   record's four rarest title/narrative terms that occur in 2-200 records, in a
//   seeded order. Every record with the same indexed text counts as a hit.
// graph:   an edge A-B whose node B is backed by a stored observation X (indexed or
//   not) that shares no term with A's name. The query is A's name in quotes, which smart search uses
//   as a graph entity, so X is reachable only through the edge.
//
//   node --import tsx bench/fork/private-cases.ts --container <valkey> --out /home/cownose/am-staging/eval-private/<name>.json
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { mulberry32 } from "./lib/stats.js";
import type { EvalCase } from "./lib/score.js";

const { values: args } = parseArgs({
  options: {
    container: { type: "string" },
    out: { type: "string" },
    seed: { type: "string", default: "1155" },
    keyword: { type: "string", default: "80" },
    memories: { type: "string", default: "20" },
    graph: { type: "string", default: "20" },
  },
});
if (!args.container || !args.out) throw new Error("--container and --out are required");
if (resolve(args.out).startsWith(resolve(import.meta.dirname, "../.."))) throw new Error("--out must be outside the repository");

const rand = mulberry32(Number(args.seed));
const TOKEN = /[\p{L}\p{N}]{3,}/gu;
const terms = (text: string) => [...new Set(text.toLowerCase().match(TOKEN) ?? [])];

async function* hvals(script: string): AsyncIterable<Record<string, unknown>> {
  const child = spawn("docker", ["exec", args.container!, "sh", "-c", script], { stdio: ["ignore", "pipe", "inherit"] });
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (line.startsWith("{")) yield JSON.parse(line);
  }
}

interface Doc { id: string; text: string; terms: string[] }
const docs: Doc[] = [];
const memoryDocs: Doc[] = [];
const observationTerms = new Map<string, string[]>();
for await (const o of hvals('valkey-cli --scan --pattern "state:mem:obs:*" | while read -r k; do valkey-cli --raw hvals "$k"; done')) {
  observationTerms.set(String(o.id), terms(`${o.title ?? ""}\n${o.subtitle ?? ""}\n${o.narrative ?? ""}`));
  if (typeof o.title !== "string" || typeof o.narrative !== "string" || !o.title || !o.narrative) continue;
  const text = `${o.title}\n${o.narrative}`;
  docs.push({ id: String(o.id), text, terms: terms(text) });
}
for await (const m of hvals("valkey-cli --raw hvals state:mem:memories")) {
  if (m.isLatest === false || typeof m.title !== "string" || typeof m.content !== "string") continue;
  const text = `${m.title}\n${m.content}`;
  memoryDocs.push({ id: String(m.id), text, terms: terms(text) });
}

const df = new Map<string, number>();
for (const d of [...docs, ...memoryDocs]) for (const t of d.terms) df.set(t, (df.get(t) ?? 0) + 1);
const sameText = new Map<string, string[]>();
for (const d of [...docs, ...memoryDocs]) {
  const group = sameText.get(d.text) ?? [];
  group.push(d.id);
  sameText.set(d.text, group);
}

function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const cases: EvalCase[] = [];
function keywordCases(pool: Doc[], want: number, prefix: string): void {
  const sorted = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1));
  let made = 0;
  for (const d of shuffled(sorted)) {
    if (made >= want) break;
    const rare = d.terms.filter((t) => { const n = df.get(t)!; return n >= 2 && n <= 200 && !/^\d+$/.test(t); })
      .sort((a, b) => df.get(a)! - df.get(b)! || (a < b ? -1 : 1)).slice(0, 4);
    if (rare.length < 3) continue;
    made++;
    cases.push({ id: `${prefix}-${String(made).padStart(3, "0")}`, kind: prefix, query: shuffled(rare).join(" "), expected: sameText.get(d.text)! });
  }
}
keywordCases(docs, Number(args.keyword), "keyword");
keywordCases(memoryDocs, Number(args.memories), "memory");

interface Node { id: string; name: string; stale?: boolean; sourceObservationIds?: string[] }
const nodes = new Map<string, Node>();
for await (const n of hvals("valkey-cli --raw hvals state:mem:graph:nodes")) nodes.set(String(n.id), n as unknown as Node);
const edges: { a: string; b: string; id: string }[] = [];
for await (const e of hvals("valkey-cli --raw hvals state:mem:graph:edges")) {
  edges.push({ a: String(e.sourceNodeId), b: String(e.targetNodeId), id: String(e.id) });
  edges.push({ a: String(e.targetNodeId), b: String(e.sourceNodeId), id: String(e.id) });
}
let graphMade = 0;
const usedNames = new Set<string>();
for (const e of shuffled(edges.sort((x, y) => (x.id + x.a < y.id + y.a ? -1 : 1)))) {
  if (graphMade >= Number(args.graph)) break;
  const a = nodes.get(e.a);
  const b = nodes.get(e.b);
  if (!a || !b || a.stale || b.stale || usedNames.has(a.name)) continue;
  const nameTerms = terms(a.name);
  if (!nameTerms.length || a.name.includes('"')) continue;
  const fromA = new Set(a.sourceObservationIds ?? []);
  if (![...fromA].some((id) => observationTerms.has(id))) continue;
  const hidden = (b.sourceObservationIds ?? []).filter((id) => !fromA.has(id) && observationTerms.has(id) &&
    !nameTerms.some((t) => observationTerms.get(id)!.includes(t)));
  if (!hidden.length) continue;
  usedNames.add(a.name);
  graphMade++;
  cases.push({ id: `graph-${String(graphMade).padStart(3, "0")}`, kind: "graph", query: `"${a.name}"`, expected: hidden.sort() });
}

writeFileSync(args.out, JSON.stringify({ seed: Number(args.seed), source: args.container, cases }, null, 2) + "\n", { mode: 0o600 });
const byKind: Record<string, number> = {};
for (const c of cases) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
console.log(JSON.stringify({ indexedObservations: docs.length, memories: memoryDocs.length, graphNodes: nodes.size, graphEdges: edges.length / 2, cases: byKind }));

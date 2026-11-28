// Per-tool MCP latency on a replica (TEE-1451). Calls /agentmemory/mcp/call with the argument shapes agents send
// (from a week of transcripts: smart search scoped to a project and the memory layer, expandIds, lesson recall by
// project), one call at a time, tools interleaved round-robin so host noise spreads evenly. Read-only tools first;
// the write tools (save, lesson save, consolidate, reflect) run after the reads, and not at all in golden mode.
// Runs on the replica network (replica.sh client), keyword-only.
//
//   node --import tsx bench/fork/mcp-tools.ts --cases <eval cases.json> --project <name>... [--rounds 30]
//     [--golden-out golden.json | --golden-compare golden.json] [--out result.json]
//     [--ceilings bench/fork/ceilings.json --name mcp-buddy-keyword]
//
// The result's `measured` keys are `mcp.<tool>[.<variant>].p50Ms|p95Ms|p99Ms`; --name checks them against ceilings.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pXX } from "../../benchmark/lib/percentiles.js";
import { checkLimits, type Limit } from "./lib/score.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://agentmemory:3111" },
    secret: { type: "string", default: "replica-dummy-secret" },
    cases: { type: "string" },
    project: { type: "string", multiple: true, default: [] },
    rounds: { type: "string", default: "30" },
    "write-rounds": { type: "string", default: "10" },
    "golden-out": { type: "string" },
    "golden-compare": { type: "string" },
    out: { type: "string" },
    ceilings: { type: "string" },
    name: { type: "string" },
  },
});
if (!args.cases || !args.project!.length) throw new Error("--cases and at least one --project are required");

const queries = (JSON.parse(readFileSync(args.cases, "utf8")) as { cases?: { query: string }[] }).cases?.map((c) => c.query) ?? [];
if (!queries.length) throw new Error(`--cases ${args.cases} holds no cases`);
const projects = args.project!;

type Args = Record<string, unknown>;
interface Reply {
  ms: number;
  text: string;
  /** Set when the call did not give a result: a failed fetch, a status other than 200, or a 200 body that reports failure. */
  error?: string;
}

function replyError(status: number, text: string): string | undefined {
  if (status !== 200) return `${status} ${text.slice(0, 120)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { success, error } = parsed as { success?: unknown; error?: unknown };
  return success === false || (error !== undefined && error !== null) ? `200 ${text.slice(0, 120)}` : undefined;
}

async function call(name: string, toolArgs: Args): Promise<Reply> {
  const started = performance.now();
  let status: number;
  let body: string;
  try {
    const res = await fetch(`${args.url}/agentmemory/mcp/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: toolArgs }),
      signal: AbortSignal.timeout(180_000),
    });
    status = res.status;
    body = await res.text();
  } catch (err) {
    return { ms: performance.now() - started, text: "", error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ms = performance.now() - started;
  let text = body;
  try {
    text = (JSON.parse(body) as { content?: { text: string }[] }).content?.[0]?.text ?? body;
  } catch {}
  return { ms, text, error: replyError(status, text) };
}

async function callOk(name: string, toolArgs: Args): Promise<unknown> {
  const r = await call(name, toolArgs);
  if (r.error) throw new Error(`discover: ${name} failed: ${r.error}`);
  return JSON.parse(r.text);
}

// Ids the id-taking tools need, taken from the store itself, and the tools this replica cannot serve: vision
// search answers `success: false` without an image provider, so timing it would time the refusal.
async function discover() {
  const ids: string[] = [];
  for (const q of queries.slice(0, 20)) {
    for (const hit of ((await callOk("memory_smart_search", { query: q, limit: 10 })) as { results?: { obsId: string }[] }).results ?? []) ids.push(hit.obsId);
  }
  const memoryIds = [...new Set(ids.filter((id) => id.startsWith("mem_")))];
  const obsIds = [...new Set(ids.filter((id) => !id.startsWith("mem_")))];
  if (!memoryIds.length || !obsIds.length) throw new Error(`discover found ${memoryIds.length} memory and ${obsIds.length} observation ids`);
  const commits = ((await callOk("memory_commits", { limit: 1 })) as { commits?: { sha: string }[] }).commits ?? [];
  const vision = await call("memory_vision_search", { queryText: queries[0], topK: 1 });
  const skipped: Record<string, string> = vision.error ? { memory_vision_search: vision.error } : {};
  return { memoryIds, obsIds, sha: commits[0]?.sha, skipped };
}

interface Case {
  key: string;
  tool: string;
  args: (i: number) => Args;
}

function readCases(ids: { memoryIds: string[]; obsIds: string[]; sha?: string; skipped: Record<string, string> }): Case[] {
  const q = (i: number) => queries[i % queries.length]!;
  const p = (i: number) => projects[i % projects.length]!;
  const mem = (i: number) => ids.memoryIds[i % ids.memoryIds.length]!;
  const obs = (i: number) => ids.obsIds[i % ids.obsIds.length]!;
  const words = (i: number) => q(i).split(/\s+/).slice(0, 2).join(" ");
  const cases: Case[] = [
    { key: "memory_smart_search.project-memory", tool: "memory_smart_search", args: (i) => ({ query: q(i), project: p(i), targetLayer: "memory", ...(i % 2 ? { limit: 5 } : {}) }) },
    { key: "memory_smart_search.memory", tool: "memory_smart_search", args: (i) => ({ query: q(i), targetLayer: "memory", limit: 10 }) },
    { key: "memory_smart_search.project-all", tool: "memory_smart_search", args: (i) => ({ query: q(i), project: p(i), targetLayer: "all", limit: 10 }) },
    { key: "memory_smart_search.all", tool: "memory_smart_search", args: (i) => ({ query: q(i), targetLayer: "all", limit: 10 }) },
    { key: "memory_smart_search.expand", tool: "memory_smart_search", args: (i) => ({ expandIds: [mem(i), mem(i + 1), obs(i)].join(",") }) },
    { key: "memory_smart_search.expand-project", tool: "memory_smart_search", args: (i) => ({ expandIds: [mem(i), mem(i + 1)].join(","), project: p(i) }) },
    { key: "memory_lesson_recall", tool: "memory_lesson_recall", args: (i) => ({ query: q(i), project: p(i) }) },
    { key: "memory_recall", tool: "memory_recall", args: (i) => ({ query: q(i), limit: 10, format: "compact" }) },
    { key: "memory_sessions", tool: "memory_sessions", args: (i) => ({ project: p(i), limit: 20 }) },
    { key: "memory_diagnose", tool: "memory_diagnose", args: () => ({}) },
    { key: "memory_file_history", tool: "memory_file_history", args: () => ({ files: "src/index.ts" }) },
    { key: "memory_patterns", tool: "memory_patterns", args: (i) => ({ project: p(i), limit: 10 }) },
    { key: "memory_timeline.keyword", tool: "memory_timeline", args: (i) => ({ anchor: q(i).trim().split(/\s+/)[0]!, before: 5, after: 5 }) },
    { key: "memory_timeline.date", tool: "memory_timeline", args: (i) => ({ anchor: `2026-11-${String(1 + (i % 15)).padStart(2, "0")}T12:00:00Z`, project: p(i), before: 5, after: 5 }) },
    { key: "memory_relations", tool: "memory_relations", args: (i) => ({ memoryId: mem(i) }) },
    { key: "memory_commits", tool: "memory_commits", args: () => ({ limit: 20 }) },
    ...(ids.sha ? [{ key: "memory_commit_lookup", tool: "memory_commit_lookup", args: () => ({ sha: ids.sha }) }] : []),
    { key: "memory_graph_query", tool: "memory_graph_query", args: (i) => ({ query: words(i), maxDepth: 2 }) },
    { key: "memory_team_feed", tool: "memory_team_feed", args: () => ({ limit: 20 }) },
    { key: "memory_audit", tool: "memory_audit", args: () => ({ limit: 50 }) },
    { key: "memory_frontier", tool: "memory_frontier", args: (i) => ({ project: p(i), limit: 10 }) },
    { key: "memory_next", tool: "memory_next", args: (i) => ({ project: p(i) }) },
    { key: "memory_facet_query", tool: "memory_facet_query", args: () => ({ matchAny: "type:decision" }) },
    { key: "memory_verify", tool: "memory_verify", args: (i) => ({ id: mem(i) }) },
    { key: "memory_insight_list", tool: "memory_insight_list", args: (i) => ({ project: p(i), limit: 10 }) },
    { key: "memory_vision_search", tool: "memory_vision_search", args: (i) => ({ queryText: q(i), topK: 5 }) },
    { key: "memory_export", tool: "memory_export", args: () => ({ maxSessions: 5, collectionLimit: 50, collections: "memories,lessons" }) },
  ];
  return cases.filter((c) => !(c.tool in ids.skipped));
}

function writeCases(): Case[] {
  const p = (i: number) => projects[i % projects.length]!;
  return [
    { key: "memory_save", tool: "memory_save", args: (i) => ({ content: `TEE-1451 bench marker ${i}: written by the memory_save write path of the replica latency bench.`, type: "fact", concepts: "bench,tee-1451", project: p(i) }) },
    { key: "memory_lesson_save", tool: "memory_lesson_save", args: (i) => ({ content: `TEE-1451 bench lesson marker ${i}: written by the memory_lesson_save write path of the replica latency bench.`, project: p(i), tags: "bench" }) },
    { key: "memory_consolidate", tool: "memory_consolidate", args: () => ({}) },
    { key: "memory_reflect", tool: "memory_reflect", args: (i) => ({ project: p(i), maxClusters: 5 }) },
  ];
}

const round = (x: number) => Math.round(x * 10) / 10;
async function run(cases: Case[], rounds: number, samples: Map<string, number[]>, errors: Map<string, string[]>) {
  for (let i = 0; i < rounds; i++) {
    for (const c of cases) {
      const r = await call(c.tool, c.args(i));
      if (r.error) (errors.get(c.key) ?? errors.set(c.key, []).get(c.key)!).push(r.error);
      else (samples.get(c.key) ?? samples.set(c.key, []).get(c.key)!).push(r.ms);
    }
  }
}

const readRounds = Number(args.rounds);
const writeRounds = Number(args["write-rounds"]);
if (!Number.isInteger(readRounds) || readRounds < 1) throw new Error(`--rounds must be a positive integer, got "${args.rounds}"`);
if (!Number.isInteger(writeRounds) || writeRounds < 0) throw new Error(`--write-rounds must be a non-negative integer, got "${args["write-rounds"]}"`);
const goldenMode = args["golden-out"] !== undefined || args["golden-compare"] !== undefined;

const ids = await discover();
const reads = readCases(ids);

// The golden pass: the same fixed inputs before and after a change must give the same bodies. Ranked lists keep
// their order; only keys a call sets afresh are dropped: the clock at reply time, run timings, and the access
// counters the bench's own reads bump. Stored times such as an observation's `timestamp` are compared. Frontier and
// next score actions by their age, so they are timed but not compared. A call that fails is left out of the
// golden file and fails the run, so two runs that fail alike cannot pass as unchanged. Golden mode skips the write
// pass, so a second run on the same replica sees the store the first one did.
const UNCOMPARED = new Set(["memory_frontier", "memory_next"]);
const VOLATILE = /^(exportedAt|generatedAt|checkedAt|elapsedMs|durationMs|tookMs|accessCount|lastAccessedAt)$/;
const normalize = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), (k, v) => (VOLATILE.test(k) ? undefined : v));
  } catch {
    return text;
  }
};
if (goldenMode) {
  const golden: Record<string, string> = {};
  const failed: Record<string, string> = {};
  for (const c of reads.filter((r) => !UNCOMPARED.has(r.tool))) {
    for (let i = 0; i < 3; i++) {
      const r = await call(c.tool, c.args(i));
      if (r.error) failed[`${c.key}#${i}`] = r.error;
      else golden[`${c.key}#${i}`] = normalize(r.text);
    }
  }
  if (args["golden-out"]) writeFileSync(args["golden-out"], JSON.stringify(golden, null, 1));
  const differ: string[] = [];
  let compared = 0;
  if (args["golden-compare"]) {
    const before = JSON.parse(readFileSync(args["golden-compare"], "utf8")) as Record<string, string>;
    compared = Object.keys(before).length;
    differ.push(...Object.keys(before).filter((k) => !(k in failed) && before[k] !== golden[k]));
  }
  console.log(JSON.stringify({ golden: { recorded: Object.keys(golden).length, compared, differ, failed } }, null, 2));
  if (differ.length || Object.keys(failed).length) process.exitCode = 1;
}

const samples = new Map<string, number[]>();
const errors = new Map<string, string[]>();
await run(reads, readRounds, samples, errors);
if (!goldenMode) await run(writeCases(), writeRounds, samples, errors);

// A key whose every call failed has no samples: it shows its error count and no percentiles, so a ceiling on it
// reports it unmeasured.
const tools: Record<string, { n: number; p50Ms?: number; p95Ms?: number; p99Ms?: number; maxMs?: number; errors: number }> = {};
const measured: Record<string, number> = {};
for (const key of new Set([...samples.keys(), ...errors.keys()])) {
  const sorted = [...(samples.get(key) ?? [])].sort((a, b) => a - b);
  const s = { n: sorted.length, errors: errors.get(key)?.length ?? 0 };
  if (!sorted.length) {
    tools[key] = s;
    continue;
  }
  const p = { p50Ms: round(pXX(sorted, 50)), p95Ms: round(pXX(sorted, 95)), p99Ms: round(pXX(sorted, 99)) };
  tools[key] = { ...s, ...p, maxMs: round(sorted.at(-1)!) };
  for (const [m, v] of Object.entries(p)) measured[`mcp.${key}.${m}`] = v;
}
const result = { at: new Date().toISOString(), projects, ids: { memory: ids.memoryIds.length, observation: ids.obsIds.length }, skipped: ids.skipped, tools, measured, errors: Object.fromEntries(errors) };
if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
for (const [tool, why] of Object.entries(ids.skipped)) console.log(`skipped ${tool}: ${why}`);
const cell = (v: number | undefined) => String(v ?? "-").padStart(8);
console.log("tool".padEnd(40), "n".padStart(4), "p50".padStart(8), "p95".padStart(8), "p99".padStart(8), "max".padStart(8), "err");
for (const [key, s] of Object.entries(tools).sort((a, b) => (b[1].p95Ms ?? -1) - (a[1].p95Ms ?? -1))) {
  console.log(key.padEnd(40), String(s.n).padStart(4), cell(s.p50Ms), cell(s.p95Ms), cell(s.p99Ms), cell(s.maxMs), s.errors);
}
if (args.ceilings && args.name) {
  const limits = (JSON.parse(readFileSync(args.ceilings, "utf8")) as Record<string, { limits: Limit[] }>)[args.name]?.limits;
  if (!limits) throw new Error(`no ceilings entry "${args.name}"`);
  const violations = checkLimits(measured, limits);
  for (const v of violations) console.error(`FAIL ${v.metric}: measured ${v.measured}, limit ${v.limit}`);
  // A failed call returns fast, so a tool that errors would pass its latency ceiling.
  for (const [key, list] of errors) console.error(`FAIL ${key}: ${list.length} calls failed, first: ${list[0]}`);
  if (violations.length || errors.size) process.exitCode = 1;
  else console.log(`PASS ${limits.length} limits`);
}

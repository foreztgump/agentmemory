// Calls mem::context for every project on a replica, once with a session id no project has and
// once per recent session (each call leaves its own session out, so each sees a different ten).
// Writes one JSON line per call with the output and its latency, then prints p50/p99. Run it
// against two images on the same restore and compare the files with --compare.
//
//   AGENTMEMORY_SECRET=replica-dummy-secret npx tsx scripts/fork/context-golden.ts \
//     --url http://agentmemory:3111 --out old.jsonl [--per-project 12] [--passes 2]
//   npx tsx scripts/fork/context-golden.ts --compare old.jsonl new.jsonl
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://agentmemory:3111" },
    out: { type: "string" },
    "per-project": { type: "string", default: "12" },
    passes: { type: "string", default: "2" },
    compare: { type: "boolean", default: false },
  },
});

type Line = { pass: number; project: string; sessionId: string; ms: number; status: number; body: string };

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
};

if (args.compare) {
  if (positionals.length !== 2) throw new Error("--compare takes two files: old.jsonl new.jsonl");
  const read = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Line);
  const [a, b] = positionals.map(read) as [Line[], Line[]];
  const key = (l: Line) => `${l.pass}\u0000${l.project}\u0000${l.sessionId}`;
  const byKey = new Map(b.map((l) => [key(l), l]));
  let same = 0;
  const differ: string[] = [];
  for (const l of a) {
    const other = byKey.get(key(l));
    byKey.delete(key(l));
    if (other && other.status === l.status && other.body === l.body) same++;
    else differ.push(`${l.pass} ${l.project} ${l.sessionId}`);
  }
  for (const l of byKey.values()) differ.push(`only in the second file: ${l.pass} ${l.project} ${l.sessionId}`);
  const blocksOf = (body: string) => {
    try {
      return Number(JSON.parse(body).blocks) || 0;
    } catch {
      return 0;
    }
  };
  const nonEmpty = a.filter((l) => blocksOf(l.body) > 0).length;
  console.log(`compared ${a.length} calls (${nonEmpty} with context): ${same} identical, ${differ.length} differ`);
  for (const d of differ.slice(0, 20)) console.log(`  differs: ${d}`);
  process.exit(differ.length === 0 ? 0 : 1);
}

const base = args.url!.replace(/\/$/, "");
const secret = process.env.AGENTMEMORY_SECRET;
if (!secret) throw new Error("AGENTMEMORY_SECRET is not set; every call would be rejected and the capture would look like empty context");
const headers: Record<string, string> = {
  "content-type": "application/json",
  ...(secret ? { authorization: `Bearer ${secret}` } : {}),
};

type Session = { id: string; project?: string; startedAt?: string };
const sessions: Session[] = [];
let cursor: string | null = null;
do {
  const url = `${base}/agentmemory/sessions?agentId=*&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`sessions: ${response.status} ${await response.text()}`);
  const page = (await response.json()) as { sessions: Session[]; nextCursor: string | null };
  sessions.push(...page.sessions);
  cursor = page.nextCursor;
} while (cursor);

const byProject = new Map<string, Session[]>();
for (const s of sessions) {
  if (typeof s.project !== "string") continue;
  if (!byProject.has(s.project)) byProject.set(s.project, []);
  byProject.get(s.project)!.push(s);
}
const perProject = Number(args["per-project"]);
const passes = Number(args.passes);
if (!Number.isInteger(perProject) || perProject < 1) throw new Error(`invalid --per-project: ${args["per-project"]}`);
if (!Number.isInteger(passes) || passes < 1) throw new Error(`invalid --passes: ${args.passes}`);
const startedMs = (s: Session) => new Date(s.startedAt ?? 0).getTime() || 0;
const calls: { project: string; sessionId: string }[] = [];
for (const [project, list] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
  calls.push({ project, sessionId: "golden-probe-none" });
  const recent = [...list].sort((a, b) => startedMs(b) - startedMs(a)).slice(0, perProject);
  for (const s of recent) calls.push({ project, sessionId: s.id });
}
if (calls.length === 0) {
  console.error(`context-golden: ${sessions.length} sessions but none with a project; nothing to probe`);
  process.exit(1);
}
console.log(`context-golden: ${sessions.length} sessions, ${byProject.size} projects, ${calls.length} calls per pass`);

const lines: Line[] = [];
for (let pass = 1; pass <= passes; pass++) {
  for (const call of calls) {
    const started = performance.now();
    const response = await fetch(`${base}/agentmemory/context`, {
      method: "POST", headers, body: JSON.stringify({ ...call, agentId: "*" }), signal: AbortSignal.timeout(120_000),
    });
    const body = await response.text();
    lines.push({ pass, ...call, ms: performance.now() - started, status: response.status, body });
  }
  const ms = lines.filter((l) => l.pass === pass).map((l) => l.ms);
  console.log(`  pass ${pass}: p50 ${quantile(ms, 0.5).toFixed(1)} ms, p99 ${quantile(ms, 0.99).toFixed(1)} ms, max ${Math.max(...ms).toFixed(1)} ms`);
}
writeFileSync(args.out ?? "context-golden.jsonl", lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

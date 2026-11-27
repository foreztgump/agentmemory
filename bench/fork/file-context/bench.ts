// File context golden and latency bench (TEE-1191). Runs in the replica's client container:
//
//   bench/fork/replica.sh client node --import tsx bench/fork/file-context/bench.ts cases > cases.json
//   bench/fork/replica.sh client node --import tsx bench/fork/file-context/bench.ts run /private/cases.json > run.json
//   node --import tsx bench/fork/file-context/bench.ts diff before.json after.json
//
// `cases` picks real files from each project's 16 most recent sessions (which can appear in the output) and from
// older sessions (which cannot), plus "./", suffix and basename forms, and calls with and without project and
// sessionId. `run` posts every case to /agentmemory/file-context, checks that repeated calls agree, and prints
// each output with p50/p99 latency. The output holds the store's text: keep it out of the repo.
import { readFileSync } from "node:fs";

const BASE = process.env.AM_URL ?? "http://agentmemory:3111";
const HEADERS = { "content-type": "application/json", authorization: `Bearer ${process.env.AM_SECRET ?? "replica-dummy-secret"}` };

type Session = { id: string; project?: string; startedAt: string };
type Obs = { files?: unknown; title?: string; importance?: number };
type Case = { files: string[]; project?: string; sessionId?: string; tag: string };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function postTimed(path: string, body: unknown): Promise<{ ms: number; body: unknown }> {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
  const parsed = await res.json();
  const ms = performance.now() - started;
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${JSON.stringify(parsed).slice(0, 200)}`);
  return { ms, body: parsed };
}

function rng(seed: number): () => number {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

function filesOf(rows: Obs[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.files) || !row.title || !((row.importance ?? 0) >= 4)) continue;
    for (const f of row.files) if (typeof f === "string" && f.length > 0) out.add(f);
  }
  return [...out];
}

async function observationsOf(sessionId: string): Promise<Obs[]> {
  return (await getJson<{ observations: Obs[] }>(`/agentmemory/observations?sessionId=${encodeURIComponent(sessionId)}`)).observations;
}

async function buildCases(): Promise<Case[]> {
  const { sessions } = await getJson<{ sessions: Session[] }>("/agentmemory/sessions");
  const byRecency = [...sessions].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const projects = [...new Set(byRecency.map((s) => s.project).filter((p): p is string => typeof p === "string" && p.length > 0))];
  const pick = rng(1191);
  const sample = <T>(items: T[], n: number) => [...items].sort(() => pick() - 0.5).slice(0, n);
  const cases: Case[] = [];
  const groups: Array<{ project?: string; ranked: Session[] }> = [
    { ranked: byRecency },
    ...projects.map((project) => ({ project, ranked: byRecency.filter((s) => s.project === project) })),
  ];
  for (const { project, ranked } of groups) {
    const window = ranked.slice(0, 16);
    const recent = new Set<string>();
    for (const s of window) for (const f of filesOf(await observationsOf(s.id))) recent.add(f);
    const older = new Set<string>();
    for (const s of sample(ranked.slice(16), 6)) for (const f of filesOf(await observationsOf(s.id))) older.add(f);
    const tag = project ?? "all";
    for (const f of sample([...recent], project ? 25 : 80)) {
      cases.push({ files: [f], tag: `${tag}:recent` });
      if (project) cases.push({ files: [f], project, tag: `${tag}:recent:project` });
      if (window[0]) cases.push({ files: [f], sessionId: window[0].id, ...(project ? { project } : {}), tag: `${tag}:recent:exclude` });
    }
    for (const f of sample([...recent], 8)) {
      const base = f.split("/").pop() ?? f;
      const tail = f.split("/").slice(-2).join("/");
      cases.push({ files: [base], tag: `${tag}:basename` }, { files: [tail], tag: `${tag}:tail` }, { files: [`./${tail}`], tag: `${tag}:dot` });
    }
    for (const f of sample([...older], project ? 10 : 30)) cases.push({ files: [f], ...(project ? { project } : {}), tag: `${tag}:older` });
    const multi = sample([...recent], 9);
    for (let i = 0; i + 3 <= multi.length; i += 3) cases.push({ files: multi.slice(i, i + 3), tag: `${tag}:multi` });
  }
  cases.push({ files: ["index.ts"], tag: "hot" }, { files: ["package.json"], tag: "hot" }, { files: ["README.md"], tag: "hot" });
  return cases;
}

function quantile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : NaN;
}

async function run(casesPath: string, reps: number) {
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
  for (const c of cases.slice(0, 5)) await postTimed("/agentmemory/file-context", c);
  const results: Array<Case & { context: string }> = [];
  const latencies: number[] = [];
  const unstable: string[] = [];
  for (const c of cases) {
    let first: string | undefined;
    for (let r = 0; r < reps; r++) {
      const { ms, body } = await postTimed("/agentmemory/file-context", { files: c.files, ...(c.project ? { project: c.project } : {}), ...(c.sessionId ? { sessionId: c.sessionId } : {}) });
      latencies.push(ms);
      const context = (body as { context?: string }).context ?? "";
      if (first === undefined) first = context;
      else if (first !== context) unstable.push(c.files.join(","));
    }
    results.push({ ...c, context: first ?? "" });
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const nonEmpty = results.filter((r) => r.context.length > 0).length;
  console.log(JSON.stringify({ calls: latencies.length, cases: cases.length, nonEmpty, unstable, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), p99: quantile(sorted, 0.99), max: sorted.at(-1), results }, null, 1));
}

function diff(beforePath: string, afterPath: string) {
  type Run = { results: Array<Case & { context: string }>; p50: number; p99: number; nonEmpty: number };
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as Run;
  const after = JSON.parse(readFileSync(afterPath, "utf8")) as Run;
  const key = (c: Case) => JSON.stringify([c.files, c.project ?? null, c.sessionId ?? null, c.tag]);
  const afterByKey = new Map(after.results.map((r) => [key(r), r.context]));
  const mismatched = before.results.filter((r) => afterByKey.get(key(r)) !== r.context).map((r) => key(r));
  console.log(JSON.stringify({ cases: before.results.length, nonEmpty: before.nonEmpty, mismatched: mismatched.length, examples: mismatched.slice(0, 10), before: { p50: before.p50, p99: before.p99 }, after: { p50: after.p50, p99: after.p99 } }, null, 1));
  if (mismatched.length > 0 || before.results.length !== after.results.length) process.exitCode = 1;
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "cases") console.log(JSON.stringify(await buildCases()));
else if (mode === "run") await run(a!, Number(process.env.REPS ?? 3));
else if (mode === "diff") diff(a!, b!);
else {
  console.error("usage: bench.ts cases | run <cases.json> | diff <before.json> <after.json>");
  process.exitCode = 2;
}

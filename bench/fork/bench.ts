// Benchmarks a fresh replica and checks the numbers against committed ceilings.
// Restores the snapshot, boots agentmemory, then measures boot time to ready,
// boot peak memory (cgroup memory.peak per container), steady memory after an
// idle wait, search latency and recall over the eval cases, and capture
// throughput over REST. Exits 1 when any limit in --ceilings is broken.
//
//   AM_IMAGE=<image> node --import tsx bench/fork/bench.ts --name <ceilings entry> --data <backup-dir|dump.rdb>
//     --cases <file>... --profile <file> [--embedding voyage] [--am-mem-limit 2560m] [--steady-minutes 5]
//     [--capture 3000] [--ceiling metric=value]... [--out result.json] [--keep]
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkLimits, type Limit } from "./lib/score.js";

const { values: args } = parseArgs({
  options: {
    name: { type: "string" },
    data: { type: "string" },
    cases: { type: "string", multiple: true, default: [] },
    profile: { type: "string", default: "bench/fork/profiles/buddy-2026-11-16.json" },
    ceilings: { type: "string", default: "bench/fork/ceilings.json" },
    ceiling: { type: "string", multiple: true, default: [] },
    embedding: { type: "string", default: "" },
    "am-mem-limit": { type: "string", default: "2560m" },
    "steady-minutes": { type: "string", default: "5" },
    capture: { type: "string", default: "3000" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    "check-only": { type: "string" },
  },
});

const REPO = resolve(import.meta.dirname, "../..");
const REPLICA = resolve(import.meta.dirname, "replica.sh");
const project = process.env.REPLICA_PROJECT ?? "amreplica";
const container = (service: string) => `${project}-${service}-1`;
const MiB = 1024 * 1024;

function limitsFor(name: string): Limit[] {
  const all = JSON.parse(readFileSync(resolve(REPO, args.ceilings!), "utf8")) as Record<string, { limits: Limit[] }>;
  if (!all[name]) throw new Error(`no ceilings entry "${name}" in ${args.ceilings}`);
  const limits = all[name].limits.map((l) => ({ ...l }));
  for (const override of args.ceiling!) {
    const [metric, value] = override.split("=");
    const limit = limits.find((l) => l.metric === metric);
    if (!limit) throw new Error(`--ceiling names unknown metric ${metric}`);
    if (limit.max !== undefined) limit.max = Number(value);
    else limit.min = Number(value);
  }
  return limits;
}

function report(measured: Record<string, number>, limits: Limit[]): number {
  for (const [metric, value] of Object.entries(measured)) console.log(`${metric.padEnd(44)} ${value}`);
  const violations = checkLimits(measured, limits);
  for (const v of violations) console.error(`FAIL ${v.metric}: measured ${v.measured}, limit ${v.limit}`);
  if (!violations.length) console.log(`PASS ${limits.length} limits`);
  return violations.length ? 1 : 0;
}

if (args["check-only"]) {
  const measured = JSON.parse(readFileSync(args["check-only"], "utf8")).measured as Record<string, number>;
  process.exit(report(measured, limitsFor(args.name!)));
}

if (!args.name || !args.data) throw new Error("--name and --data are required");
const limits = limitsFor(args.name);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  REPLICA_PROJECT: project,
  AM_MEM_LIMIT: args["am-mem-limit"],
  REPLICA_EMBEDDING_PROVIDER: args.embedding,
};
const privateDirs = [...new Set(args.cases!.map((f) => resolve(f)).filter((f) => !f.startsWith(REPO + "/")).map(dirname))];
if (privateDirs.length > 1) throw new Error("cases outside the repository must share one directory");
if (privateDirs[0]) env.REPLICA_PRIVATE_DIR = privateDirs[0];
const inClient = (f: string) => (resolve(f).startsWith(REPO + "/") ? resolve(f).slice(REPO.length + 1) : `/private/${basename(f)}`);

function replica(...argv: string[]): string {
  const r = spawnSync(REPLICA, argv, { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`replica.sh ${argv[0]} failed (${r.status})`);
  return r.stdout;
}

function cgroup(service: string, file: string): number | null {
  const r = spawnSync("docker", ["exec", container(service), "cat", `/sys/fs/cgroup/${file}`], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) : null;
}

function cgroupStat(service: string, key: string): number | null {
  const r = spawnSync("docker", ["exec", container(service), "cat", "/sys/fs/cgroup/memory.stat"], { encoding: "utf8" });
  const line = r.status === 0 ? r.stdout.split("\n").find((l) => l.startsWith(`${key} `)) : undefined;
  return line ? Number(line.split(" ")[1]) : null;
}

const mib = (bytes: number | null) => (bytes === null ? NaN : Math.round(bytes / MiB));
const measured: Record<string, number> = {};
const notes: string[] = [];

try {
  replica("valkey", args.data);
  const app = spawn(REPLICA, ["app"], { env, stdio: ["ignore", "inherit", "inherit"] });
  const exited = new Promise<number>((done) => app.on("exit", (code) => done(code ?? 1)));
  let lastPeak: number | null = null;
  let finished: number | null = null;
  exited.then((code) => { finished = code; });
  while (finished === null) {
    lastPeak = cgroup("agentmemory", "memory.peak") ?? lastPeak;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const readyAt = Date.now();
  if (finished !== 0) {
    const state = spawnSync("docker", ["inspect", "-f", "{{.State.OOMKilled}} {{.State.ExitCode}}", container("agentmemory")], { encoding: "utf8" }).stdout.trim();
    const heapOoms = spawnSync("docker", ["exec", container("agentmemory"), "sh", "-c",
      "cat /data/compose-state/*/agentmemory/logs/agentmemory.log* 2>/dev/null | grep -c 'JavaScript heap out of memory'"], { encoding: "utf8" }).stdout.trim();
    measured["boot.peakMiB.agentmemory"] = mib(lastPeak);
    notes.push(`agentmemory did not become ready (OOMKilled ExitCode: ${state}); last memory.peak ${mib(lastPeak)} MiB under limit ${args["am-mem-limit"]}; worker heap out-of-memory crashes: ${heapOoms || "n/a"}`);
    throw new Error(notes[notes.length - 1]);
  }
  const startedAt = Date.parse(spawnSync("docker", ["inspect", "-f", "{{.State.StartedAt}}", container("agentmemory")], { encoding: "utf8" }).stdout.trim());
  measured["boot.seconds"] = Math.round((readyAt - startedAt) / 100) / 10;
  measured["boot.peakMiB.agentmemory"] = mib(cgroup("agentmemory", "memory.peak"));
  measured["boot.peakMiB.valkey"] = mib(cgroup("valkey", "memory.peak"));
  const index = JSON.parse(replica("client", "node", "bench/fork/ready.mjs", "http://agentmemory:3111", "replica-dummy-secret", "--print"));
  measured["index.bm25Documents"] = index.bm25Documents;
  measured["index.vectorDocuments"] = index.vectorDocuments ?? 0;

  const steadyMinutes = Number(args["steady-minutes"]);
  console.error(`bench: ready in ${measured["boot.seconds"]}s; idling ${steadyMinutes} min`);
  await new Promise((r) => setTimeout(r, steadyMinutes * 60_000));
  measured["steady.MiB.agentmemory"] = mib(cgroup("agentmemory", "memory.current"));
  measured["steady.MiB.valkey"] = mib(cgroup("valkey", "memory.current"));
  measured["steady.anonMiB.agentmemory"] = mib(cgroupStat("agentmemory", "anon"));
  measured["steady.anonMiB.valkey"] = mib(cgroupStat("valkey", "anon"));

  if (args.cases!.length) {
    const evalOut = JSON.parse(replica("client", "node", "--import", "tsx", "bench/fork/eval.ts", ...args.cases!.flatMap((f) => ["--cases", inClient(f)])));
    for (const [file, suite] of Object.entries(evalOut) as [string, { scores: Record<string, number>; latencyMs: Record<string, number> }][]) {
      const name = basename(file, ".json");
      measured[`recall.${name}.recallAt10`] = suite.scores.recallAt10;
      measured[`recall.${name}.mrr`] = suite.scores.mrr;
      if (suite.scores.graphCases) measured[`recall.${name}.graphPassed`] = suite.scores.graphPassed;
      measured[`search.${name}.p50Ms`] = Math.round(suite.latencyMs.p50 * 10) / 10;
      measured[`search.${name}.p95Ms`] = Math.round(suite.latencyMs.p95 * 10) / 10;
    }
  }

  if (Number(args.capture) > 0) {
    const cap = JSON.parse(replica("client", "node", "--import", "tsx", "bench/fork/capture.ts", "--profile", inClient(args.profile!), "--count", args.capture!));
    measured["capture.storedPerSecond"] = cap.storedPerSecond;
    if (cap.stored < cap.events) notes.push(`capture stored ${cap.stored} of ${cap.events} events: ${JSON.stringify(cap.statuses)}`);
  }
  measured["run.peakMiB.agentmemory"] = mib(cgroup("agentmemory", "memory.peak"));
  measured["run.peakMiB.valkey"] = mib(cgroup("valkey", "memory.peak"));
} catch (error) {
  console.error(`bench: ${(error as Error).message}`);
} finally {
  if (!args.keep) replica("stop");
}

const image = spawnSync("docker", ["image", "inspect", "-f", "{{.Id}}", process.env.AM_IMAGE ?? ""], { encoding: "utf8" }).stdout.trim();
const result = {
  name: args.name,
  at: new Date().toISOString(),
  image: `${process.env.AM_IMAGE} ${image}`,
  settings: { amMemLimit: args["am-mem-limit"], embedding: args.embedding || "none", steadyMinutes: Number(args["steady-minutes"]), captureEvents: Number(args.capture) },
  measured,
  notes,
};
if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
for (const n of notes) console.error(`note: ${n}`);
process.exit(report(measured, limits));

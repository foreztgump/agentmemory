// TEE-1167 AC3: does the agentmemory worker's memory grow with the number of
// lessons? Saves --base synthetic lessons through POST /agentmemory/lessons,
// runs a recall workload, samples memory, then grows the store to --factor x
// --base lessons and samples again. Run it once per backend on a fresh stack.
//
//   node --import tsx bench/fork/lessons/memory-growth.ts --url http://127.0.0.1:13167 --container tee1167-agentmemory-1 --base 600 [--factor 10]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { mulberry32 } from "../lib/stats.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    container: { type: "string" },
    secret: { type: "string", default: "stack-dummy-secret" },
    base: { type: "string" },
    factor: { type: "string", default: "10" },
    recalls: { type: "string", default: "200" },
    settle: { type: "string", default: "20" },
  },
});
if (!args.url || !args.container || !args.base) throw new Error("--url, --container and --base are required");
const base = Number(args.base);
const factor = Number(args.factor);

const rand = mulberry32(1167);
const SYL = ["ka", "vo", "mi", "ru", "te", "so", "la", "pe", "zu", "ni", "do", "fa", "gi", "bo", "ye", "wu"];
const word = () => Array.from({ length: 3 }, () => SYL[Math.floor(rand() * SYL.length)]).join("");
const vocab = Array.from({ length: 3000 }, word);
const sentence = (n: number) => Array.from({ length: n }, () => vocab[Math.floor(rand() ** 2 * vocab.length)]).join(" ");

async function call(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${args.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.secret}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

let saved = 0;
async function saveUntil(total: number): Promise<void> {
  const projects = ["alpha", "beta", "gamma", "delta"];
  while (saved < total) {
    const batch = Array.from({ length: Math.min(16, total - saved) }, () =>
      call("/agentmemory/lessons", { content: `lesson ${saved++} ${sentence(18 + Math.floor(rand() * 30))}`, context: sentence(10), confidence: 0.2 + rand() * 0.8, project: projects[Math.floor(rand() * 4)], tags: [word()] }),
    );
    await Promise.all(batch);
  }
}

async function recalls(n: number): Promise<number> {
  let found = 0;
  for (let i = 0; i < n; i++) {
    const r = (await call("/agentmemory/lessons/search", { query: `${vocab[Math.floor(rand() * 300)]} ${vocab[Math.floor(rand() * 3000)]}`, limit: 10 })) as { lessons?: unknown[] };
    found += r.lessons?.length ?? 0;
  }
  return found;
}

function sample() {
  const sh = (cmd: string) => execFileSync("docker", ["exec", args.container!, "sh", "-c", cmd], { encoding: "utf8" });
  const procs = sh("for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); r=$(awk '/VmRSS/{print $2}' $p/status 2>/dev/null); [ -n \"$r\" ] && echo \"$r|$c\"; done")
    .trim().split("\n").map((l) => { const [kb, cmd] = [l.slice(0, l.indexOf("|")), l.slice(l.indexOf("|") + 1)]; return { mib: Number(kb) / 1024, cmd }; });
  const pick = (re: RegExp) => +procs.filter((p) => re.test(p.cmd)).reduce((n, p) => n + p.mib, 0).toFixed(1);
  const anon = Number(/^anon (\d+)$/m.exec(sh("cat /sys/fs/cgroup/memory.stat"))?.[1] ?? 0) / 2 ** 20;
  const pid = sh("for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '^node [^ ]*dist/index.mjs' && basename $p; done; true").trim().split("\n")[0];
  const heap = JSON.parse(execFileSync("docker", ["exec", "-i", args.container!, "node", "-", pid!], { input: readFileSync(new URL("../lib/heap-after-gc.mjs", import.meta.url)), encoding: "utf8" })) as { heapUsedBytes: number };
  return {
    agentmemoryHeapAfterGcMiB: +(heap.heapUsedBytes / 2 ** 20).toFixed(1),
    agentmemoryWorkerRssMiB: pick(/dist\/index\.mjs/),
    amSearchRssMiB: pick(/fork\/worker\/main\.mjs/),
    containerAnonMiB: +anon.toFixed(1),
  };
}

const settle = () => new Promise((r) => setTimeout(r, Number(args.settle) * 1000));

// Warm-up: one full round at the base size, so the first sample is not a cold worker.
await saveUntil(base);
await recalls(Number(args.recalls));
const steps = [1, 2.5, 5, factor].filter((m, i, xs) => m <= factor && xs.indexOf(m) === i);
const series: Array<{ lessons: number; recallHits: number } & ReturnType<typeof sample>> = [];
for (const m of steps) {
  await saveUntil(Math.round(base * m));
  const recallHits = await recalls(Number(args.recalls));
  await settle();
  series.push({ lessons: saved, recallHits, ...sample() });
}
const first = series[0]!;
const last = series[series.length - 1]!;
console.log(JSON.stringify({
  series,
  deltaHeapAfterGcMiB: +(last.agentmemoryHeapAfterGcMiB - first.agentmemoryHeapAfterGcMiB).toFixed(1),
  deltaWorkerMiB: +(last.agentmemoryWorkerRssMiB - first.agentmemoryWorkerRssMiB).toFixed(1),
  deltaAmSearchMiB: +(last.amSearchRssMiB - first.amSearchRssMiB).toFixed(1),
  deltaAnonMiB: +(last.containerAnonMiB - first.containerAnonMiB).toFixed(1),
}, null, 1));

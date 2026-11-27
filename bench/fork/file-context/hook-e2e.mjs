// Pre-tool-use hook end to end (TEE-1191): spawns the built hook once per file, as Claude Code does on a Read,
// and times spawn to exit. Runs inside the agentmemory container, so the hook reaches the server on loopback:
//
//   docker cp bench/fork/file-context/hook-e2e.mjs <container>:/tmp/ && docker cp files.json <container>:/tmp/
//   docker exec -w /opt/agentmemory <container> node /tmp/hook-e2e.mjs /tmp/files.json [project]
//
// files.json is a JSON array of paths. Also times POST /agentmemory/enrich alone with the same payload.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [filesPath, project = "replica"] = process.argv.slice(2);
const files = JSON.parse(readFileSync(filesPath, "utf8"));
const env = {
  ...process.env,
  AGENTMEMORY_INJECT_CONTEXT: "true",
  AGENTMEMORY_URL: "http://localhost:3111",
  AGENTMEMORY_SECRET: process.env.AGENTMEMORY_SECRET ?? "replica-dummy-secret",
  AGENTMEMORY_ENRICH_TIMEOUT_MS: "60000",
};

function runHook(file) {
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file }, session_id: "tee1191-bench", project });
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["dist/hooks/pre-tool-use.mjs"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", () => resolve({ ms: performance.now() - started, injected: out.length > 0 }));
    child.stdin.end(payload);
  });
}

async function enrich(file) {
  const started = performance.now();
  const res = await fetch("http://localhost:3111/agentmemory/enrich", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.AGENTMEMORY_SECRET}` },
    body: JSON.stringify({ sessionId: "tee1191-bench", files: [file], toolName: "Read", project }),
  });
  await res.text();
  return performance.now() - started;
}

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const summary = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), p99: q(xs, 0.99), max: Math.max(...xs) });

await runHook(files[0]);
const hook = [];
let injected = 0;
for (const f of files) {
  const r = await runHook(f);
  hook.push(r.ms);
  if (r.injected) injected++;
}
const enrichMs = [];
for (const f of files) enrichMs.push(await enrich(f));
console.log(JSON.stringify({ hook: summary(hook), injected, enrich: summary(enrichMs) }, null, 1));

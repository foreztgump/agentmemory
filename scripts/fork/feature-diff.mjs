#!/usr/bin/env node
// Calls each feature TEE-1160 converted against a running agentmemory and prints one
// normalized JSON line per call, so the output of an old and a new image on the same
// restored store can be diffed. Run it inside the replica's client container:
//   bench/fork/replica.sh client node scripts/fork/feature-diff.mjs > out.jsonl
// Values the server generates during the run (ISO times and generated ids at or after the
// run start, latencies, uptimes) are replaced with placeholders; everything else is kept.

const base = process.env.AGENTMEMORY_URL ?? "http://agentmemory:3111";
const secret = process.env.AGENTMEMORY_SECRET ?? "replica-dummy-secret";
const mutate = process.argv.includes("--mutate");
const exportOnly = process.argv.includes("--export-pages");
const startMs = Date.now() - 60_000;

const VOLATILE_KEYS = /^(uptime|uptimeSeconds|latencyMs|durationMs|elapsedMs|ms|took|tookMs|eventLoopLagMs|cpuPercent|memory|rss|heapUsed|heapTotal|lastSweepAt|lastPruneAt|cpu|bootId)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function generatedAt(id) {
  const parts = id.split("_");
  if (parts.length < 3) return null;
  const seg = parts[parts.length - 2];
  if (!/^[0-9a-z]{6,10}$/.test(seg)) return null;
  const ms = parseInt(seg, 36);
  return ms > Date.UTC(2020, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

function normalize(value, key = "") {
  if (VOLATILE_KEYS.test(key)) return "<volatile>";
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = normalize(value[k], k);
    return out;
  }
  if (typeof value === "string") {
    if (ISO.test(value) && Date.parse(value) >= startMs) return "<now>";
    const at = generatedAt(value);
    if (at !== null && at >= startMs) return "<new-id>";
  }
  return value;
}

async function call(name, method, path, body) {
  const started = Date.now();
  let status = 0;
  let out;
  try {
    const res = await fetch(`${base}/agentmemory/${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    status = res.status;
    const text = await res.text();
    try {
      out = JSON.parse(text);
    } catch {
      out = { text: text.slice(0, 2000), bytes: text.length };
    }
  } catch (error) {
    out = { error: String(error) };
  }
  process.stdout.write(`${JSON.stringify({ name, status, body: normalize(out) })}\n`);
  process.stderr.write(`feature-diff: ${name} ${status} ${Date.now() - started} ms\n`);
  return out;
}

if (exportOnly) {
  for (let offset = 0; offset < 3400; offset += 100) {
    await call(`export?offset=${offset}`, "GET", `export?maxSessions=100&offset=${offset}`);
  }
} else {
const sessions = await call("sessions", "GET", "sessions");
const list = Array.isArray(sessions?.sessions) ? sessions.sessions : Array.isArray(sessions) ? sessions : [];
const projects = [...new Set(list.map((s) => s.project).filter(Boolean))].slice(0, 3);
const sessionIds = list.slice(0, 3).map((s) => s.id);

await call("status", "GET", "status");
await call("health", "GET", "health");
for (const [i, project] of projects.entries()) {
  await call(`context#${i}`, "POST", "context", { sessionId: "feature-diff", project });
  await call(`profile#${i}`, "GET", `profile?project=${encodeURIComponent(project)}`);
}
for (const [i, id] of sessionIds.entries()) {
  await call(`observations#${i}`, "GET", `observations?sessionId=${encodeURIComponent(id)}`);
}
await call("auto-forget(dryRun)", "POST", "auto-forget", { dryRun: true });
for (const path of ["memories", "audit", "actions", "lessons", "crystals", "semantic", "procedural", "graph/stats", "replay/sessions", "insights", "consolidation/status"]) {
  await call(path, "GET", path);
}
await call("search", "POST", "search", { query: "error handling test", limit: 20 });
await call("smart-search", "POST", "smart-search", { query: "deploy configuration", limit: 20 });
await call("lessons/search", "POST", "lessons/search", { query: "test" });
await call("timeline", "POST", "timeline", { anchor: new Date(Date.UTC(2026, 10, 10)).toISOString() });
await call("diagnostics", "POST", "diagnostics", {});
await call("export", "GET", "export");
await call("reflect", "POST", "reflect", {});
await call("crystals/auto", "POST", "crystals/auto", {});
if (mutate) {
  await call("diagnostics/heal", "POST", "diagnostics/heal", {});
  await call("consolidate", "POST", "consolidate", {});
  await call("auto-forget", "POST", "auto-forget", {});
}
}

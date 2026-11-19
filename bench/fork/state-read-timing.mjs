// Times whole-scope state reads through iii against the running store: state::list_keys (one HKEYS) for
// every scope, and state::list (one HGETALL) for scopes with --list-min..--list-max keys.
// Run it inside the agentmemory container, which has iii-sdk and the engine on 127.0.0.1:
//   docker cp bench/fork/state-read-timing.mjs <container>:/opt/agentmemory/
//   docker exec -w /opt/agentmemory <container> node state-read-timing.mjs [--reps 3] [--list-min 1000] [--list-max 20000] [--skip <regex>]
// Prints one JSON line per scope that was listed, slow or failed. A read that hit the adapter's reply
// timeout shows as "timeout". --skip (default: the point-read-only graph retrieval data, which the app
// never lists) leaves scopes out: a whole read of a multi-million-field hash can OOM a capped Kvrocks.
import { registerWorker } from "iii-sdk";

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const reps = Number(option("reps", "3"));
const listMin = Number(option("list-min", "1000"));
const listMax = Number(option("list-max", "20000"));
const skip = new RegExp(option("skip", "^mem:graph:retrieval-data$"));

// OTel off: its exporter holds on to payloads, and these replies are megabytes each.
const sdk = registerWorker(`ws://127.0.0.1:${process.env.III_ENGINE_PORT || "49134"}`, {
  workerName: `state-read-timing-${process.pid}`,
  namespace: process.env.III_NAMESPACE || "agentmemory",
  otel: { enabled: false },
});

const sizeOf = (result) => (Array.isArray(result) ? result.length : Array.isArray(result?.keys) ? result.keys.length : 0);

async function timed(function_id, payload) {
  const started = performance.now();
  try {
    const result = await sdk.trigger({ function_id, payload });
    return { ms: Math.round(performance.now() - started), size: sizeOf(result) };
  } catch (error) {
    const message = String(error?.message ?? error);
    return { ms: Math.round(performance.now() - started), error: /from Redis: .*timed out/.test(message) ? "timeout" : message.slice(0, 200) };
  }
}

try {
  const groups = await sdk.trigger({ function_id: "state::list_groups", payload: {} });
  const scopes = groups.groups.filter((scope) => !skip.test(scope));
  const rows = [];
  for (const scope of scopes) rows.push({ scope, first: await timed("state::list_keys", { scope }) });
  rows.sort((a, b) => (b.first.size ?? 0) - (a.first.size ?? 0));
  for (const { scope, first } of rows) {
    const keys = first.size ?? 0;
    const out = { scope, keys, list_keys_ms: [first.error ?? first.ms] };
    const listed = keys >= listMin && keys <= listMax;
    if (keys >= listMin) {
      for (let i = 1; i < reps; i++) {
        const again = await timed("state::list_keys", { scope });
        out.list_keys_ms.push(again.error ?? again.ms);
      }
    }
    if (listed) {
      out.list_ms = [];
      for (let i = 0; i < reps; i++) {
        const whole = await timed("state::list", { scope });
        out.list_ms.push(whole.error ?? whole.ms);
      }
    }
    if (keys >= listMin || first.error || first.ms >= 100) console.log(JSON.stringify(out));
  }
  const worst = Math.max(0, ...rows.map((row) => row.first.ms));
  const timeouts = rows.filter((row) => row.first.error === "timeout").length;
  console.log(JSON.stringify({ op: "summary", scopes: rows.length, skipped: groups.groups.length - scopes.length, list_keys_timeouts: timeouts, list_keys_worst_ms: worst }));
} finally {
  await sdk.shutdown();
}

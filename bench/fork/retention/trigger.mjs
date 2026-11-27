// Triggers one iii function from inside the agentmemory container and prints its result as JSON (long results are cut to the third argument's chars; a list reply is replaced by its count).
// The REST routes answer 504 after 180 s, the worker's invocation timeout, while a sweep or a restore goes on; this has no such limit,
// so it returns the function's own result or the error it threw. Copy it into the container first:
//   docker cp bench/fork/retention/trigger.mjs <project>-agentmemory-1:/opt/agentmemory/trigger.mjs
//   docker exec -w /opt/agentmemory <project>-agentmemory-1 node trigger.mjs mem::retention-sweep '{"dryRun":false}'
import { registerWorker } from "iii-sdk";

const [functionId, rawPayload = "{}", rawMax = "6000"] = process.argv.slice(2);
const sdk = registerWorker(process.env.III_ENGINE_URL ?? "ws://127.0.0.1:49134", { workerName: "s12-trigger", namespace: "agentmemory", invocationTimeoutMs: 6 * 3600_000 });
const started = Date.now();
let out;
try {
  const result = await sdk.trigger({ function_id: functionId, payload: JSON.parse(rawPayload), timeoutMs: 6 * 3600_000 });
  const list = Array.isArray(result) ? result : Array.isArray(result?.keys) ? result.keys : null;
  // A list reply (state::list_keys) is reported by its length: the check is how long the call takes, not what it holds.
  out = { ok: true, ms: Date.now() - started, result: list ? { count: list.length } : result };
} catch (err) {
  out = { ok: false, ms: Date.now() - started, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? String(err.stack).split("\n").slice(0, 6) : undefined };
}
const text = JSON.stringify(out);
console.log(text.length > Number(rawMax) ? `${text.slice(0, Number(rawMax))}...(cut, ${text.length} chars)` : text);
process.exit(out.ok ? 0 : 1);

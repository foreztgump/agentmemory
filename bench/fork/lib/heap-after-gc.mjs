// Runs inside a container: `docker exec -i <c> node - <pid> < heap-after-gc.mjs`.
// Opens the inspector of process <pid> (SIGUSR1), forces a full GC and prints
// its V8 heap use in bytes, so a memory comparison sees retained objects, not
// garbage or allocator high water.
const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid must be a positive integer, got "${process.argv[2]}"`);
let targets = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json()).catch(() => []);
if (targets.length > 0) throw new Error(`port 9229 already serves ${targets.length} inspector target(s) before pid ${pid} was signalled; refusing to attribute their heap to it`);
process.kill(pid, "SIGUSR1");
for (let i = 0; i < 50 && targets.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 100));
  targets = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json()).catch(() => []);
}
if (targets.length === 0) throw new Error("inspector did not open");
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${method} got no reply in 30 s`)), 30_000);
  pending.set(++id, (msg) => { clearTimeout(timer); resolve(msg); });
  ws.send(JSON.stringify({ id, method, params }));
});
try {
  const target = await send("Runtime.evaluate", { expression: "process.pid", returnByValue: true });
  if (target.result?.result?.value !== pid) throw new Error(`inspector process does not match pid ${pid}`);
  await send("HeapProfiler.collectGarbage");
  await send("HeapProfiler.collectGarbage");
  const usage = await send("Runtime.getHeapUsage");
  if (usage.error || typeof usage.result?.usedSize !== "number") throw new Error(`Runtime.getHeapUsage failed: ${JSON.stringify(usage.error ?? usage)}`);
  console.log(JSON.stringify({ heapUsedBytes: usage.result.usedSize }));
  ws.send(JSON.stringify({ id: ++id, method: "Runtime.evaluate", params: { expression: "process._debugEnd?.()" } }));
} finally {
  ws.close();
}

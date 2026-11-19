// Runs inside a container: `docker exec -i <c> node - <pid> < heap-after-gc.mjs`.
// Opens the inspector of process <pid> (SIGUSR1), forces a full GC and prints
// its V8 heap use in bytes, so a memory comparison sees retained objects, not
// garbage or allocator high water.
const pid = Number(process.argv[2]);
process.kill(pid, "SIGUSR1");
let targets = [];
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
const send = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send("HeapProfiler.collectGarbage");
await send("HeapProfiler.collectGarbage");
const usage = await send("Runtime.getHeapUsage");
console.log(JSON.stringify({ heapUsedBytes: usage.result.usedSize }));
ws.close();

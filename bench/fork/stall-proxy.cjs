// Kvrocks proxy that holds every reply for STALL_MS about once every STALL_EVERY_MS, as a host stall does, so the
// iii redis adapter's 500 ms reply timeout fires on reads and writes alike (TEE-1202). Requests pass at once; replies
// queue during a stall and flush in order. To use it on a replica: `docker network disconnect <p>_replica <p>-kvrocks-1`,
// `docker network connect --alias kvrocks-real <p>_replica <p>-kvrocks-1`, then run this file with node in a container on
// <p>_replica with `--network-alias kvrocks` and UP_HOST=<p>-kvrocks-1, and (re)start agentmemory.
const net = require("net");
const UP_HOST = process.env.UP_HOST || "kvrocks";
const UP_PORT = Number(process.env.UP_PORT || 6666);
const STALL_MS = Number(process.env.STALL_MS || 700);
const STALL_EVERY_MS = Number(process.env.STALL_EVERY_MS || 20000);
let stalled = false;
let stalls = 0;
const waiting = new Set();
function scheduleStall() {
  setTimeout(() => {
    stalled = true;
    stalls++;
    setTimeout(() => {
      stalled = false;
      for (const flush of waiting) flush();
      waiting.clear();
      scheduleStall();
    }, STALL_MS);
  }, STALL_EVERY_MS * (0.5 + Math.random()));
}
scheduleStall();
setInterval(() => console.log(JSON.stringify({ at: new Date().toISOString(), stalls })), 60_000);
net.createServer((client) => {
  const up = net.connect(UP_PORT, UP_HOST);
  const queue = [];
  const flush = () => { while (queue.length) client.write(queue.shift()); };
  client.on("data", (d) => up.write(d));
  up.on("data", (d) => {
    if (stalled || queue.length) { queue.push(d); waiting.add(flush); } else client.write(d);
  });
  const close = () => { client.destroy(); up.destroy(); };
  client.on("error", close); up.on("error", close); client.on("close", close); up.on("close", close);
}).listen(6666, () => console.log(`stall proxy -> ${UP_HOST}:${UP_PORT}, ${STALL_MS} ms every ~${STALL_EVERY_MS} ms`));

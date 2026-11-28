// Kvrocks proxy that holds every reply for STALL_MS about once every STALL_EVERY_MS, as a host stall does, so the
// iii redis adapter's 500 ms reply timeout fires on reads and writes alike (TEE-1202). Requests pass at once; replies
// queue during a stall and flush in order. Run it on the replica network with the alias `kvrocks` after re-attaching
// Kvrocks under another alias; docs/fork/kvrocks.md has the steps.
const net = require("net");
const UP_HOST = process.env.UP_HOST || "kvrocks";
const UP_PORT = Number(process.env.UP_PORT || 6666);
const STALL_MS = Number(process.env.STALL_MS || 700);
const STALL_EVERY_MS = Number(process.env.STALL_EVERY_MS || 5000);
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

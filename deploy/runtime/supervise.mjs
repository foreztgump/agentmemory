// Runs `iii compose` and exits non-zero once the agentmemory worker has not
// served /agentmemory/livez for the worker-ready wait. Compose marks a worker
// that spent its restart budget as failed but keeps the engine up, so without
// this the container stays "running" while every route returns 404 and the
// container restart policy never fires.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: supervise.mjs <command> [args...]");
  process.exit(2);
}

const readyWaitMs = Number(process.env.AGENTMEMORY_READY_TIMEOUT_MS || 300000);
if (!Number.isInteger(readyWaitMs) || readyWaitMs < 1 || readyWaitMs > 3600000) {
  console.error("AGENTMEMORY_READY_TIMEOUT_MS must be an integer from 1 through 3600000");
  process.exit(1);
}
const livezUrl = `http://127.0.0.1:${process.env.III_REST_PORT || "3111"}/agentmemory/livez`;
const probeEveryMs = Math.min(5000, Math.max(250, Math.floor(readyWaitMs / 4)));
const forceKillAfterMs = 30000;

console.log(`[supervise] agentmemory worker-ready wait: ${readyWaitMs} ms (AGENTMEMORY_READY_TIMEOUT_MS)`);

const child = spawn(command, args, { stdio: "inherit" });
let exitCode = null;
let lastServingAt = Date.now();

child.on("exit", (code, signal) => {
  process.exit(exitCode ?? code ?? (signal ? 1 : 0));
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    exitCode ??= 0;
    child.kill(signal);
  });
}

const probe = setInterval(async () => {
  try {
    const response = await fetch(livezUrl, { signal: AbortSignal.timeout(probeEveryMs) });
    if (response.ok) lastServingAt = Date.now();
  } catch {}
  const silentMs = Date.now() - lastServingAt;
  if (silentMs <= readyWaitMs || exitCode !== null) return;
  console.error(
    `[supervise] agentmemory worker has not served ${livezUrl} for ${silentMs} ms ` +
      `(wait ${readyWaitMs} ms); stopping so the container restarts`,
  );
  exitCode = 1;
  clearInterval(probe);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), forceKillAfterMs).unref();
}, probeEveryMs);

// Runs `iii compose` and exits non-zero once the agentmemory worker has not
// served /agentmemory/livez for the worker-ready wait. Compose marks a worker
// that spent its restart budget as failed but keeps the engine up, so without
// this the container stays "running" while every route returns 404 and the
// container restart policy never fires.
//
// It also copies every worker's stderr (a V8 heap abort, an uncaught error)
// from the log files compose keeps under III_COMPOSE_STATE_DIR to its own
// stderr, so a worker crash shows in `docker logs`. Stdout stays in the files:
// it logs every captured observation.
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: supervise.mjs <command> [args...]");
  process.exit(2);
}

const readyWait = process.env.AGENTMEMORY_READY_TIMEOUT_MS ?? "300000";
const readyWaitMs = Number(readyWait);
if (!/^[0-9]+$/.test(readyWait) || readyWait !== readyWait.trim() || readyWaitMs < 1 || readyWaitMs > 3600000) {
  console.error("AGENTMEMORY_READY_TIMEOUT_MS must be an integer from 1 through 3600000");
  process.exit(1);
}
const livezUrl = `http://127.0.0.1:${process.env.III_REST_PORT || "3111"}/agentmemory/livez`;
const probeEveryMs = Math.min(5000, Math.max(250, Math.floor(readyWaitMs / 4)));
const forceKillAfterMs = 30000;

console.log(`[supervise] agentmemory worker-ready wait: ${readyWaitMs} ms (AGENTMEMORY_READY_TIMEOUT_MS)`);

const stateDir = process.env.III_COMPOSE_STATE_DIR;
const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
// Compose writes <state dir>/<project>/<namespace>/logs/<worker>.log and
// rotates it to <worker>.log.1, so only *.log is the live file.
const workerLogFiles = () =>
  listDir(stateDir).flatMap((project) =>
    listDir(join(stateDir, project)).flatMap((namespace) => {
      const logs = join(stateDir, project, namespace, "logs");
      return listDir(logs).filter((name) => name.endsWith(".log")).map((name) => join(logs, name));
    }),
  );
const followers = new Map();
const followLog = (file, fromByte) => {
  const worker = basename(file, ".log");
  const tail = spawn("tail", ["-c", `+${fromByte + 1}`, "-F", file], { stdio: ["ignore", "pipe", "ignore"] });
  tail.on("error", (error) => console.error(`[supervise] could not follow ${file}: ${error.message}`));
  createInterface({ input: tail.stdout }).on("line", (line) => {
    if (line.startsWith("stderr\t")) process.stderr.write(`[${worker}] ${line.slice(7)}\n`);
  });
  followers.set(file, tail);
};
const followNewLogs = () => {
  for (const file of workerLogFiles()) if (!followers.has(file)) followLog(file, 0);
};
if (stateDir) {
  // Lines already in the files came from an earlier container start.
  for (const file of workerLogFiles()) {
    // A file rotated away between the listing and this read is picked up by the scan below.
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat) followLog(file, stat.size);
  }
  setInterval(followNewLogs, 1000).unref();
}
process.on("exit", () => {
  for (const tail of followers.values()) tail.kill();
});

const child = spawn(command, args, { stdio: "inherit" });
let exitCode = null;
let lastServingAt = Date.now();
let hasServed = false;
const probeErrors = new Set();

child.on("error", (error) => {
  console.error(`[supervise] could not start ${command}: ${error.message}`);
  process.exit(1);
});
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
    if (response.ok) {
      hasServed = true;
      lastServingAt = Date.now();
    }
  } catch (error) {
    if (error.name !== "TimeoutError" && error.name !== "AbortError") {
      const message = error.message;
      if (!probeErrors.has(message)) {
        probeErrors.add(message);
        console.error(`[supervise] livez probe error: ${message}`);
      }
    }
  }
  const silentMs = Date.now() - lastServingAt;
  const waitMs = hasServed ? readyWaitMs : readyWaitMs * 2;
  if (silentMs <= waitMs || exitCode !== null) return;
  console.error(
    `[supervise] agentmemory worker has not served ${livezUrl} for ${silentMs} ms ` +
      `(wait ${waitMs} ms); stopping so the container restarts`,
  );
  exitCode = 1;
  clearInterval(probe);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), forceKillAfterMs).unref();
}, probeEveryMs);

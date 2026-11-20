import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const supervise = "deploy/runtime/supervise.mjs";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function run(childScript: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [supervise, process.execPath, "-e", childScript], {
    env: { PATH: process.env.PATH, ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const startedAt = Date.now();
  return new Promise<{ code: number | null; output: string; elapsedMs: number }>((resolve) => {
    child.on("exit", (code) => resolve({ code, output, elapsedMs: Date.now() - startedAt }));
  });
}

const workerThatStopsServing = (port: number, serveMs: number) => `
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === "/agentmemory/livez" ? 200 : 404;
    res.end();
  }).listen(${port}, "127.0.0.1");
  setTimeout(() => server.close(), ${serveMs});
  setInterval(() => {}, 1000);
`;

describe("deploy supervisor", () => {
  it("logs the configured worker-ready wait", async () => {
    const result = await run("process.exit(0)", { AGENTMEMORY_READY_TIMEOUT_MS: "4321" });
    expect(result.output).toContain("worker-ready wait: 4321 ms");
    expect(result.code).toBe(0);
  });

  it("exits non-zero after the worker stops serving for the ready wait", async () => {
    const port = await freePort();
    const result = await run(workerThatStopsServing(port, 1500), {
      AGENTMEMORY_READY_TIMEOUT_MS: "1000",
      III_REST_PORT: String(port),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("has not served");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2500);
    expect(result.elapsedMs).toBeLessThan(8000);
  }, 15000);

  it("keeps running while the worker serves", async () => {
    const port = await freePort();
    const result = await run(
      workerThatStopsServing(port, 60000).replace("setInterval(() => {}, 1000);", "setTimeout(() => process.exit(0), 3000);"),
      { AGENTMEMORY_READY_TIMEOUT_MS: "1000", III_REST_PORT: String(port) },
    );
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("has not served");
  }, 15000);

  it("passes through the compose exit code", async () => {
    const result = await run("process.exit(3)", { AGENTMEMORY_READY_TIMEOUT_MS: "60000" });
    expect(result.code).toBe(3);
  });

  it("gives a worker that has not served yet twice the ready wait, since compose starts its timer after state and http", async () => {
    const port = await freePort();
    const lateWorker = `
      const http = require("node:http");
      setTimeout(() => {
        http.createServer((req, res) => {
          res.statusCode = req.url === "/agentmemory/livez" ? 200 : 404;
          res.end();
        }).listen(${port}, "127.0.0.1");
      }, 1500);
      setTimeout(() => process.exit(0), 4000);
    `;
    const result = await run(lateWorker, { AGENTMEMORY_READY_TIMEOUT_MS: "1000", III_REST_PORT: String(port) });
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("has not served");
  }, 15000);

  it("exits non-zero when the worker never serves within twice the ready wait", async () => {
    const port = await freePort();
    const result = await run("setInterval(() => {}, 1000);", {
      AGENTMEMORY_READY_TIMEOUT_MS: "1000",
      III_REST_PORT: String(port),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("has not served");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(result.elapsedMs).toBeLessThan(8000);
  }, 15000);

  it("exits non-zero with a clear message when the command cannot start", async () => {
    const child = spawn(process.execPath, [supervise, "/nonexistent/iii", "compose"], {
      env: { PATH: process.env.PATH, AGENTMEMORY_READY_TIMEOUT_MS: "60000" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(output).toContain("[supervise] could not start /nonexistent/iii");
    expect(output).not.toContain("Unhandled 'error' event");
  });

  it("copies each worker's new stderr lines to its own stderr, across a log rotation and a worker that starts later", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "supervise-logs-"));
    const logs = join(stateDir, "data-1234", "agentmemory", "logs");
    mkdirSync(logs, { recursive: true });
    const header = "# iii-compose-worker-log-v1 0000\n";
    writeFileSync(join(logs, "agentmemory.log"), `${header}stderr\tfrom an earlier boot\n`);
    const compose = `
      const fs = require("node:fs");
      const logs = ${JSON.stringify(logs)};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      (async () => {
        await wait(500);
        fs.appendFileSync(logs + "/agentmemory.log", "stdout\\tObservation captured\\nstderr\\tFATAL ERROR: JavaScript heap out of memory\\n");
        await wait(500);
        fs.renameSync(logs + "/agentmemory.log", logs + "/agentmemory.log.1");
        fs.writeFileSync(logs + "/agentmemory.log", ${JSON.stringify(header)} + "stderr\\tafter the rotation\\n");
        fs.writeFileSync(logs + "/am-search.log", ${JSON.stringify(header)} + "stderr\\tam-search failed\\n");
        await wait(2500);
        process.exit(0);
      })();
    `;
    try {
      const result = await run(compose, { AGENTMEMORY_READY_TIMEOUT_MS: "60000", III_COMPOSE_STATE_DIR: stateDir });
      expect(result.code).toBe(0);
      const copied = result.output.split("\n").filter((line) => /^\[(agentmemory|am-search)\] /.test(line));
      expect(copied.sort()).toEqual([
        "[agentmemory] FATAL ERROR: JavaScript heap out of memory",
        "[agentmemory] after the rotation",
        "[am-search] am-search failed",
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15000);

  it("starts compose when a listed worker log is gone before it can be read", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "supervise-logs-"));
    const logs = join(stateDir, "data-1234", "agentmemory", "logs");
    mkdirSync(logs, { recursive: true });
    symlinkSync(join(logs, "rotated-away"), join(logs, "agentmemory.log"));
    try {
      const result = await run("process.exit(0)", { AGENTMEMORY_READY_TIMEOUT_MS: "60000", III_COMPOSE_STATE_DIR: stateDir });
      expect(result.output).not.toContain("ENOENT");
      expect(result.code).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["0x10", "12e3", " 1000", "1000.0"])("rejects the non-decimal ready wait %j, which compose cannot parse", async (value) => {
    const result = await run("process.exit(0)", { AGENTMEMORY_READY_TIMEOUT_MS: value });
    expect(result.code).toBe(1);
    expect(result.output).toContain("AGENTMEMORY_READY_TIMEOUT_MS must be an integer");
  });

  it.each(["0", "abc", "3600001"])("rejects a ready wait of %s", async (value) => {
    const result = await run("process.exit(0)", { AGENTMEMORY_READY_TIMEOUT_MS: value });
    expect(result.code).toBe(1);
    expect(result.output).toContain("AGENTMEMORY_READY_TIMEOUT_MS must be an integer");
  });
});

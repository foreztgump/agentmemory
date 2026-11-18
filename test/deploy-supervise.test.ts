import { spawn } from "node:child_process";
import { createServer } from "node:net";
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

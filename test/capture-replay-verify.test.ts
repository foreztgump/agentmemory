import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureKey } from "../src/functions/capture.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT = "bench-replay";

/**
 * A stand-in server that acknowledges every capture, then dead-letters the first acknowledged one
 * and stores the rest, the way a server that lost an acknowledged capture would answer.
 */
function lossyServer(): Server {
  const acked: Array<{ eventId: string; sessionId: string }> = [];
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/agentmemory/observe") {
        const capture = JSON.parse(body) as { eventId: string; sessionId: string };
        acked.push({ eventId: capture.eventId, sessionId: capture.sessionId });
        return json(202, { status: "accepted", state: "pending" });
      }
      if (url.pathname === "/agentmemory/session/start") return json(200, { success: true });
      if (url.pathname === "/agentmemory/capture" && url.searchParams.get("status") === "dead") {
        const [lost] = acked;
        return json(200, { items: lost ? [{ key: captureKey(PROJECT, lost.sessionId, lost.eventId), eventId: lost.eventId, lastError: "boom" }] : [] });
      }
      if (url.pathname === "/agentmemory/capture") return json(200, { capture: { inbox: { pending: 0, retrying: 0, dead: 1 } } });
      if (url.pathname === "/agentmemory/observations") {
        const sessionId = url.searchParams.get("sessionId");
        const observations = acked
          .slice(1)
          .filter((a) => a.sessionId === sessionId)
          .map((a) => ({ captureKey: captureKey(PROJECT, a.sessionId, a.eventId) }));
        return json(200, { observations });
      }
      json(404, {});
    });
  });
}

type Report = { verify?: { exactlyOnce: boolean; deadLettered: number } } | null;

function replay(port: number, extra: string[]): Promise<{ code: number; report: Report }> {
  const args = [
    "--import", "tsx", "bench/fork/capture-replay.ts",
    "--url", `http://127.0.0.1:${port}`, "--sessions", "1", "--captures", "3", "--concurrency", "1", "--burst", "1",
    "--verify", "--drain-timeout-s", "5", ...extra,
  ];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT, env: { ...process.env, AGENTMEMORY_SECRET: "" } }, (error, stdout) => {
      const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
      try {
        resolve({ code, report: JSON.parse(stdout.slice(stdout.indexOf("{"))) as Report });
      } catch {
        resolve({ code, report: null });
      }
    });
  });
}

describe("capture replay verify", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = lossyServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("fails when an acknowledged capture was dead-lettered", async () => {
    const { code, report } = await replay(port, []);
    expect(report?.verify).toMatchObject({ exactlyOnce: false, deadLettered: 1 });
    expect(code).toBe(1);
  }, 60_000);

  it("passes a dead-lettered acknowledged capture with --allow-dead-letter", async () => {
    const { code, report } = await replay(port, ["--allow-dead-letter"]);
    expect(report?.verify).toMatchObject({ exactlyOnce: true, deadLettered: 1 });
    expect(code).toBe(0);
  }, 60_000);
});

// TEE-1167: the AC3 bench reads a worker's heap through its inspector on port
// 9229. It must never attribute another process's heap to the worker, and it
// must leave the worker's inspector closed.
import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../bench/fork/lib/heap-after-gc.mjs", import.meta.url));
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listTargets = () => fetch("http://127.0.0.1:9229/json/list").then((r) => r.json() as Promise<unknown[]>).catch(() => null);

function idle(...flags: string[]): ChildProcess {
  const child = spawn(process.execPath, [...flags, "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

function run(pid: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, String(pid)], { timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error("condition not met in 5 s");
}

const portFree = async () => (await listTargets()) === null;

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await until(portFree);
});

describe.skipIf(!(await portFree()))("heap-after-gc", { timeout: 30_000 }, () => {
  it("refuses to run when port 9229 already serves an inspector", async () => {
    idle("--inspect=127.0.0.1:9229");
    await until(async () => ((await listTargets())?.length ?? 0) > 0);
    const worker = idle();

    const result = await run(worker.pid!);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/9229 already serves/);
  });

  it("reads the signalled process's heap and closes its inspector afterwards", async () => {
    const worker = idle();
    await sleep(200);

    const result = await run(worker.pid!);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).heapUsedBytes).toBeGreaterThan(0);
    await until(portFree);
  });
});

describe("memory-growth worker RSS", () => {
  const agentmemory = { mib: 200, cmd: "node /app/dist/index.mjs " };
  const amSearch = { mib: 210, cmd: "node /app/dist/fork/worker/main.mjs " };

  it("fails a disk-mode sample when the am-search worker is missing", async () => {
    const { workerRss } = await import("../bench/fork/lessons/lib.js");
    expect(() => workerRss([agentmemory], "c1", true)).toThrow(/no process in c1 matches .*main/);
    expect(workerRss([agentmemory, amSearch], "c1", true)).toEqual({ agentmemoryWorkerRssMiB: 200, amSearchRssMiB: 210 });
  });

  it("reports no am-search sample in memory mode, which runs no am-search worker", async () => {
    const { workerRss } = await import("../bench/fork/lessons/lib.js");
    expect(workerRss([agentmemory], "c1", false)).toEqual({ agentmemoryWorkerRssMiB: 200, amSearchRssMiB: null });
  });
});

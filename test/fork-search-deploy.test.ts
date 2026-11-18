import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderWorkerCompose } from "../src/cli/compose-project.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runEntrypoint(env: Record<string, string>): { status: "ok"; compose: any } | { status: "failed"; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "am-search-deploy-"));
  roots.push(root);
  mkdirSync(join(root, "config"));
  const program = readFileSync("deploy/runtime/entrypoint.sh", "utf8").split("node <<'NODE'\n")[1]!.split("\nNODE")[0]!
    .replace('"/opt/agentmemory/worker-compose.yaml"', JSON.stringify(resolve("deploy/runtime/worker-compose.yaml")))
    .replace('"/opt/agentmemory/am-search.worker-compose.yaml"', JSON.stringify(resolve("deploy/runtime/am-search.worker-compose.yaml")))
    .replace('"/opt/agentmemory/node_modules/yaml"', JSON.stringify(require.resolve("yaml")))
    .replaceAll(/fs\.chownSync\([^;]+\);/g, "");
  try {
    execFileSync(process.execPath, ["-e", program], {
      env: { PATH: process.env.PATH, AGENTMEMORY_DATA_DIR: root, REST_ALLOWED_ORIGINS: "http://localhost:3111", ...env },
      stdio: "pipe",
    });
  } catch (error) {
    return { status: "failed", stderr: String((error as { stderr?: Buffer }).stderr) };
  }
  return { status: "ok", compose: parse(readFileSync(join(root, "worker-compose.runtime.yaml"), "utf8")) };
}

describe("am-search worker in the Docker runtime", () => {
  it("is not started in memory mode", () => {
    for (const backend of [undefined, "memory", " memory "]) {
      const result = runEntrypoint(backend ? { AM_SEARCH_BACKEND: backend } : {});
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.compose.containers["am-search"]).toBeUndefined();
    }
  });

  it("starts beside agentmemory in disk mode with the Qdrant settings", () => {
    const result = runEntrypoint({ AM_SEARCH_BACKEND: "disk", AM_QDRANT_URL: "http://qdrant:6333", AGENTMEMORY_STATE_BACKEND: "redis", AGENTMEMORY_REDIS_URL: "redis://valkey:6379" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const worker = result.compose.containers["am-search"];
    expect(worker.scripts.run).toBe("node /opt/agentmemory/dist/fork/worker/main.mjs");
    expect(worker.start_after).toEqual(["state"]);
    expect(worker.environment).toMatchObject({ AM_QDRANT_URL: "${AM_QDRANT_URL:-}", AM_QDRANT_API_KEY: "${AM_QDRANT_API_KEY:-}" });
    expect(result.compose.containers.agentmemory.environment.AM_SEARCH_BACKEND).toBe("${AM_SEARCH_BACKEND:-}");
    expect(result.compose.containers.state.config_override.adapter.name).toBe("redis");
  });

  it.each([undefined, "", "  ", "\t\n"])("refuses disk mode with Qdrant URL %j", (url) => {
    const result = runEntrypoint({ AM_SEARCH_BACKEND: " disk ", ...(url === undefined ? {} : { AM_QDRANT_URL: url }) });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.stderr).toContain("AM_QDRANT_URL");
  });

  it.each(["qdrant", " disks ", "", "  "])("refuses unknown backend %j", (backend) => {
    const result = runEntrypoint({ AM_SEARCH_BACKEND: backend });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.stderr).toContain("AM_SEARCH_BACKEND must be memory or disk");
      expect(result.stderr).not.toContain("AM_QDRANT_URL");
    }
  });
});

describe("am-search worker in the generated worker compose", () => {
  const options = (workerEnvironment: Record<string, string>) => ({
    ports: { restPort: 3511, viewerPort: 3513, enginePort: 49534 },
    dataDir: "/tmp/am/data",
    projectRoot: "/tmp/am/pkg",
    nodeBin: "/opt/node/bin/node",
    homeDir: "/tmp/am/home",
    linux: true,
    windows: false,
    workerEnvironment,
  });

  it("adds the worker only in disk mode and passes it the search settings", () => {
    expect(parse(renderWorkerCompose(options({}))).containers["am-search"]).toBeUndefined();
    const compose = parse(renderWorkerCompose(options({ AM_SEARCH_BACKEND: "disk", AM_QDRANT_URL: "http://127.0.0.1:6333", OPENAI_API_KEY: "sk-test" })));
    expect(compose.containers.agentmemory.environment.AM_SEARCH_BACKEND).toBe("disk");
    expect(compose.containers["am-search"].scripts.run).toBe("'/opt/node/bin/node' 'dist/fork/worker/main.mjs'");
    expect(compose.containers["am-search"].environment).toMatchObject({ AM_SEARCH_BACKEND: "disk", AM_QDRANT_URL: "http://127.0.0.1:6333", III_ENGINE_PORT: "49534", III_TELEMETRY_ENABLED: "false", MALLOC_ARENA_MAX: "2" });
    expect(compose.containers["am-search"].environment.OPENAI_API_KEY).toBeUndefined();
  });

  it("omits the Linux allocator setting on other platforms", () => {
    const compose = parse(renderWorkerCompose({ ...options({ AM_SEARCH_BACKEND: "disk", AM_QDRANT_URL: "http://127.0.0.1:6333" }), linux: false }));
    expect(compose.containers["am-search"].environment.III_TELEMETRY_ENABLED).toBe("false");
    expect(compose.containers["am-search"].environment.MALLOC_ARENA_MAX).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const load = (file: string) => parse(readFileSync(`deploy/coolify/${file}`, "utf8")).services;
const main = load("docker-compose.yml");
const buddy = load("docker-compose.buddy.yml");
const buddyOnlyKeys = ["VIEWER_ALLOWED_HOSTS", "VIEWER_ALLOWED_ORIGINS"];

describe("Coolify stacks", () => {
  it("give buddy the same agentmemory settings as main apart from the viewer", () => {
    const strip = (environment: Record<string, string>) =>
      Object.fromEntries(Object.entries(environment).filter(([key]) => !buddyOnlyKeys.includes(key)));
    expect(strip(buddy.agentmemory.environment)).toEqual(strip(main.agentmemory.environment));
    expect(buddy.agentmemory.healthcheck).toEqual(main.agentmemory.healthcheck);
    expect(buddy.valkey).toEqual(main.valkey);
  });

  it.each([["main", main], ["buddy", buddy]])("%s forwards the fork settings with production defaults", (_, services) => {
    expect(services.agentmemory.environment).toMatchObject({
      EMBEDDING_PROVIDER: "${EMBEDDING_PROVIDER:-voyage}",
      AGENTMEMORY_LLM_PROVIDER: "${AGENTMEMORY_LLM_PROVIDER:-anthropic}",
      VOYAGE_MODEL: "${VOYAGE_MODEL:-voyage-code-4}",
      VOYAGE_OUTPUT_DIMENSION: "${VOYAGE_OUTPUT_DIMENSION:-1024}",
      AGENTMEMORY_READY_TIMEOUT_MS: "${AGENTMEMORY_READY_TIMEOUT_MS:-300000}",
    });
    expect(services.agentmemory.restart).toBe("unless-stopped");
    expect(services.agentmemory.healthcheck.test.join(" ")).toContain("/agentmemory/livez");
  });

  it("starts the worker under the configured ready wait", () => {
    const runtime = parse(readFileSync("deploy/runtime/worker-compose.yaml", "utf8"));
    expect(runtime.containers.agentmemory.startup_timeout).toBe("${AGENTMEMORY_READY_TIMEOUT_MS:-300000}ms");
    expect(runtime.containers.agentmemory.environment.VOYAGE_OUTPUT_DIMENSION).toBe("${VOYAGE_OUTPUT_DIMENSION:-}");
  });
});

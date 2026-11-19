import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const load = (file: string) => parse(readFileSync(file, "utf8")).services;
const stacks = [
  ["main", load("deploy/coolify/docker-compose.yml")],
  ["buddy", load("deploy/coolify/docker-compose.buddy.yml")],
] as const;
const replica = load("bench/fork/replica-compose.yml");

const flags = (command: string[]) => Object.fromEntries(
  command.flatMap((arg, i) => (arg.startsWith("--") ? [[arg.slice(2), command[i + 1]]] : [])),
);

describe("fork Kvrocks state store", () => {
  it.each(stacks)("%s keeps records in Kvrocks with a capped cache and a password", (_, services) => {
    expect(services.kvrocks.image).toBe("apache/kvrocks:2.17.0");
    expect(flags(services.kvrocks.command)).toEqual({
      requirepass: "${KVROCKS_PASSWORD:?}",
      "rocksdb.block_cache_size": "384",
      "rocksdb.write_buffer_size": "64",
      "rocksdb.max_write_buffer_number": "2",
      "rocksdb.max_background_jobs": "2",
    });
    expect(services.kvrocks.mem_limit).toBe("${KVROCKS_MEM_LIMIT:-1280m}");
    expect(services.kvrocks.memswap_limit).toBe(services.kvrocks.mem_limit);
    expect(services.kvrocks.volumes).toEqual(["kvrocks-data:/var/lib/kvrocks"]);
    expect(services.agentmemory.environment).toMatchObject({
      AGENTMEMORY_STATE_BACKEND: "redis",
      AGENTMEMORY_REDIS_URL: "redis://:${KVROCKS_PASSWORD:?}@kvrocks:6666",
    });
    expect(services.agentmemory.depends_on).toEqual({ kvrocks: { condition: "service_healthy" } });
    expect(services.valkey.profiles).toEqual(["valkey-source"]);
  });

  it("gives buddy the same Kvrocks and Valkey services as main", () => {
    expect(stacks[1][1].kvrocks).toEqual(stacks[0][1].kvrocks);
    expect(stacks[1][1].valkey).toEqual(stacks[0][1].valkey);
  });

  it("benches the replica on the production Kvrocks settings", () => {
    const prod = flags(stacks[0][1].kvrocks.command);
    const bench = flags(replica.kvrocks.command);
    expect({ ...bench, requirepass: prod.requirepass }).toEqual(prod);
    expect(replica.kvrocks.image).toBe(stacks[0][1].kvrocks.image);
    expect(replica.kvrocks.mem_limit).toBe(stacks[0][1].kvrocks.mem_limit);
  });

  // Kvrocks was proven against the iii state worker's redis adapter (one hash per
  // scope, Lua update scripts; docs/fork/kvrocks.md). A new state worker can change
  // that layout, so bumping it means re-running the replica migration and verify.
  it("pins the state worker the Kvrocks migration was proven with", () => {
    expect(readFileSync("deploy/Dockerfile", "utf8")).toMatch(/^ARG STATE_VERSION=0\.22\.22$/m);
  });
});

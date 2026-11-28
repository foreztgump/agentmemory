import { beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.fn();
vi.mock("../src/logger.js", () => ({
  logger: { info: (...args: unknown[]) => info(...args), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";

function mockSdk(trigger: (input: { function_id: string }) => Promise<unknown>) {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger,
    call: (body: unknown) => functions.get("mcp::tools::call")!({ headers: {}, body }),
  };
}

const kv = { get: async () => null, set: async () => null, delete: async () => {}, list: async () => [] };

function callLines() {
  return info.mock.calls.filter(([msg]) => msg === "MCP tool call").map(([, fields]) => fields as Record<string, unknown>);
}

describe("mcp::tools::call request log", () => {
  beforeEach(() => info.mockReset());

  it("logs one line naming the tool, its status and duration, without arguments or results", async () => {
    const sdk = mockSdk(async () => ({ results: [{ title: "secret result text" }] }));
    registerMcpEndpoints(sdk as never, kv as never);
    const res = await sdk.call({ name: "memory_smart_search", arguments: { query: "private query text", project: "p" } });
    expect(res.status_code).toBe(200);
    const lines = callLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!).sort()).toEqual(["ms", "status", "tool"]);
    expect(lines[0]).toMatchObject({ tool: "memory_smart_search", status: 200 });
    expect(typeof lines[0]!.ms).toBe("number");
    expect(JSON.stringify(info.mock.calls.filter(([m]) => m === "MCP tool call"))).not.toMatch(/private query|secret result/);
  });

  it("logs the status of a failed call", async () => {
    const sdk = mockSdk(async () => { throw new Error("boom"); });
    registerMcpEndpoints(sdk as never, kv as never);
    const res = await sdk.call({ name: "memory_smart_search", arguments: { query: "q" } });
    expect(res.status_code).toBe(500);
    expect(callLines()).toEqual([expect.objectContaining({ tool: "memory_smart_search", status: 500 })]);
  });

  it("does not echo a caller-supplied name that is not a tool", async () => {
    const sdk = mockSdk(async () => ({}));
    registerMcpEndpoints(sdk as never, kv as never);
    const res = await sdk.call({ name: "my api key is hunter2", arguments: {} });
    expect(res.status_code).toBe(400);
    expect(callLines()).toEqual([expect.objectContaining({ tool: "unknown", status: 400 })]);
  });
});

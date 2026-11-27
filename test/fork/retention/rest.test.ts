// Slice 10: the five retention routes. Auth fails closed, every field is whitelisted and typed, and each outcome has its own status.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { collectRestEndpoints } from "../../../scripts/skills/rest-endpoints.js";
import { MAX_REFS } from "../../../src/fork/retention/rest.js";
import { spiedRoutes, type Route } from "./api-fixtures.js";

const ROUTES: readonly Route[] = ["sweep", "restore", "purge", "pin", "report"];
const BODIES: Record<Route, unknown> = {
  sweep: { dryRun: false },
  restore: { runId: "ret_abc_123" },
  purge: { dryRun: false },
  pin: { ref: { kind: "memory", id: "mem_1" }, reason: "runbook" },
  report: undefined,
};
const MEM = { kind: "memory", id: "mem_1" };
const OBS = { kind: "observation", sessionId: "ses_1", id: "obs_1" };

describe("the routes are wired in the upstream trigger file", () => {
  it("api.ts registers the five paths and methods", () => {
    const rows = collectRestEndpoints(readFileSync(new URL("../../../src/triggers/api.ts", import.meta.url), "utf8"));
    expect(rows.filter(({ path }) => path.startsWith("/agentmemory/retention/"))).toEqual([
      { path: "/agentmemory/retention/pin", method: "POST" },
      { path: "/agentmemory/retention/purge", method: "POST" },
      { path: "/agentmemory/retention/report", method: "GET" },
      { path: "/agentmemory/retention/restore", method: "POST" },
      { path: "/agentmemory/retention/sweep", method: "POST" },
    ]);
  });
});

describe("auth fails closed", () => {
  it.each(ROUTES)("%s answers 503 and touches nothing when AGENTMEMORY_SECRET is unset", async (route) => {
    const { call, spies } = spiedRoutes(null);
    for (const token of [null, "anything"]) {
      const reply = await call(route, { body: BODIES[route], token });
      expect(reply.status_code).toBe(503);
      expect(String(reply.body["error"])).toContain("AGENTMEMORY_SECRET");
    }
    expect(spies[route]).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("%s answers 401 to a missing or wrong token", async (route) => {
    const { call, spies } = spiedRoutes();
    for (const token of [null, "wrong", ""]) {
      expect((await call(route, { body: BODIES[route], token })).status_code).toBe(401);
    }
    expect(spies[route]).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("%s runs with the right token", async (route) => {
    const { call, spies } = spiedRoutes();
    expect((await call(route, { body: BODIES[route] })).status_code).toBe(200);
    expect(spies[route]).toHaveBeenCalledTimes(1);
  });
});

describe("sweep and purge pass on dryRun and nothing else", () => {
  it.each(["sweep", "purge"] as const)("%s drops every field it does not know", async (route) => {
    const { call, spies } = spiedRoutes();
    await call(route, { body: { dryRun: false, windowsOverride: { trimDays: 0 }, graceDaysOverride: 0, pauseMs: 0, spillIds: 1, runId: "x" } });
    expect(spies[route].mock.calls[0]![0]).toEqual({ dryRun: false });
  });

  it.each(["sweep", "purge"] as const)("%s dry-runs unless dryRun is exactly false", async (route) => {
    const { call, spies } = spiedRoutes();
    const bodies = [undefined, {}, { dryRun: true }, { dryRun: "false" }, { dryRun: 0 }, { dryRun: null }, { dryRun: [false] }];
    for (const body of bodies) await call(route, { body });
    expect(spies[route].mock.calls.map(([payload]) => payload)).toEqual(bodies.map(() => ({ dryRun: true })));
    await call(route, { body: { dryRun: false } });
    expect(spies[route].mock.calls.at(-1)![0]).toEqual({ dryRun: false });
  });

  it.each(["sweep", "purge"] as const)("%s refuses a body that is not an object", async (route) => {
    const { call, spies } = spiedRoutes();
    for (const body of [[], "false", 7, [{ dryRun: false }]]) expect((await call(route, { body })).status_code).toBe(400);
    expect(spies[route]).not.toHaveBeenCalled();
  });
});

describe("pin validates and whitelists", () => {
  it("passes a ref, a reason and a who, and nothing else", async () => {
    const { call, spies } = spiedRoutes();
    await call("pin", { body: { ref: { ...OBS, extra: 1, row: {} }, reason: "keep", who: "dana", pinnedAt: "2020-01-01", unpin: false } });
    expect(spies.pin.mock.calls[0]![0]).toEqual({ ref: OBS, reason: "keep", who: "dana" });
  });

  it("labels an anonymous pin as coming from the API", async () => {
    const { call, spies } = spiedRoutes();
    await call("pin", { body: { ref: MEM, reason: "keep" } });
    expect(spies.pin.mock.calls[0]![0]).toEqual({ ref: MEM, reason: "keep", who: "api" });
  });

  it("drops a session from a memory ref", async () => {
    const { call, spies } = spiedRoutes();
    await call("pin", { body: { ref: { ...MEM, sessionId: "ses_1" }, reason: "keep" } });
    expect(spies.pin.mock.calls[0]![0]).toMatchObject({ ref: MEM });
  });

  it("unpins with unpin set to exactly true, and needs no reason", async () => {
    const { call, spies } = spiedRoutes();
    expect((await call("pin", { body: { ref: MEM, unpin: true } })).status_code).toBe(200);
    expect(spies.pin.mock.calls[0]![0]).toEqual({ ref: MEM, unpin: true, who: "api" });
  });

  const long = (n: number) => "x".repeat(n);
  it.each([
    ["no ref", { reason: "r" }],
    ["a ref that is a string", { ref: "mem_1", reason: "r" }],
    ["an unknown kind", { ref: { kind: "session", id: "s" }, reason: "r" }],
    ["an observation with no session", { ref: { kind: "observation", id: "obs_1" }, reason: "r" }],
    ["an observation whose session is a number", { ref: { kind: "observation", sessionId: 7, id: "obs_1" }, reason: "r" }],
    ["an empty id", { ref: { kind: "memory", id: "" }, reason: "r" }],
    ["an id that is not a string", { ref: { kind: "memory", id: { $ne: 1 } }, reason: "r" }],
    ["an id over 256 characters", { ref: { kind: "memory", id: long(257) }, reason: "r" }],
    ["a session over 256 characters", { ref: { kind: "observation", sessionId: long(257), id: "o" }, reason: "r" }],
    ["no reason", { ref: MEM }],
    ["an empty reason", { ref: MEM, reason: "  " }],
    ["a reason over 500 characters", { ref: MEM, reason: long(501) }],
    ["a who over 100 characters", { ref: MEM, reason: "r", who: long(101) }],
    ["a who that is not a string", { ref: MEM, reason: "r", who: 5 }],
    ["an unpin that is not a boolean", { ref: MEM, unpin: "true" }],
    ["a body that is a list", [MEM]],
  ])("answers 400 for %s", async (_name, body) => {
    const { call, spies } = spiedRoutes();
    const reply = await call("pin", { body });
    expect(reply.status_code).toBe(400);
    expect(typeof reply.body["error"]).toBe("string");
    expect(spies.pin).not.toHaveBeenCalled();
  });

  it("accepts ids at the limit", async () => {
    const { call } = spiedRoutes();
    expect((await call("pin", { body: { ref: { kind: "memory", id: long(256) }, reason: long(500) } })).status_code).toBe(200);
  });
});

describe("restore takes a run or refs, never both, and bounds the refs", () => {
  it("passes a runId alone", async () => {
    const { call, spies } = spiedRoutes();
    await call("restore", { body: { runId: "ret_abc_123", refs: undefined, extra: 1 } });
    expect(spies.restore.mock.calls[0]![0]).toEqual({ runId: "ret_abc_123" });
  });

  it("passes whitelisted refs", async () => {
    const { call, spies } = spiedRoutes();
    await call("restore", { body: { refs: [{ ...OBS, junk: 1 }, { ...MEM, sessionId: "ses_9" }] } });
    expect(spies.restore.mock.calls[0]![0]).toEqual({ refs: [OBS, MEM] });
  });

  it.each([
    ["neither", {}],
    ["both", { runId: "ret_abc", refs: [MEM] }],
    ["a runId that is not a string", { runId: 4 }],
    ["a runId that is not a run id", { runId: "../../etc" }],
    ["a runId over 100 characters", { runId: `ret_${"a".repeat(100)}` }],
    ["refs that are not a list", { refs: MEM }],
    ["an empty list", { refs: [] }],
    ["a ref that is not valid", { refs: [MEM, { kind: "observation", id: "o" }] }],
    ["too many refs", { refs: Array.from({ length: MAX_REFS + 1 }, (_, i) => ({ kind: "memory", id: `mem_${i}` })) }],
  ])("answers 400 for %s", async (_name, body) => {
    const { call, spies } = spiedRoutes();
    expect((await call("restore", { body })).status_code).toBe(400);
    expect(spies.restore).not.toHaveBeenCalled();
  });

  it("accepts exactly the most refs", async () => {
    const { call, spies } = spiedRoutes();
    const refs = Array.from({ length: MAX_REFS }, (_, i) => ({ kind: "memory", id: `mem_${i}` }));
    expect((await call("restore", { body: { refs } })).status_code).toBe(200);
    expect((spies.restore.mock.calls[0]![0] as { refs: unknown[] }).refs).toHaveLength(MAX_REFS);
  });
});

describe("report reads one run or the latest", () => {
  it("passes runId from the query string, and nothing when it is absent", async () => {
    const { call, spies } = spiedRoutes();
    await call("report", { query: { runId: "ret_abc_123", junk: "1" } });
    await call("report", {});
    expect(spies.report.mock.calls.map(([payload]) => payload)).toEqual([{ runId: "ret_abc_123" }, {}]);
  });

  it("answers 400 to a runId that is not a run id", async () => {
    const { call, spies } = spiedRoutes();
    expect((await call("report", { query: { runId: "x y" } })).status_code).toBe(400);
    expect(spies.report).not.toHaveBeenCalled();
  });
});

describe("each outcome has its own status", () => {
  it.each(["sweep", "purge"] as const)("%s: busy and a lost lease are 409, off is 503 with the reason, done is 200", async (route) => {
    const { call, spies } = spiedRoutes();
    spies[route].mockResolvedValueOnce({ kind: "busy", heldBy: "sweep-1" });
    expect(await call(route, { body: {} })).toMatchObject({ status_code: 409, body: { error: "busy", heldBy: "sweep-1" } });
    spies[route].mockResolvedValueOnce({ kind: "lease-lost" });
    expect(await call(route, { body: {} })).toMatchObject({ status_code: 409, body: { error: "lease-lost" } });
    spies[route].mockResolvedValueOnce({ kind: "off", why: "AM_RETENTION is not enforce" });
    expect(await call(route, { body: {} })).toMatchObject({ status_code: 503, body: { error: "retention is off", why: "AM_RETENTION is not enforce" } });
    spies[route].mockResolvedValueOnce({ kind: "done", runId: "ret_1" });
    expect(await call(route, { body: {} })).toMatchObject({ status_code: 200, body: { kind: "done", runId: "ret_1" } });
  });

  it("restore: busy is 409, an unknown run is 404", async () => {
    const { call, spies } = spiedRoutes();
    spies.restore.mockResolvedValueOnce({ kind: "busy", heldBy: "sweep-1" });
    expect(await call("restore", { body: BODIES.restore })).toMatchObject({ status_code: 409, body: { error: "busy" } });
    spies.restore.mockResolvedValueOnce({ kind: "not-found" });
    expect((await call("restore", { body: BODIES.restore })).status_code).toBe(404);
  });

  it("pin and report: an unknown item or run is 404", async () => {
    const { call, spies } = spiedRoutes();
    spies.pin.mockResolvedValueOnce({ kind: "not-found" });
    expect((await call("pin", { body: BODIES.pin })).status_code).toBe(404);
    spies.report.mockResolvedValueOnce({ kind: "not-found" });
    expect((await call("report", {})).status_code).toBe(404);
  });

  it.each(ROUTES)("%s: a failure is a 500 that does not leak its message", async (route) => {
    const { call, spies } = spiedRoutes();
    spies[route].mockRejectedValueOnce(new Error("kvrocks password=hunter2"));
    const reply = await call(route, { body: BODIES[route] });
    expect(reply.status_code).toBe(500);
    expect(JSON.stringify(reply.body)).not.toContain("hunter2");
  });
});

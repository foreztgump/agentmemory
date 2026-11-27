// TEE-1443: a sweep, restore or purge that outlasts the engine's HTTP timeout answers 202 with a job id, and the job route
// reports it running, then done with its outcome. Quick calls answer as before.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { ItemRef } from "../../../src/fork/retention/types.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import { KV } from "../../../src/state/schema.js";
import { anchor, ENFORCE, liveRoutes, spiedRoutes, type Reply } from "./api-fixtures.js";
import { NOW, observation, rig, seedSession, vec, type Rig } from "./move-fixtures.js";
import { sealedSession } from "./plan-fixtures.js";

afterEach(() => resetSummarizeVeto());

/** Stands in for the 180 s engine limit; the routes must answer well before it. */
const ENGINE_TIMEOUT_MS = 300;
const DETACH_AFTER_MS = 30;
const DAY = 86_400_000;
const obs = (id: string): ItemRef => ({ kind: "observation", sessionId: "ses_old", id });

async function world(): Promise<{ r: Rig; cases: string }> {
  const r = rig();
  const rows = ["o1", "o2", "o3"].map((id) => observation(id, "ses_old", { title: "okapi sighting", narrative: `okapi ${id} narrative` }));
  await sealedSession(r, "ses_old", 0, { rows });
  for (const [n, row] of rows.entries()) r.runtime.vector.add(row.id, "ses_old", vec(n + 1));
  const cases = await anchor(r);
  for (const [n, day] of ["2026-05-01", "2026-05-02", "2026-05-03"].entries()) await seedSession(r, `ses_later${n}`, { startedAt: `${day}T08:00:00.000Z` });
  r.h.hooks.invocationTimeoutMs = ENGINE_TIMEOUT_MS;
  return { r, cases };
}

/** Holds the first run-row write until opened: every sweep, restore and purge writes one, so the call runs past the engine timeout. */
function holdRunWrites(r: Rig): () => void {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let held = false;
  r.h.hooks.beforeTrigger = async (req) => {
    if (held || req.function_id !== "state::set" || req.payload["scope"] !== RETENTION_KV.runs) return;
    held = true;
    await gate;
  };
  return () => {
    r.h.hooks.beforeTrigger = undefined;
    open();
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function finished(call: (route: "job", c: { query: Record<string, string> }) => Promise<Reply>, id: string): Promise<Reply> {
  for (let i = 0; i < 400; i++) {
    const reply = await call("job", { query: { id } });
    if ((reply.body["job"] as { state?: string } | undefined)?.state !== "running") return reply;
    await sleep(5);
  }
  throw new Error(`job ${id} never finished`);
}

async function detached(reply: Reply): Promise<string> {
  expect(reply.status_code).toBe(202);
  const jobId = reply.body["jobId"] as string;
  expect(jobId).toMatch(/^job_/);
  expect(reply.body).toMatchObject({ kind: "running", jobId, poll: `/agentmemory/retention/job?id=${jobId}` });
  return jobId;
}

describe("a retention call longer than the engine timeout", () => {
  it("sweep, restore and purge answer 202 with a job id, and the job route reports running, then the outcome", async () => {
    const { r, cases } = await world();
    const clock = { now: NOW };
    const { call } = liveRoutes(r, clock, { env: { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases }, rest: { detachAfterMs: DETACH_AFTER_MS } });

    const release = holdRunWrites(r);
    const sweepJob = await detached(await call("sweep", { body: { dryRun: false } }));
    expect(await call("job", { query: { id: sweepJob } })).toMatchObject({ status_code: 200, body: { kind: "found", job: { id: sweepJob, route: "sweep", state: "running" } } });
    expect(await call("sweep", { body: {} })).toMatchObject({ status_code: 409, body: { error: "busy" } });
    await sleep(ENGINE_TIMEOUT_MS + 20);
    release();
    const swept = await finished(call, sweepJob);
    expect(swept).toMatchObject({ status_code: 200, body: { job: { state: "done", outcome: { kind: "done", outcome: "kept" } } } });
    const runId = (swept.body["job"] as { outcome: { runId: string } }).outcome.runId;
    expect(await call("report", { query: { runId } })).toMatchObject({ status_code: 200, body: { run: { id: runId, phase: "done", outcome: "kept", held: 3 } } });
    expect(await r.kv.listKeys(KV.observations("ses_old"))).toEqual([]);

    const releaseRestore = holdRunWrites(r);
    const restoreJob = await detached(await call("restore", { body: { refs: [obs("o2")] } }));
    releaseRestore();
    expect(await finished(call, restoreJob)).toMatchObject({ body: { job: { route: "restore", state: "done", outcome: { kind: "done", restored: 1 } } } });
    expect(await r.kv.listKeys(KV.observations("ses_old"))).toEqual(["o2"]);

    clock.now = new Date(NOW.getTime() + DAY + 3_600_000);
    const releasePurge = holdRunWrites(r);
    const purgeJob = await detached(await call("purge", { body: { dryRun: false } }));
    releasePurge();
    expect(await finished(call, purgeJob)).toMatchObject({ body: { job: { route: "purge", state: "done", outcome: { kind: "done", dryRun: false, purged: 2 } } } });
  });

  it("a quick call answers as before, with no job id", async () => {
    const { r, cases } = await world();
    const { call } = liveRoutes(r, { now: NOW }, { env: { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases }, rest: { detachAfterMs: DETACH_AFTER_MS } });
    const dry = await call("sweep", { body: {} });
    expect(dry).toMatchObject({ status_code: 200, body: { kind: "done", outcome: "dry-run" } });
    expect(dry.body["jobId"]).toBeUndefined();
  });

  it("a job still running when the worker restarted reads as lost", async () => {
    const { r, cases } = await world();
    const clock = { now: NOW };
    const env = { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases };
    const before = liveRoutes(r, clock, { env, rest: { detachAfterMs: DETACH_AFTER_MS } });
    const release = holdRunWrites(r);
    const jobId = await detached(await before.call("sweep", { body: { dryRun: false } }));
    resetSummarizeVeto();
    const after = liveRoutes(r, clock, { env, rest: { detachAfterMs: DETACH_AFTER_MS } });
    expect(await after.call("job", { query: { id: jobId } })).toMatchObject({ status_code: 200, body: { job: { id: jobId, state: "lost" } } });
    release();
  });
});

describe("the job route", () => {
  it("answers 404 to an unknown job and 400 to a missing or malformed id", async () => {
    const { r } = await world();
    const { call } = liveRoutes(r, { now: NOW }, { env: ENFORCE });
    expect(await call("job", { query: { id: "job_nope" } })).toMatchObject({ status_code: 404, body: { error: "not-found" } });
    expect((await call("job", { query: {} })).status_code).toBe(400);
    expect((await call("job", { query: { id: "ret_abc" } })).status_code).toBe(400);
  });

  it("fails closed: 503 with no secret, 401 with a wrong token", async () => {
    const off = spiedRoutes(null);
    expect((await off.call("job", { query: { id: "job_x" } })).status_code).toBe(503);
    const on = spiedRoutes();
    expect((await on.call("job", { query: { id: "job_x" }, token: "wrong" })).status_code).toBe(401);
    expect(on.spies.job).not.toHaveBeenCalled();
    expect((await on.call("job", { query: { id: "job_x" } })).status_code).toBe(200);
    expect(on.spies.job.mock.calls[0]![0]).toEqual({ id: "job_x" });
  });
});

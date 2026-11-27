// R13 end to end through the REST routes with a secret: a dry run, an enforcing sweep, the report, a restore of one ref, then a purge after grace.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { itemKey, RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { ItemRef } from "../../../src/fork/retention/types.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import { KV } from "../../../src/state/schema.js";
import { anchor, ENFORCE, liveRoutes } from "./api-fixtures.js";
import { keywordHits, NOW, observation, rig, seedSession, vec, vectorHits, type Rig } from "./move-fixtures.js";
import { sealedSession } from "./plan-fixtures.js";
import { auditEntries, userData } from "./sweep-fixtures.js";

afterEach(() => resetSummarizeVeto());

const obs = (id: string): ItemRef => ({ kind: "observation", sessionId: "ses_old", id });
const DAY = 86_400_000;

/** Three old rows in a sealed session, a pinned anchor that recall finds, and three later sessions so the project's active days pass the 1-day windows. */
async function world(): Promise<{ r: Rig; cases: string }> {
  const r = rig();
  const rows = ["o1", "o2", "o3"].map((id) => observation(id, "ses_old", { title: "okapi sighting", narrative: `okapi ${id} narrative` }));
  await sealedSession(r, "ses_old", 0, { rows });
  for (const [n, row] of rows.entries()) r.runtime.vector.add(row.id, "ses_old", vec(n + 1));
  const cases = await anchor(r);
  for (const [n, day] of ["2026-05-01", "2026-05-02", "2026-05-03"].entries()) await seedSession(r, `ses_later${n}`, { startedAt: `${day}T08:00:00.000Z` });
  return { r, cases };
}

describe("R13: the retention routes, end to end, with a secret", () => {
  it("sweeps, reports, restores one ref and purges after grace, and audits every step", async () => {
    const { r, cases } = await world();
    const clock = { now: NOW };
    const { call } = liveRoutes(r, clock, { env: { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases } });
    const beforeDry = userData(r);

    const dry = await call("sweep", { body: {} });
    expect(dry).toMatchObject({ status_code: 200, body: { kind: "done", outcome: "dry-run" } });
    expect(userData(r)).toEqual(beforeDry);
    expect((dry.body["report"] as { perStage: { O: { count: number } } }).perStage.O.count).toBe(4);

    clock.now = new Date(NOW.getTime() + 60_000);
    const swept = await call("sweep", { body: { dryRun: false } });
    expect(swept).toMatchObject({ status_code: 200, body: { kind: "done", outcome: "kept" } });
    const runId = swept.body["runId"] as string;
    expect(await r.kv.listKeys(KV.observations("ses_old"))).toEqual([]);
    expect(await keywordHits(r, "okapi")).toEqual([]);
    expect(await r.kv.get(KV.observations("ses_keep"), "k1")).not.toBeNull();

    const report = await call("report", { query: { runId } });
    expect(report.status_code).toBe(200);
    expect(report.body).toMatchObject({
      kind: "found",
      report: { runId, outcome: "kept", dryRun: false, perStage: { O: { count: 4, moved: 3 } }, recall: { verdict: "keep" } },
      run: { id: runId, phase: "done", outcome: "kept", held: 3, graceDays: 1, purgedAt: null },
    });
    expect(await call("report", {})).toMatchObject({ body: { run: { id: runId } } });

    const restored = await call("restore", { body: { refs: [obs("o2")] } });
    expect(restored).toMatchObject({ status_code: 200, body: { kind: "done", restored: 1, reembedNeeded: 0 } });
    expect(await r.kv.listKeys(KV.observations("ses_old"))).toEqual(["o2"]);
    expect(await keywordHits(r, "okapi")).toEqual(["o2"]);
    expect(await vectorHits(r, 2)).toContain("o2");
    expect(await r.runs.get(runId as never)).toMatchObject({ held: 2 });

    clock.now = new Date(NOW.getTime() + DAY + 3_600_000);
    const preview = await call("purge", { body: {} });
    expect(preview).toMatchObject({ status_code: 200, body: { kind: "done", dryRun: true, purged: 2 } });
    expect(await r.vault.locate(obs("o1"))).not.toBeNull();

    const purged = await call("purge", { body: { dryRun: false } });
    expect(purged).toMatchObject({ status_code: 200, body: { kind: "done", dryRun: false, purged: 2, runsEmptied: 1 } });
    expect(await r.kv.listKeys(RETENTION_KV.vault(runId as never))).toEqual([]);
    expect(await r.kv.listKeys(KV.observations("ses_old"))).toEqual(["o2"]);
    for (const id of ["o1", "o3"]) expect(await r.kv.get(RETENTION_KV.tombstones, itemKey(obs(id)))).toMatchObject({ runId });
    expect(await r.kv.get(RETENTION_KV.tombstones, itemKey(obs("o2")))).toBeNull();

    const after = await call("report", { query: { runId } });
    expect(after.body).toMatchObject({ run: { held: 0, purgedAt: clock.now.toISOString() } });

    const entries = auditEntries(r);
    const named = (operation: string) => entries.filter((entry) => entry.operation === operation);
    expect(named("retention_seal").filter((entry) => entry.targetIds.includes(runId))).toHaveLength(1);
    const staged = named("retention_soft_delete").filter((entry) => entry.targetIds.includes(runId));
    expect(staged.map((entry) => entry.details["stage"]).sort()).toEqual(["O", "S", "T", "X"]);
    expect(staged.find((entry) => entry.details["stage"] === "O")!.details).toMatchObject({ runId, outcome: "kept", planned: 4, moved: 3 });
    expect(named("retention_restore")).toEqual([expect.objectContaining({ targetIds: [itemKey(obs("o2"))], details: expect.objectContaining({ restored: 1 }) })]);
    expect(named("retention_purge")).toEqual([expect.objectContaining({ targetIds: [runId], details: expect.objectContaining({ purged: 2, runId }) })]);
  });

  it("a pin through the route keeps a row out of the sweep", async () => {
    const { r, cases } = await world();
    const { call } = liveRoutes(r, { now: NOW }, { env: { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases } });
    expect(await call("pin", { body: { ref: obs("o1"), reason: "keep this one", who: "dana" } })).toMatchObject({
      status_code: 200,
      body: { kind: "pinned", pin: { who: "dana", reason: "keep this one" }, vaulted: false, undemoted: false },
    });
    expect(await call("pin", { body: { ref: obs("nope"), reason: "x" } })).toMatchObject({ status_code: 404 });
    const swept = await call("sweep", { body: { dryRun: false } });
    expect(swept.body).toMatchObject({ outcome: "kept", report: { perStage: { O: { moved: 2 } }, protectedSamples: { pin: expect.arrayContaining(["ses_old/o1"]) } } });
    expect(await r.kv.listKeys(KV.observations("ses_old"))).toEqual(["o1"]);
    expect(await call("pin", { body: { ref: obs("o1"), unpin: true } })).toMatchObject({ status_code: 200, body: { kind: "unpinned", existed: true } });
  });

  it("restore and pin still work when retention is switched off, but a sweep and a purge say it is off", async () => {
    const { r, cases } = await world();
    const clock = { now: NOW };
    const on = liveRoutes(r, clock, { env: { ...ENFORCE, AM_RETENTION_RECALL_CASES: cases } });
    const runId = (await on.call("sweep", { body: { dryRun: false } })).body["runId"] as string;
    resetSummarizeVeto();

    const off = liveRoutes(r, clock, { env: { AM_RETENTION: "off" } });
    for (const route of ["sweep", "purge"] as const) {
      expect(await off.call(route, { body: { dryRun: false } })).toMatchObject({ status_code: 503, body: { error: "retention is off" } });
    }
    expect(await off.call("report", { query: { runId } })).toMatchObject({ status_code: 200 });
    expect(await off.call("restore", { body: { runId } })).toMatchObject({ status_code: 200, body: { kind: "done", restored: 3 } });
    expect(await r.kv.listKeys(KV.observations("ses_old"))).toEqual(["o1", "o2", "o3"]);
  });
});

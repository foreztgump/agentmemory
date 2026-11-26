import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { summaryFingerprint, summaryObservations } from "../../../src/functions/summary-state.js";
import { GuardedStateKV, ScopeReadInventory } from "../../../src/fork/scope-guard.js";
import { judgeSeal, readSessionFacts, sealSession, type SessionRowFacts } from "../../../src/fork/retention/seal.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { RETENTION_PAGE_SIZE } from "../../../src/fork/retention/settings.js";
import type { SessionSeal } from "../../../src/fork/retention/types.js";
import { withKeyedLock } from "../../../src/state/keyed-mutex.js";
import { KV } from "../../../src/state/schema.js";
import type { StateKV } from "../../../src/state/kv.js";
import type { CompressedObservation, Session, SessionSummary } from "../../../src/types.js";
import { retentionHarness } from "./harness.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;
const OPTS = { now: NOW, llmCompression: false };

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id, project: "proj", cwd: "/work", startedAt: "2026-05-01T08:00:00.000Z", status: "completed",
    observationCount: 0, agentId: "agent-1", ...over,
  };
}

function row(sessionId: string, id: string, timestamp: string, over: Partial<CompressedObservation> = {}): CompressedObservation {
  return {
    id, sessionId, timestamp, type: "file_read", title: `title ${id}`, facts: [`fact ${id}`], narrative: `narrative ${id}`,
    concepts: ["c"], files: ["a.ts"], importance: 5, ...over,
  };
}

function rowsOf(sessionId: string, count: number, base = "2026-05-01T09:00:00.000Z"): CompressedObservation[] {
  return Array.from({ length: count }, (_, i) =>
    row(sessionId, `obs_${String(i).padStart(4, "0")}`, new Date(Date.parse(base) + i * 1000).toISOString()));
}

function summaryFor(s: Session, rows: CompressedObservation[], over: Partial<SessionSummary> = {}): SessionSummary {
  const covered = summaryObservations(rows);
  return {
    sessionId: s.id, project: s.project, createdAt: "2026-05-02T00:00:00.000Z", title: "summary", narrative: "a narrative that is long enough",
    keyDecisions: [], filesModified: [], concepts: [], observationCount: covered.length,
    coveredFingerprint: summaryFingerprint(s, covered), ...over,
  };
}

function factsOf(s: Session, rows: CompressedObservation[], over: Partial<SessionRowFacts> = {}): SessionRowFacts {
  const covered = summaryObservations(rows);
  return {
    summaryRowCount: covered.length, summaryFingerprint: summaryFingerprint(s, covered),
    lastObservationAt: rows.map((r) => r.timestamp).sort().at(-1) ?? null, allCompressed: true, ...over,
  };
}

async function store(kv: StateKV, s: Session, rows: CompressedObservation[], summary?: SessionSummary | null) {
  await kv.set(KV.sessions, s.id, s);
  for (const r of rows) await kv.set(KV.observations(s.id), r.id, r);
  if (summary) await kv.set(KV.summaries, s.id, summary);
}

describe("judgeSeal (seal half of R2)", () => {
  const rows = rowsOf("ses_x", 3);

  const summarized = session("ses_summarized");
  const summarizedRows = rowsOf(summarized.id, 3);
  const noSummary = session("ses_nosummary");
  const noSummaryRows = rowsOf(noSummary.id, 3);
  const active = session("ses_active", { status: "active" });
  const activeRows = rowsOf(active.id, 3);
  const stale = session("ses_stale");
  const staleRows = rowsOf(stale.id, 3);
  const staleSummary = summaryFor(stale, staleRows.slice(0, 2));

  it.each([
    ["a summarized ended session seals", summarized, summarizedRows, summaryFor(summarized, summarizedRows), { kind: "sealed" }],
    ["a session without a summary", noSummary, noSummaryRows, null, { kind: "refused", why: "no-summary" }],
    ["an active session", active, activeRows, summaryFor(active, activeRows), { kind: "refused", why: "active" }],
    ["a session whose summary is out of date", stale, staleRows, staleSummary, { kind: "refused", why: "summary-out-of-date" }],
  ] as const)("%s", (_name, s, sessionRows, summary, expected) => {
    expect(judgeSeal(s, factsOf(s, sessionRows), summary, null, OPTS)).toMatchObject(expected);
  });

  it("the sealed verdict carries a seal that records what the summary covered", () => {
    const s = summarized;
    const verdict = judgeSeal(s, factsOf(s, summarizedRows), summaryFor(s, summarizedRows), null, OPTS);
    expect(verdict.kind === "sealed" && verdict.proof.seal).toMatchObject({
      sessionId: s.id, sealedAt: NOW.toISOString(), observationCount: 3, trimmed: false,
      summaryFingerprint: summaryFingerprint(s, summaryObservations(summarizedRows)),
    });
  });

  it("an abandoned session seals like a completed one", () => {
    const s = session("ses_ab", { status: "abandoned" });
    expect(judgeSeal(s, factsOf(s, rows), summaryFor(s, rows), null, OPTS).kind).toBe("sealed");
  });

  it("a session whose last observation is not more than a day old waits", () => {
    const s = session("ses_recent");
    const recent = [row(s.id, "o1", new Date(NOW.getTime() - DAY + 1).toISOString())];
    const edge = [row(s.id, "o1", new Date(NOW.getTime() - DAY).toISOString())];
    const old = [row(s.id, "o1", new Date(NOW.getTime() - DAY - 1).toISOString())];
    expect(judgeSeal(s, factsOf(s, recent), summaryFor(s, recent), null, OPTS)).toMatchObject({ why: "recent-capture" });
    expect(judgeSeal(s, factsOf(s, edge), summaryFor(s, edge), null, OPTS)).toMatchObject({ why: "recent-capture" });
    expect(judgeSeal(s, factsOf(s, old), summaryFor(s, old), null, OPTS).kind).toBe("sealed");
  });

  it("a summary with the right fingerprint but a different row count is out of date", () => {
    const s = summarized;
    expect(judgeSeal(s, factsOf(s, summarizedRows), summaryFor(s, summarizedRows, { observationCount: 2 }), null, OPTS))
      .toMatchObject({ why: "summary-out-of-date" });
  });

  it("a summary with no covered fingerprint (a partial or old one) is out of date", () => {
    const s = summarized;
    const partial = summaryFor(s, summarizedRows, { coveredFingerprint: undefined });
    expect(judgeSeal(s, factsOf(s, summarizedRows), partial, null, OPTS)).toMatchObject({ why: "summary-out-of-date" });
  });

  it("a row still awaiting compression blocks the seal only on a stack that compresses", () => {
    const s = summarized;
    const facts = factsOf(s, summarizedRows, { allCompressed: false });
    const summary = summaryFor(s, summarizedRows);
    expect(judgeSeal(s, facts, summary, null, { now: NOW, llmCompression: true })).toMatchObject({ why: "compression-pending" });
    expect(judgeSeal(s, facts, summary, null, { now: NOW, llmCompression: false }).kind).toBe("sealed");
  });

  it("an existing seal with the same fingerprint stands unchanged", () => {
    const s = summarized;
    const first = judgeSeal(s, factsOf(s, summarizedRows), summaryFor(s, summarizedRows), null, OPTS);
    if (first.kind !== "sealed") throw new Error("expected a seal");
    const later = judgeSeal(s, factsOf(s, summarizedRows), summaryFor(s, summarizedRows), first.proof.seal, { ...OPTS, now: new Date(NOW.getTime() + DAY) });
    expect(later).toEqual({ kind: "sealed", proof: { seal: first.proof.seal } });
  });

  it("a trimmed seal stands when the rows are gone and the fingerprint no longer matches (D10)", () => {
    const s = summarized;
    const trimmed: SessionSeal = {
      sessionId: s.id, sealedAt: "2026-05-20T00:00:00.000Z", observationCount: 3, graphExtracted: false, trimmed: true,
      summaryFingerprint: summaryFor(s, summarizedRows).coveredFingerprint!,
    };
    const emptied = factsOf(s, []);
    const verdict = judgeSeal(s, emptied, summaryFor(s, summarizedRows), trimmed, OPTS);
    expect(verdict).toEqual({ kind: "sealed", proof: { seal: trimmed } });
  });

  it("a seal that is not trimmed does not stand once the rows change", () => {
    const s = summarized;
    const old = judgeSeal(s, factsOf(s, summarizedRows), summaryFor(s, summarizedRows), null, OPTS);
    if (old.kind !== "sealed") throw new Error("expected a seal");
    const grown = [...summarizedRows, row(s.id, "obs_late", "2026-05-03T00:00:00.000Z")];
    expect(judgeSeal(s, factsOf(s, grown), summaryFor(s, summarizedRows), old.proof.seal, OPTS))
      .toMatchObject({ kind: "refused", why: "summary-out-of-date" });
  });
});

const MODES = ["plain", "AGENTMEMORY_SCOPE_GUARD=throw"] as const;

describe.each(MODES)("readSessionFacts (%s)", (mode) => {
  function setup() {
    const h = retentionHarness();
    const kv: StateKV = mode === "plain"
      ? h.kv
      : new GuardedStateKV(h.sdk as never, { backend: "redis" }, new ScopeReadInventory(), undefined, true);
    return { h, kv };
  }

  function awkwardRows(sessionId: string, count: number): CompressedObservation[] {
    const rows: CompressedObservation[] = [];
    for (let i = 0; i < count; i++) {
      const minute = String((i * 7) % 60).padStart(2, "0");
      const over: Partial<CompressedObservation> = {};
      if (i % 5 === 0) over.compressedAt = `2026-05-02T10:${minute}:00.000Z`;
      if (i % 11 === 0) over.title = "";
      if (i % 13 === 0) over.files = undefined as never;
      if (i % 17 === 0) over.facts = ["unicode é ☃", "quote \" back\\slash"];
      rows.push(row(sessionId, `obs_${i % 3 === 0 ? "A" : "b"}${i}`, `2026-05-01T10:${minute}:00.000Z`, over));
    }
    return rows;
  }

  it.each([0, 1, RETENTION_PAGE_SIZE - 1, RETENTION_PAGE_SIZE, RETENTION_PAGE_SIZE + 1, 2 * RETENTION_PAGE_SIZE + 37])(
    "the piecewise fingerprint equals summaryFingerprint for %i rows, across page boundaries",
    async (count) => {
      const { kv } = setup();
      const s = session("ses_big");
      const rows = awkwardRows(s.id, count);
      await store(kv, s, rows);

      const facts = await readSessionFacts(kv, s);

      expect(facts.summaryFingerprint).toBe(summaryFingerprint(s, summaryObservations(rows)));
      expect(facts.summaryRowCount).toBe(summaryObservations(rows).length);
    },
  );

  it("orders rows exactly as the summary does: compressedAt over timestamp, ties by id with localeCompare", async () => {
    const { kv } = setup();
    const s = session("ses_order", { agentId: undefined });
    const rows = [
      row(s.id, "obs_10", "2026-05-01T10:00:00.000Z"),
      row(s.id, "obs_9", "2026-05-01T10:00:00.000Z"),
      row(s.id, "Obs_b", "2026-05-01T10:00:00.000Z"),
      row(s.id, "obs_a", "2026-05-01T10:00:00.000Z"),
      row(s.id, "obs_late", "2026-05-01T09:00:00.000Z", { compressedAt: "2026-05-03T00:00:00.000Z" }),
      row(s.id, "obs_early", "2026-05-09T00:00:00.000Z", { compressedAt: "2026-05-01T00:00:00.000Z" }),
    ];
    await store(kv, s, rows);

    expect((await readSessionFacts(kv, s)).summaryFingerprint).toBe(summaryFingerprint(s, summaryObservations(rows)));
  });

  it("reports the latest timestamp over every row, untitled ones included, and null for no rows", async () => {
    const { kv } = setup();
    const s = session("ses_last");
    await store(kv, s, [
      row(s.id, "o1", "2026-05-01T10:00:00.000Z"),
      row(s.id, "o2", "2026-05-04T10:00:00.000Z", { title: "" }),
      row(s.id, "o3", "2026-05-02T10:00:00.000Z"),
    ]);
    const facts = await readSessionFacts(kv, s);
    expect(facts.lastObservationAt).toBe("2026-05-04T10:00:00.000Z");
    expect(facts.summaryRowCount).toBe(2);

    expect(await readSessionFacts(kv, session("ses_none"))).toMatchObject({ lastObservationAt: null, summaryRowCount: 0 });
  });

  it("allCompressed is false while a row awaits compression, pending or failed or still raw", async () => {
    const { kv } = setup();
    const cases: Array<[string, Partial<CompressedObservation>, boolean]> = [
      ["complete", { compression: { status: "complete", revision: "r", attempts: 1 } }, true],
      ["no compression field", {}, true],
      ["pending", { compression: { status: "pending", revision: "r", attempts: 0 } }, false],
      ["failed", { compression: { status: "failed", revision: "r", attempts: 3 } }, false],
      ["raw, never compressed", { hookType: "post_tool_use" } as never, false],
    ];
    for (const [name, over, expected] of cases) {
      const s = session(`ses_${name}`);
      const second = row(s.id, "o2", "2026-05-01T11:00:00.000Z", over);
      if (name.startsWith("raw")) delete (second as Partial<CompressedObservation>).title;
      await store(kv, s, [row(s.id, "o1", "2026-05-01T10:00:00.000Z"), second]);
      expect((await readSessionFacts(kv, s)).allCompressed, name).toBe(expected);
    }
  });

  it("reads keys once and the values in pages, and never lists the observation scope", async () => {
    const { h, kv } = setup();
    const s = session("ses_paged");
    await store(kv, s, rowsOf(s.id, 2 * RETENTION_PAGE_SIZE + 5));
    const list = vi.spyOn(kv, "list");
    const getMany = vi.spyOn(kv, "getMany");
    h.stateOps.length = 0;

    await readSessionFacts(kv, s);

    expect(list).not.toHaveBeenCalled();
    expect(h.stateOps.filter((op) => op.startsWith("state::list "))).toEqual([]);
    expect(h.stateOps.filter((op) => op === `state::list_keys ${KV.observations(s.id)}`)).toHaveLength(1);
    const sizes = getMany.mock.calls.map(([, keys]) => keys.length);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(RETENTION_PAGE_SIZE);
  });

  it("a row that changes between the two passes can never produce a matching fingerprint", async () => {
    const { kv } = setup();
    const s = session("ses_race");
    const rows = rowsOf(s.id, 5);
    await store(kv, s, rows);
    const realGetMany = kv.getMany.bind(kv);
    let calls = 0;
    vi.spyOn(kv, "getMany").mockImplementation(async (scope, keys, opts) => {
      if (++calls === 2) await kv.delete(KV.observations(s.id), keys[0]!);
      return realGetMany(scope, keys, opts);
    });

    const facts = await readSessionFacts(kv, s);

    expect(facts.summaryFingerprint).not.toBe(summaryFingerprint(s, summaryObservations(rows)));
    expect(judgeSeal(s, facts, summaryFor(s, rows), null, OPTS)).toMatchObject({ why: "summary-out-of-date" });
  });
});

describe.each(MODES)("sealSession (%s)", (mode) => {
  function setup() {
    const h = retentionHarness();
    const kv: StateKV = mode === "plain"
      ? h.kv
      : new GuardedStateKV(h.sdk as never, { backend: "redis" }, new ScopeReadInventory(), undefined, true);
    return { h, kv };
  }

  it("R2 seal half: of the four sessions only the summarized ended one is sealed", async () => {
    const { h, kv } = setup();
    const ok = session("ses_ok");
    const none = session("ses_none");
    const live = session("ses_live", { status: "active" });
    const stale = session("ses_stale");
    const okRows = rowsOf(ok.id, 4);
    const staleRows = rowsOf(stale.id, 4);
    await store(kv, ok, okRows, summaryFor(ok, okRows));
    await store(kv, none, rowsOf(none.id, 4));
    await store(kv, live, rowsOf(live.id, 4), summaryFor(live, rowsOf(live.id, 4)));
    await store(kv, stale, staleRows, summaryFor(stale, staleRows.slice(0, 3)));

    const verdicts = Object.fromEntries(await Promise.all(
      [ok, none, live, stale].map(async (s) => [s.id, await sealSession(kv, s.id, OPTS)] as const),
    ));

    expect(verdicts.ses_ok!.kind).toBe("sealed");
    expect(verdicts.ses_none).toEqual({ kind: "refused", why: "no-summary" });
    expect(verdicts.ses_live).toEqual({ kind: "refused", why: "active" });
    expect(verdicts.ses_stale).toEqual({ kind: "refused", why: "summary-out-of-date" });
    expect([...h.store.get(RETENTION_KV.seals)!.keys()]).toEqual(["ses_ok"]);
    expect(h.store.get(RETENTION_KV.seals)!.get("ses_ok")).toMatchObject({ sessionId: "ses_ok", observationCount: 4, trimmed: false });
  });

  it("waits for the session's observation lock, so a summary published meanwhile is judged", async () => {
    const { h, kv } = setup();
    const s = session("ses_locked");
    const rows = rowsOf(s.id, 4);
    await store(kv, s, rows, summaryFor(s, rows.slice(0, 3)));
    let release!: () => void;
    const held = withKeyedLock(`obs:${s.id}`, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      await kv.set(KV.summaries, s.id, summaryFor(s, rows));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sealing = sealSession(kv, s.id, OPTS);
    release();
    await held;

    expect((await sealing).kind).toBe("sealed");
    expect(h.store.get(RETENTION_KV.seals)!.has(s.id)).toBe(true);
  });

  it("seals a session of more than one page, and sealing again keeps the first seal", async () => {
    const { h, kv } = setup();
    const s = session("ses_large");
    const rows = rowsOf(s.id, 2 * RETENTION_PAGE_SIZE + 37);
    await store(kv, s, rows, summaryFor(s, rows));

    await sealSession(kv, s.id, OPTS);
    const first = structuredClone(h.store.get(RETENTION_KV.seals)!.get(s.id));
    await sealSession(kv, s.id, { ...OPTS, now: new Date(NOW.getTime() + 5 * DAY) });

    expect(first).toMatchObject({ observationCount: rows.length });
    expect(h.store.get(RETENTION_KV.seals)!.get(s.id)).toEqual(first);
  });

  it("drops a seal when a late capture makes the summary out of date", async () => {
    const { h, kv } = setup();
    const s = session("ses_late");
    const rows = rowsOf(s.id, 3);
    await store(kv, s, rows, summaryFor(s, rows));
    await sealSession(kv, s.id, OPTS);
    expect(h.store.get(RETENTION_KV.seals)!.has(s.id)).toBe(true);

    await kv.set(KV.observations(s.id), "obs_new", row(s.id, "obs_new", "2026-05-02T00:00:00.000Z"));
    const verdict = await sealSession(kv, s.id, OPTS);

    expect(verdict).toEqual({ kind: "refused", why: "summary-out-of-date" });
    expect(h.store.get(RETENTION_KV.seals)!.has(s.id)).toBe(false);
  });

  it("re-seals under the new fingerprint once the summary catches up", async () => {
    const { h, kv } = setup();
    const s = session("ses_catchup");
    const rows = rowsOf(s.id, 3);
    await store(kv, s, rows, summaryFor(s, rows));
    await sealSession(kv, s.id, OPTS);

    const grown = [...rows, row(s.id, "obs_new", "2026-05-02T00:00:00.000Z")];
    await kv.set(KV.observations(s.id), "obs_new", grown[3]!);
    await kv.set(KV.summaries, s.id, summaryFor(s, grown));
    await sealSession(kv, s.id, OPTS);

    expect(h.store.get(RETENTION_KV.seals)!.get(s.id)).toMatchObject({
      observationCount: 4, summaryFingerprint: summaryFingerprint(s, summaryObservations(grown)),
    });
  });

  it("a trimmed seal survives its rows being soft-deleted", async () => {
    const { h, kv } = setup();
    const s = session("ses_trimmed");
    const rows = rowsOf(s.id, 3);
    await store(kv, s, rows, summaryFor(s, rows));
    await sealSession(kv, s.id, OPTS);
    const seal = h.store.get(RETENTION_KV.seals)!.get(s.id) as SessionSeal;
    await kv.set(RETENTION_KV.seals, s.id, { ...seal, trimmed: true });
    for (const r of rows) await kv.delete(KV.observations(s.id), r.id);

    const verdict = await sealSession(kv, s.id, OPTS);

    expect(verdict.kind).toBe("sealed");
    expect(h.store.get(RETENTION_KV.seals)!.get(s.id)).toMatchObject({ trimmed: true, observationCount: 3 });
  });

  it("a session that does not exist is refused and leaves no seal", async () => {
    const { h, kv } = setup();
    expect(await sealSession(kv, "ses_gone", OPTS)).toEqual({ kind: "refused", why: "no-session" });
    expect(h.store.get(RETENTION_KV.seals)?.size ?? 0).toBe(0);
  });
});

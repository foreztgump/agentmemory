// Second fix round on the slice 5 Open Code Review: a resumed cursor is keyed to its session, a chain proof is
// minted by protect.ts only, the successor tiebreak orders by time, and the S fixture derives its dates from the row.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { proveChain, successorIndex } from "../../../src/fork/retention/plan.js";
import { isChainProof } from "../../../src/fork/retention/protect.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import { RETENTION_PAGE_SIZE } from "../../../src/fork/retention/settings.js";
import { KV } from "../../../src/state/schema.js";
import type { Memory } from "../../../src/types.js";
import { candidate, memory, observation, rig } from "./move-fixtures.js";
import { candidatesOf, planAll, sealedSession, ZERO } from "./plan-fixtures.js";

describe("a resumed cursor applies only to the session it belongs to", () => {
  it("plans every row of the next session when the partially walked session's seal is gone at resume", async () => {
    const r = rig();
    const rowIds = (n: number) => Array.from({ length: n }, (_, i) => `o${String(i).padStart(4, "0")}`);
    await sealedSession(r, "ses_a", 0, { rows: rowIds(RETENTION_PAGE_SIZE + 3).map((id) => observation(id, "ses_a")) });
    await sealedSession(r, "ses_b", 0, { rows: rowIds(5).map((id) => observation(id, "ses_b")) });

    const firstPage = (await planAll(r, ZERO)).find((b) => b.cursorAfter.within)!;
    expect(firstPage.cursorAfter).toMatchObject({ unit: "sessions", after: null, within: { afterRowId: rowIds(RETENTION_PAGE_SIZE).at(-1) } });

    await r.kv.delete(RETENTION_KV.seals, "ses_a");
    const resumed = candidatesOf(await planAll(r, ZERO, firstPage.cursorAfter));
    expect(resumed.map((c) => c.ref.id)).toEqual(rowIds(5));
  });

  it("still resumes inside the session the cursor names", async () => {
    const r = rig();
    const rows = Array.from({ length: RETENTION_PAGE_SIZE + 3 }, (_, i) => observation(`o${String(i).padStart(4, "0")}`, "ses_a"));
    await sealedSession(r, "ses_a", 0, { rows });
    await sealedSession(r, "ses_b", 1);
    const firstPage = (await planAll(r, ZERO)).find((b) => b.cursorAfter.within)!;
    expect(firstPage.cursorAfter.within).toMatchObject({ sessionId: "ses_a" });
    const resumed = candidatesOf(await planAll(r, ZERO, firstPage.cursorAfter));
    expect(resumed.map((c) => c.ref.id)).toEqual([...rows.slice(RETENTION_PAGE_SIZE).map((o) => o.id), "ses_b_o0"]);
  });
});

describe("a chain proof is minted by protect.ts, with its brand set", () => {
  const chain = (id: string, over: Partial<Memory>) => memory(id, { forgetAfter: undefined, ...over });

  it("proveChain returns a proof that the guard accepts, and a bare object is not one", async () => {
    const r = rig();
    for (const row of [chain("a", { isLatest: false }), chain("b", { version: 2, supersedes: ["a"], createdAt: "2026-02-01T00:00:00.000Z" })]) {
      await r.kv.set(KV.memories, row.id, row);
    }
    const proof = await proveChain(r.kv, (await r.kv.get<Memory>(KV.memories, "a"))!, await successorIndex(r.kv));
    expect(proof).toMatchObject({ successorId: "b" });
    expect(isChainProof(proof)).toBe(true);
    expect(isChainProof({ successorId: "b" })).toBe(false);
  });
});

describe("the successor tiebreak orders createdAt by time, as strictlyNewer does", () => {
  it.each([["b first", ["a", "b", "c"]], ["c first", ["a", "c", "b"]]])("picks the later instant when the strings order the other way (%s)", async (_name, order) => {
    const r = rig();
    const rows = new Map([
      ["a", memory("a", { isLatest: false, forgetAfter: undefined })],
      // 2026-01-31T23:30:00Z, but its string sorts after the next row's.
      ["b", memory("b", { version: 2, supersedes: ["a"], createdAt: "2026-02-01T00:30:00+01:00", forgetAfter: undefined })],
      ["c", memory("c", { version: 2, supersedes: ["a"], createdAt: "2026-02-01T00:00:00.000Z", forgetAfter: undefined })],
    ]);
    for (const id of order) await r.kv.set(KV.memories, id, rows.get(id)!);
    expect((await successorIndex(r.kv)).get("a")).toBe("c");
  });
});

describe("the S fixture derives the successor's date from the row", () => {
  it("builds a stage S candidate for an old memory created after 2026-02-01", async () => {
    const r = rig();
    const old = memory("late_old", { isLatest: false, createdAt: "2026-03-15T00:00:00.000Z", updatedAt: "2026-03-15T00:00:00.000Z", forgetAfter: undefined });
    await r.kv.set(KV.memories, old.id, old);
    const cleared = await candidate(r, "S", old);
    expect(cleared).toMatchObject({ stage: "S", proof: { successorId: "late_old_next" } });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import { RowIndex } from "../src/fork/kv/row-index.js";
import type { InboxRecord } from "../src/functions/capture.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Entry = { key: string; status: string };
type Row = Entry & { payload: string };

function pagedKv() {
  const base = mockKV();
  const scans: string[] = [];
  const kv = {
    ...base,
    async *iterate<T>(scope: string): AsyncGenerator<T[]> {
      scans.push(scope);
      const rows = [...(base.store.get(scope)?.values() ?? [])] as T[];
      for (let i = 0; i < rows.length; i += 2) yield rows.slice(i, i + 2);
    },
  };
  return { kv, scans, store: base.store };
}

describe("RowIndex", () => {
  const strip = ({ payload: _payload, ...entry }: Row): Entry => entry;

  it("loads once and mirrors writes without scanning again", async () => {
    const { kv, scans } = pagedKv();
    await kv.set("s", "a", { key: "a", status: "pending", payload: "x" });
    const index = new RowIndex<Row, Entry>(kv as never, "s", strip);
    expect(await index.entries()).toEqual([{ key: "a", status: "pending" }]);
    index.put({ key: "b", status: "pending", payload: "y" });
    index.put({ key: "a", status: "dead", payload: "x" });
    index.drop("b");
    expect(await index.entries()).toEqual([{ key: "a", status: "dead" }]);
    expect(await index.size()).toBe(1);
    expect(scans).toEqual(["s"]);
  });

  it("keeps writes that arrive while the first scan is running", async () => {
    const { kv, store } = pagedKv();
    await kv.set("s", "a", { key: "a", status: "pending", payload: "" });
    await kv.set("s", "b", { key: "b", status: "pending", payload: "" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...kv,
      async *iterate<T>(scope: string): AsyncGenerator<T[]> {
        const rows = [...(store.get(scope)?.values() ?? [])] as T[];
        yield rows.slice(0, 1);
        await gate;
        yield rows.slice(1);
      },
    };
    const index = new RowIndex<Row, Entry>(slow as never, "s", strip);
    const loading = index.entries();
    index.put({ key: "c", status: "pending", payload: "" });
    index.drop("a");
    release();
    expect((await loading).map((e) => e.key).sort()).toEqual(["b", "c"]);
  });

  it("retries a failed first scan on the next read", async () => {
    const { kv } = pagedKv();
    await kv.set("s", "a", { key: "a", status: "pending", payload: "" });
    let fail = true;
    const flaky = {
      ...kv,
      async *iterate<T>(scope: string): AsyncGenerator<T[]> {
        if (fail) throw new Error("boom");
        yield* kv.iterate<T>(scope);
      },
    };
    const index = new RowIndex<Row, Entry>(flaky as never, "s", strip);
    await expect(index.entries()).rejects.toThrow("boom");
    fail = false;
    expect((await index.entries()).map((e) => e.key)).toEqual(["a"]);
  });

  it("keeps the old copy and its writes when a reload fails", async () => {
    const { kv } = pagedKv();
    await kv.set("s", "a", { key: "a", status: "pending", payload: "" });
    let fail = false;
    const flaky = {
      ...kv,
      async *iterate<T>(scope: string): AsyncGenerator<T[]> {
        if (fail) throw new Error("boom");
        yield* kv.iterate<T>(scope);
      },
    };
    const index = new RowIndex<Row, Entry>(flaky as never, "s", strip);
    await index.entries();
    fail = true;
    const reloading = index.reload();
    index.put({ key: "b", status: "pending", payload: "" });
    await expect(reloading).rejects.toThrow("boom");
    expect((await index.entries()).map((e) => e.key)).toEqual(["a", "b"]);
  });
});

const ENV = {
  AGENTMEMORY_CAPTURE_MAX_ATTEMPTS: "3",
  AGENTMEMORY_CAPTURE_RETRY_INTERVAL_MS: "10000",
  AGENTMEMORY_CAPTURE_DEAD_MAX: "2",
};

type Mode = "ok" | "fail" | "empty" | "dup";

function payload(marker: string, mode: Mode) {
  return {
    hookType: "post_tool_use",
    sessionId: "ses_inbox",
    project: "proj",
    cwd: "/work/proj",
    timestamp: new Date().toISOString(),
    data: { tool_name: "Bash", tool_input: { command: marker }, mode },
  };
}

const markerOf = (row: InboxRecord) => (row.payload.data as { tool_input: { command: string } }).tool_input.command;

type OriginalStatus = {
  pending: number;
  retrying: number;
  dead: number;
  oldestAcceptedAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
};

/** The sweep pick list and status as the code computed them before the index, from a fresh read of every row. */
function freshScan(rows: InboxRecord[], now: number): { due: string[]; status: OriginalStatus } {
  const entries = rows.map(({ payload: _payload, ...entry }) => entry);
  const due = entries
    .filter((r) => r.status !== "dead")
    .filter((r) => r.status === "pending" || !r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now)
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))
    .map((r) => r.key);
  const live = entries.filter((r) => r.status !== "dead");
  const next = live
    .map((r) => r.nextAttemptAt)
    .filter((v): v is string => typeof v === "string")
    .sort()[0];
  const lastFailed = entries.filter((r) => r.lastError).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    due,
    status: {
      pending: entries.filter((r) => r.status === "pending").length,
      retrying: entries.filter((r) => r.status === "retrying").length,
      dead: entries.filter((r) => r.status === "dead").length,
      oldestAcceptedAt: live.map((r) => r.acceptedAt).sort()[0] ?? null,
      nextAttemptAt: next ?? null,
      lastError: lastFailed?.lastError ?? null,
    },
  };
}

describe("capture inbox index", () => {
  let now: number;

  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    now = Date.UTC(2026, 10, 18, 12, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function boot() {
    const { registerCaptureFunctions } = await import("../src/functions/capture.js");
    const { kv, scans, store } = pagedKv();
    const calls: string[] = [];
    const failing = new Set<string>();
    const observe = async (input: unknown) => {
      const p = input as { observationId: string; data: { tool_input: { command: string }; mode: Mode } };
      const marker = p.data.tool_input.command;
      calls.push(marker);
      if (p.data.mode === "fail" && failing.has(marker)) throw new Error(`observe failed for ${marker}`);
      if (p.data.mode === "empty") return {};
      if (p.data.mode === "dup") return { deduplicated: true };
      return { observationId: p.observationId, success: true };
    };
    const sdk = mockSdk({ looseTrigger: true });
    sdk.fns.set("mem::observe", observe);
    const controller = registerCaptureFunctions(sdk as never, kv as never);
    const capture = (marker: string, mode: Mode) =>
      sdk.trigger("mem::capture", { payload: payload(marker, mode) }) as Promise<Record<string, unknown>>;
    const rows = () => [...(store.get(KV.captureInbox)?.values() ?? [])] as InboxRecord[];
    const inboxScans = () => scans.filter((s) => s === KV.captureInbox).length;
    const freshController = async () => {
      const fresh = registerCaptureFunctions(mockSdk({ looseTrigger: true }) as never, kv as never);
      return (await fresh.status()).inbox;
    };
    return { sdk, kv, store, controller, capture, rows, calls, failing, inboxScans, freshController };
  }

  async function expectSameAsFreshScan(h: Awaited<ReturnType<typeof boot>>) {
    const expected = freshScan(h.rows(), Date.now());
    expect((await h.controller.status()).inbox).toEqual(expected.status);
    expect(await h.freshController()).toEqual(expected.status);
    return expected;
  }

  it("matches a fresh full scan through capture, retries, dead letters and prune", async () => {
    const h = await boot();
    for (const marker of ["a", "b", "c", "d", "e"]) h.failing.add(marker);
    const advance = (ms: number) => {
      now += ms;
      vi.setSystemTime(now);
    };

    await h.capture("ok-1", "ok");
    await h.capture("a", "fail");
    advance(5);
    await h.capture("b", "fail");
    advance(5);
    await h.capture("c", "fail");
    advance(5);
    await h.capture("dead-1", "empty");
    advance(5);
    await h.capture("dup-1", "dup");
    await expectSameAsFreshScan(h);
    expect(h.rows().map((r) => r.status).sort()).toEqual(["dead", "retrying", "retrying", "retrying"]);

    for (const step of [0, 4000, 6000, 15_000, 60_000]) {
      advance(step);
      const expected = await expectSameAsFreshScan(h);
      const dueMarkers = expected.due.map((key) => markerOf(h.rows().find((r) => r.key === key)!));
      h.calls.length = 0;
      const swept = await h.controller.sweep();
      expect(h.calls).toEqual(dueMarkers);
      expect(swept.processed).toBe(dueMarkers.length);
      await expectSameAsFreshScan(h);
    }
    expect(h.rows().some((r) => r.status === "dead")).toBe(true);

    h.failing.delete("c");
    advance(15 * 60_000);
    const dueMarkers = freshScan(h.rows(), Date.now()).due.map((key) => markerOf(h.rows().find((r) => r.key === key)!));
    h.calls.length = 0;
    await h.controller.sweep();
    expect(h.calls).toEqual(dueMarkers);
    await expectSameAsFreshScan(h);

  });

  it("picks due rows in acceptedAt order, the order the full scan gave", async () => {
    const h = await boot();
    for (const marker of ["a", "b", "c"]) h.failing.add(marker);
    await h.capture("a", "fail");
    now += 10;
    vi.setSystemTime(now);
    await h.capture("b", "fail");
    now += 10;
    vi.setSystemTime(now);
    await h.capture("c", "fail");
    h.failing.clear();
    now += 60_000;
    vi.setSystemTime(now);
    const expected = freshScan(h.rows(), now);
    expect(expected.due).toHaveLength(3);
    h.calls.length = 0;
    await h.controller.sweep();
    expect(h.calls).toEqual(["a", "b", "c"]);
    expect(h.rows()).toHaveLength(0);
  });

  it("reads the inbox once for any number of sweeps and status calls, and once per prune", async () => {
    const h = await boot();
    await h.capture("a", "fail");
    h.failing.add("a");
    await h.controller.status();
    const afterLoad = h.inboxScans();
    expect(afterLoad).toBe(1);
    for (let i = 0; i < 5; i++) {
      await h.controller.sweep();
      await h.controller.status();
    }
    expect(h.inboxScans()).toBe(afterLoad);
    await h.controller.prune();
    expect(h.inboxScans()).toBe(afterLoad + 1);
    await h.controller.sweep();
    expect(h.inboxScans()).toBe(afterLoad + 1);
  });

  it("enforces the inbox cap from the index", async () => {
    vi.stubEnv("AGENTMEMORY_CAPTURE_INBOX_MAX", "2");
    const h = await boot();
    h.failing.add("a");
    h.failing.add("b");
    h.failing.add("c");
    await h.capture("a", "fail");
    await h.capture("b", "fail");
    expect(await h.capture("c", "fail")).toMatchObject({ status: "rejected", retryable: true });
    h.failing.clear();
    now += 60_000;
    vi.setSystemTime(now);
    await h.controller.sweep();
    expect(await h.capture("c", "ok")).toMatchObject({ status: "accepted", state: "completed" });
  });

  it("prunes dead letters beyond the cap and keeps the index in step", async () => {
    const h = await boot();
    for (const marker of ["d1", "d2", "d3"]) {
      await h.capture(marker, "empty");
      now += 1000;
      vi.setSystemTime(now);
    }
    expect((await h.controller.status()).inbox?.dead).toBe(3);
    expect(await h.controller.prune()).toBe(1);
    const status = await expectSameAsFreshScan(h);
    expect(status.status.dead).toBe(2);
    expect(h.rows().map(markerOf).sort()).toEqual(["d2", "d3"]);
  });

  it("shows a row written outside the process after the next prune, and drops a vanished row when the sweep finds it gone", async () => {
    const h = await boot();
    h.failing.add("a");
    await h.capture("a", "fail");
    await h.controller.status();
    const [row] = h.rows();
    h.store.get(KV.captureInbox)!.set("cap_outside", { ...row!, key: "cap_outside", eventId: "evs_outside" });
    expect((await h.controller.status()).inbox?.retrying).toBe(1);
    h.store.get(KV.captureInbox)!.delete(row!.key);
    now += 60_000;
    vi.setSystemTime(now);
    await h.controller.sweep();
    expect((await h.controller.status()).inbox?.retrying).toBe(0);
    await h.controller.prune();
    expect((await h.controller.status()).inbox?.retrying).toBe(1);
    await expectSameAsFreshScan(h);
  });

  it("lists the same rows and retries them by key or event id", async () => {
    const h = await boot();
    h.failing.add("a");
    h.failing.add("b");
    await h.capture("a", "fail");
    now += 10;
    vi.setSystemTime(now);
    await h.capture("b", "fail");
    const listed = (await h.sdk.trigger("mem::capture-list", { status: "retrying" })) as { total: number; items: Array<{ key: string }> };
    expect(listed.total).toBe(2);
    expect(listed.items.map((i) => i.key).sort()).toEqual(h.rows().map((r) => r.key).sort());
    const target = h.rows()[0]!;
    h.failing.clear();
    expect(await h.sdk.trigger("mem::capture-retry", { key: target.key })).toEqual({ matched: 1, recovered: 1, dead: 0, waiting: 0 });
    expect(await h.sdk.trigger("mem::capture-retry", { all: true })).toEqual({ matched: 1, recovered: 1, dead: 0, waiting: 0 });
    expect(h.rows()).toHaveLength(0);
    await expectSameAsFreshScan(h);
  });
});

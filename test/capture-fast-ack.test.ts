import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

type Req = { function_id: string; payload: Record<string, unknown> };
type Store = Map<string, Map<string, unknown>>;
type Call = { fn: string; scope: string };

const SESSION = "ses_fastack";
const OBS_SCOPE = `mem:obs:${SESSION}`;
const WHOLE_SCOPE_READS = new Set(["state::list", "state::list_keys"]);

/**
 * The real StateKV over an in-memory engine, with every state call logged. Each boot imports
 * fresh modules, so a second boot on the same store behaves like a restarted process: the first
 * boot's locks and queued work are gone, only the store survives.
 */
async function boot(store: Store, opts: { cap?: number; gate?: Promise<void>; inboxScan?: Promise<void> } = {}) {
  vi.resetModules();
  const { StateKV } = await import("../src/state/kv.js");
  const { withObservationStats } = await import("../src/fork/kv/observation-stats.js");
  const { registerObserveFunction } = await import("../src/functions/observe.js");
  const { registerCaptureFunctions } = await import("../src/functions/capture.js");
  const { captureStatusCode } = await import("../src/triggers/api.js");
  const { DedupMap } = await import("../src/functions/dedup.js");
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  const calls: Call[] = [];
  const observed: string[] = [];
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const sdk = {
    registerFunction: (id: string | { id: string }, fn: (payload: unknown) => Promise<unknown>) =>
      functions.set(typeof id === "string" ? id : id.id, fn),
    registerTrigger: () => {},
    trigger: async (req: Req) => {
      const p = req.payload as { scope: string; key: string; value?: unknown };
      if (req.function_id.startsWith("state::")) calls.push({ fn: req.function_id, scope: p.scope });
      if (req.function_id === "state::list_keys" && p.scope === "mem:capture:inbox" && opts.inboxScan) await opts.inboxScan;
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return { new_value: p.value };
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list": return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
        case "state::list_groups": return { groups: [...store.keys()] };
      }
      const fn = functions.get(req.function_id);
      return fn ? fn(req.payload) : null;
    },
  };
  const kv = withObservationStats(new StateKV(sdk as never, { backend: "redis" }));
  registerObserveFunction(sdk as never, kv, new DedupMap(), opts.cap ?? 5000);
  const observe = functions.get("mem::observe")!;
  functions.set("mem::observe", async (payload) => {
    if (opts.gate) await opts.gate;
    observed.push((payload as { eventId: string }).eventId);
    return observe(payload);
  });
  const controller = registerCaptureFunctions(sdk as never, kv, {});
  const accept = async (n: number, sessionId = SESSION) => {
    const result = (await sdk.trigger({
      function_id: "mem::capture",
      payload: {
        defer: true,
        eventId: `evt_fastack_${n.toString().padStart(6, "0")}`,
        payload: {
          hookType: "post_tool_use", sessionId, project: "p", cwd: "/w",
          timestamp: new Date(Date.UTC(2026, 10, 27, 12, 0, n)).toISOString(),
          data: { tool_name: "Read", tool_input: { file: `f${n}.ts` }, tool_output: `out ${n}` },
        },
      },
    })) as Record<string, unknown>;
    return { result, status: captureStatusCode(result as never) };
  };
  const rows = (sessionId = SESSION) =>
    [...(store.get(`mem:obs:${sessionId}`)?.values() ?? [])] as Array<{ id: string; eventId?: string; captureKey?: string }>;
  const inbox = () => [...(store.get("mem:capture:inbox")?.values() ?? [])] as Array<{ status: string; lastError?: string }>;
  return { calls, observed, controller, accept, rows, inbox };
}

describe("capture route answers before processing", () => {
  beforeEach(() => vi.stubEnv("AGENTMEMORY_CAPTURE_RETRY_INTERVAL_MS", "60000"));
  afterEach(() => vi.unstubAllEnvs());

  it("acknowledges with 202 after the inbox write alone, then stores the observation once", async () => {
    const store: Store = new Map();
    let open!: () => void;
    const h = await boot(store, { gate: new Promise<void>((resolve) => (open = resolve)) });
    for (let i = 0; i < 20; i++) await h.accept(i);
    h.calls.length = 0;

    const { result, status } = await h.accept(100);

    expect(status).toBe(202);
    expect(result).toMatchObject({ status: "accepted", state: "pending", observationId: expect.stringMatching(/^obs_/) });
    expect(h.calls.length).toBeLessThanOrEqual(3);
    expect(h.calls.filter((c) => c.scope.startsWith("mem:obs") || c.scope === "mem:sessions")).toEqual([]);
    expect(h.rows()).toHaveLength(0);

    open();
    await h.controller.idle();
    expect(h.rows()).toHaveLength(21);
    expect(h.rows().map((r) => r.id)).toContain(result.observationId);
    expect(h.inbox()).toEqual([]);
  });

  it("reads no whole session per capture, on the request path or in processing", async () => {
    const store: Store = new Map();
    const h = await boot(store);
    for (let i = 0; i < 30; i++) await h.accept(i);
    await h.controller.idle();
    h.calls.length = 0;

    for (let i = 30; i < 40; i++) await h.accept(i);
    await h.controller.idle();

    expect(h.rows()).toHaveLength(40);
    expect(h.calls.filter((c) => WHOLE_SCOPE_READS.has(c.fn) && c.scope.startsWith("mem:obs"))).toEqual([]);
    expect(h.calls.length / 10).toBeLessThanOrEqual(22);
  });

  it("answers the first capture after a restart without waiting for the inbox scan", async () => {
    const store: Store = new Map([["mem:capture:inbox", new Map<string, unknown>()]]);
    for (let i = 0; i < 500; i++) {
      store.get("mem:capture:inbox")!.set(`cap_dead${i}`, {
        key: `cap_dead${i}`, eventId: `evt_dead_${i}`, eventSource: "client", sessionId: "ses_old", project: "p",
        hookType: "post_tool_use", observationId: `obs_dead_${i}`, status: "dead", attempts: 5,
        acceptedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", payload: {},
      });
    }
    let finishScan!: () => void;
    const h = await boot(store, { inboxScan: new Promise<void>((resolve) => (finishScan = resolve)) });

    const { status } = await h.accept(1);

    expect(status).toBe(202);
    finishScan();
    await h.controller.idle();
    expect(h.rows()).toHaveLength(1);
  });

  it("stores every acknowledged capture exactly once after the process dies before processing", async () => {
    const store: Store = new Map();
    const crashed = await boot(store, { gate: new Promise<void>(() => {}) });
    const acked: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { result, status } = await crashed.accept(i);
      expect(status).toBe(202);
      acked.push(result.observationId as string);
    }
    expect(crashed.rows()).toHaveLength(0);

    const restarted = await boot(store);
    await restarted.controller.sweep();
    for (let i = 0; i < 25; i++) {
      const { status } = await restarted.accept(i);
      expect([200, 202]).toContain(status);
    }
    await restarted.controller.idle();

    const ids = restarted.rows().map((r) => r.id).sort();
    expect(ids).toEqual([...acked].sort());
    expect(new Set(restarted.rows().map((r) => r.captureKey)).size).toBe(25);
    expect(restarted.inbox()).toEqual([]);
  });

  it("answers a resend of a pending capture as a duplicate", async () => {
    const store: Store = new Map();
    let open!: () => void;
    const h = await boot(store, { gate: new Promise<void>((resolve) => (open = resolve)) });
    const first = await h.accept(1);
    const again = await h.accept(1);
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.result).toMatchObject({ status: "duplicate", state: "pending", observationId: first.result.observationId });
    open();
    await h.controller.idle();
    expect((await h.accept(1)).status).toBe(200);
    expect(h.rows()).toHaveLength(1);
  });

  it("processes one session's captures in the order they were accepted", async () => {
    const store: Store = new Map();
    let open!: () => void;
    const h = await boot(store, { gate: new Promise<void>((resolve) => (open = resolve)) });
    await Promise.all(Array.from({ length: 12 }, (_, i) => h.accept(i, i % 2 ? "ses_odd" : SESSION)));
    open();
    await h.controller.idle();
    const order = (prefix: (n: number) => boolean) =>
      h.observed.map((id) => Number(id.slice(-6))).filter(prefix);
    expect(order((n) => n % 2 === 0)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(order((n) => n % 2 === 1)).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it("keeps a capture past the session cap as a replayable dead letter", async () => {
    const store: Store = new Map();
    const h = await boot(store, { cap: 3 });
    for (let i = 0; i < 5; i++) expect((await h.accept(i)).status).toBe(202);
    await h.controller.idle();
    expect(h.rows()).toHaveLength(3);
    expect(h.inbox()).toHaveLength(2);
    expect(h.inbox().every((r) => r.status === "dead" && /Session observation limit reached/.test(r.lastError ?? ""))).toBe(true);
  });
});

import { vi } from "vitest";
import { pinItem } from "../../../src/fork/retention/pin.js";
import { registerRetention, type RetentionOptions } from "../../../src/fork/retention/register.js";
import { registerRetentionTriggers } from "../../../src/fork/retention/rest.js";
import type { RetentionEnv } from "../../../src/fork/retention/settings.js";
import type { StateKV } from "../../../src/state/kv.js";
import { checkAuth, requireConfiguredSecret } from "../../../src/triggers/api.js";
import { retentionHarness } from "./harness.js";
import { observation, type Rig } from "./move-fixtures.js";
import { sealedSession } from "./plan-fixtures.js";
import { goldenCase, uncapped, writeCases } from "./sweep-fixtures.js";

export const SECRET = "s3cret";

export type Route = "sweep" | "restore" | "purge" | "pin" | "report";
export interface Reply {
  readonly status_code: number;
  readonly body: Record<string, unknown>;
}

interface Call {
  readonly body?: unknown;
  readonly query?: Record<string, string>;
  readonly token?: string | null;
}

/** An HTTP request shaped like the engine's: POST carries a JSON body, GET carries query params. */
export function httpRequest(route: Route, { body, query, token = SECRET }: Call = {}): never {
  const get = route === "report";
  return {
    method: get ? "GET" : "POST",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
    query_params: query ?? {},
  } as never;
}

/** `secret` null is a stack with no AGENTMEMORY_SECRET. */
export function restRoutes(h: ReturnType<typeof retentionHarness>, secret: string | null = SECRET) {
  registerRetentionTriggers(h.sdk as never, secret ?? undefined, { checkAuth, requireConfiguredSecret });
  return async (route: Route, call: Call = {}): Promise<Reply> => {
    const handler = h.functions.get(`api::retention-${route}`);
    if (!handler) throw new Error(`api::retention-${route} is not registered`);
    return (await handler(httpRequest(route, call))) as Reply;
  };
}

/** A harness whose `mem::retention-*` functions are spies, so a test sees exactly what the route passed on. */
export function spiedRoutes(secret: string | null = SECRET) {
  const h = retentionHarness();
  const spies = {
    sweep: vi.fn(async (_payload: unknown): Promise<unknown> => ({ kind: "done" })),
    restore: vi.fn(async (_payload: unknown): Promise<unknown> => ({ kind: "done" })),
    purge: vi.fn(async (_payload: unknown): Promise<unknown> => ({ kind: "done" })),
    pin: vi.fn(async (_payload: unknown): Promise<unknown> => ({ kind: "pinned" })),
    report: vi.fn(async (_payload: unknown): Promise<unknown> => ({ kind: "found" })),
  };
  for (const [route, spy] of Object.entries(spies)) h.functions.set(`mem::retention-${route}`, spy);
  return { h, spies, call: restRoutes(h, secret) };
}

export const ENFORCE: RetentionEnv = {
  AM_RETENTION: "enforce",
  AM_RETENTION_WINDOWS: "trim:1,obs:1,sup:1,cold:1",
  AM_RETENTION_GRACE_DAYS: "1",
};

/** The real `mem::retention-*` functions over a rig, on a clock the test moves, behind the REST routes. */
export function liveRoutes(r: Rig, clock: { now: Date }, over: Partial<RetentionOptions> & { kv?: StateKV; secret?: string } = {}) {
  const { kv, secret, ...options } = over;
  r.h.functions.set("mem::smart-search", async (payload: unknown) => ({
    results: (await r.runtime.keyword.search((payload as { query: string }).query, 10)).map((hit) => ({ obsId: hit.obsId })),
  }));
  Object.assign(r.runtime, { openPersistence: () => ({ scheduleSave: () => {}, save: async () => {} }) });
  const timers = registerRetention(r.h.sdk as never, kv ?? r.kv, {
    env: ENFORCE,
    deps: { search: r.deps.search, vectors: r.deps.vectors, now: () => clock.now },
    ...options,
  });
  return { call: restRoutes(r.h, secret ?? SECRET), timers };
}

/**
 * A pinned observation that a golden recall case finds, so an enforcing sweep has a case to score and one row that
 * stays live. Returns the cases file. The first-run cap is lifted, because a fixture this small would round it to zero.
 */
export async function anchor(r: Rig): Promise<string> {
  await sealedSession(r, "ses_keep", 0, { rows: [observation("k1", "ses_keep", { title: "quokka migration plan", narrative: "quokka k1 narrative" })] });
  await pinItem(r.deps, { ref: { kind: "observation", sessionId: "ses_keep", id: "k1" }, who: "owner", reason: "golden evidence" });
  await uncapped(r);
  return writeCases({ cases: [goldenCase("anchor", "quokka", ["k1"])] });
}

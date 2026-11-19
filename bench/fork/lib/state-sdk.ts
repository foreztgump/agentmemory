import { createSearchHandlers, type WorkerEngines } from "../../../src/fork/worker/router.js";

/** state::* over a Map, so the real StateKV and its scope guard run unchanged. */
export function stateSdk() {
  const scopes = new Map<string, Map<string, unknown>>();
  const of = (scope: string) => scopes.get(scope) ?? scopes.set(scope, new Map()).get(scope)!;
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const state: Record<string, (p: { scope: string; key: string; value?: unknown }) => unknown> = {
    "state::get": ({ scope, key }) => clone(of(scope).get(key) ?? null),
    "state::set": ({ scope, key, value }) => (of(scope).set(key, clone(value)), value),
    "state::delete": ({ scope, key }) => void of(scope).delete(key),
    "state::list": ({ scope }) => [...of(scope).values()].map(clone),
    "state::list_keys": ({ scope }) => [...of(scope).keys()],
  };
  const functions = new Map<string, (data: unknown) => Promise<unknown>>();
  return {
    registerFunction: (id: string, fn: (data: unknown) => Promise<unknown>) => void functions.set(id, fn),
    registerTrigger: () => {},
    trigger: async (req: { function_id: string; payload?: unknown }) => {
      const s = state[req.function_id];
      if (s) return s(req.payload as never);
      const fn = functions.get(req.function_id);
      if (fn) return fn(req.payload ?? {});
      return undefined;
    },
  };
}

/** The am-search worker in-process: the real router over real engines, reached through the wire's JSON. */
export function workerSdk(engines: WorkerEngines) {
  const handlers = createSearchHandlers(engines, 6) as Record<string, (data: unknown) => Promise<unknown>>;
  return {
    trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
      const handler = handlers[function_id];
      if (!handler) throw new Error(`No function: ${function_id}`);
      return JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(payload ?? {})))));
    },
  };
}


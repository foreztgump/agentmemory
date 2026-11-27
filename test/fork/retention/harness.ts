import { InvocationError } from "iii-sdk";
import { StateKV } from "../../../src/state/kv.js";

export type Req = { function_id: string; payload: Record<string, unknown>; timeoutMs?: number };

/**
 * `invocationTimeoutMs` plays the SDK's worker-wide invocation timeout: a function call that outlasts it (or the call's own
 * `timeoutMs`) rejects with the SDK's TIMEOUT error while the function keeps running, as in production.
 * `beforeTrigger` runs before every trigger, state ops included, so a test can hold one write.
 */
export interface HarnessHooks {
  invocationTimeoutMs?: number;
  beforeTrigger?: (req: Req) => Promise<void> | void;
}

function bounded<T>(run: Promise<T>, timeoutMs: number | undefined, functionId: string): Promise<T> {
  if (timeoutMs === undefined) return run;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new InvocationError({ code: "TIMEOUT", message: `invocation timed out after ${timeoutMs}ms`, function_id: functionId })), timeoutMs);
    run.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export function retentionHarness() {
  const store = new Map<string, Map<string, unknown>>();
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  const calls: string[] = [];
  const stateOps: string[] = [];
  const hooks: HarnessHooks = {};
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const sdk = {
    registerFunction: (id: string | { id: string }, fn: (payload: unknown) => Promise<unknown>) =>
      functions.set(typeof id === "string" ? id : id.id, fn),
    registerTrigger: () => {},
    trigger: async (req: Req) => {
      calls.push(req.function_id);
      await hooks.beforeTrigger?.(req);
      const p = req.payload as { scope: string; key: string; value?: unknown };
      if (req.function_id.startsWith("state::")) stateOps.push(`${req.function_id} ${p.scope ?? ""}`);
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": {
          const had = scope(p.scope).has(p.key);
          const old_value = scope(p.scope).get(p.key);
          scope(p.scope).set(p.key, structuredClone(p.value));
          return had ? { old_value, new_value: structuredClone(p.value) } : { new_value: structuredClone(p.value) };
        }
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list": return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
        case "state::list_groups": return { groups: [...store.keys()].filter((k) => store.get(k)!.size > 0) };
      }
      const fn = functions.get(req.function_id);
      return fn ? bounded(fn(req.payload), req.timeoutMs ?? hooks.invocationTimeoutMs, req.function_id) : null;
    },
  };
  const kv = new StateKV(sdk as never, { backend: "redis" });
  const call = (id: string, payload: unknown = {}) =>
    sdk.trigger({ function_id: id, payload: payload as Record<string, unknown> });
  return { store, functions, calls, stateOps, hooks, sdk, kv, call };
}

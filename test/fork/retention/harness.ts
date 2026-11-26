import { StateKV } from "../../../src/state/kv.js";

export type Req = { function_id: string; payload: Record<string, unknown> };

export function retentionHarness() {
  const store = new Map<string, Map<string, unknown>>();
  const functions = new Map<string, (payload: unknown) => Promise<unknown>>();
  const calls: string[] = [];
  const stateOps: string[] = [];
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
      const p = req.payload as { scope: string; key: string; value?: unknown };
      if (req.function_id.startsWith("state::")) stateOps.push(`${req.function_id} ${p.scope ?? ""}`);
      switch (req.function_id) {
        case "state::get": return structuredClone(store.get(p.scope)?.get(p.key) ?? null);
        case "state::set": scope(p.scope).set(p.key, structuredClone(p.value)); return p.value;
        case "state::delete": store.get(p.scope)?.delete(p.key); return null;
        case "state::list": return [...(store.get(p.scope)?.values() ?? [])].map((v) => structuredClone(v));
        case "state::list_keys": return { keys: [...(store.get(p.scope)?.keys() ?? [])] };
        case "state::list_groups": return { groups: [...store.keys()].filter((k) => store.get(k)!.size > 0) };
      }
      const fn = functions.get(req.function_id);
      return fn ? fn(req.payload) : null;
    },
  };
  const kv = new StateKV(sdk as never, { backend: "redis" });
  const call = (id: string, payload: unknown = {}) =>
    sdk.trigger({ function_id: id, payload: payload as Record<string, unknown> });
  return { store, functions, calls, stateOps, sdk, kv, call };
}

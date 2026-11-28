import { StateKV } from "../../src/state/kv.js";

type Payload = { scope: string; key?: string; value?: unknown };

/**
 * A real redis-backed StateKV over an in-memory engine where every state call costs one event-loop turn,
 * the stand-in for one round trip to the engine and Kvrocks (TEE-1451). `measure` reports the reads a call
 * made and `depth`, the round trips on its longest chain of reads that waited on each other: a loop that
 * awaits each read in turn adds one per read, a batch run together adds one.
 */
export function readCostKV() {
  const store = new Map<string, Map<string, unknown>>();
  const cost = { gets: 0, lists: 0, listKeys: 0 };
  let clock = 0;
  const roundTrip = () => {
    const startedAt = clock;
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        clock = Math.max(clock, startedAt + 1);
        resolve();
      }),
    );
  };
  const rows = (scope: string) => store.get(scope) ?? new Map<string, unknown>();
  const sdk = {
    trigger: async ({ function_id, payload }: { function_id: string; payload: Payload }) => {
      await roundTrip();
      switch (function_id) {
        case "state::get":
          cost.gets++;
          return structuredClone(rows(payload.scope).get(payload.key!) ?? null);
        case "state::list":
          cost.lists++;
          return [...rows(payload.scope).values()].map((row) => structuredClone(row));
        case "state::list_keys":
          cost.listKeys++;
          return { keys: [...rows(payload.scope).keys()] };
        case "state::set":
          seed(payload.scope, payload.key!, payload.value);
          return { new_value: payload.value };
        case "state::delete":
          store.get(payload.scope)?.delete(payload.key!);
          return null;
        default:
          throw new Error(`read-cost kv does not implement ${function_id}`);
      }
    },
  };
  const seed = (scope: string, key: string, value: unknown) => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)!.set(key, structuredClone(value));
  };
  const measure = async <T>(run: () => Promise<T>) => {
    cost.gets = 0;
    cost.lists = 0;
    cost.listKeys = 0;
    clock = 0;
    const out = await run();
    return { out, reads: cost.gets + cost.lists + cost.listKeys, ...cost, depth: clock };
  };
  return { kv: new StateKV(sdk as never, { backend: "redis" }), seed, measure };
}

export function captureFunctions() {
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: (id: string | { id: string }, fn: (data: unknown) => Promise<unknown>) =>
      handlers.set(typeof id === "string" ? id : id.id, fn),
    registerTrigger: () => {},
    trigger: async () => null,
  };
  const call = <T = unknown>(id: string, data: unknown) => {
    const fn = handlers.get(id);
    if (!fn) throw new Error(`no function ${id}`);
    return fn(data) as Promise<T>;
  };
  return { sdk, call };
}

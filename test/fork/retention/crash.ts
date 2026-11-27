import type { RetentionDeps } from "../../../src/fork/retention/satellites.js";
import { Vault } from "../../../src/fork/retention/vault.js";

export class Crash extends Error {
  constructor() {
    super("injected crash");
  }
}

const KV_WRITES = new Set(["set", "update", "delete"]);
const INDEX_WRITES = new Set(["add", "remove"]);

function counted<T extends object>(target: T, writes: ReadonlySet<string>, tick: () => void): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && writes.has(prop)) return (...args: unknown[]) => { tick(); return value.apply(t, args); };
      return value.bind(t);
    },
  });
}

/**
 * The same deps and vault, except that the `n`th write to the state store, the keyword index or the vector
 * store throws `Crash` before it lands. So a displace or reinstate run through them stops after exactly
 * `n - 1` writes, at every step boundary the operation has. A run that finishes means `n` is past its last write.
 */
export function crashingAt(deps: RetentionDeps, n: number): { deps: RetentionDeps; vault: Vault } {
  let left = n;
  const tick = () => {
    if (--left <= 0) throw new Crash();
  };
  const kv = counted(deps.kv, KV_WRITES, tick);
  const search = () => {
    const runtime = deps.search();
    return { ...runtime, keyword: counted(runtime.keyword, INDEX_WRITES, tick), vector: runtime.vector && counted(runtime.vector, INDEX_WRITES, tick) };
  };
  return { deps: { ...deps, kv, search }, vault: new Vault(kv) };
}

export async function crashed(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    if (error instanceof Crash) return true;
    throw error;
  }
}

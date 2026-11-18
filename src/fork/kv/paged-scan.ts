import type { StateKV } from "../../state/kv.js";

/**
 * Reads a scope page by page and keeps only what `pick` returns, so callers that need a few
 * fields of every row never hold the whole collection. Falls back to one `list` for KV
 * doubles that do not implement `iterate`.
 */
export async function scanRows<T, R>(kv: StateKV, scope: string, pick: (row: T) => R): Promise<R[]> {
  const out: R[] = [];
  if (typeof kv.iterate !== "function") {
    for (const row of await kv.list<T>(scope)) if (row) out.push(pick(row));
    return out;
  }
  for await (const page of kv.iterate<T>(scope)) {
    for (const row of page) if (row) out.push(pick(row));
  }
  return out;
}

export async function countRows(kv: StateKV, scope: string): Promise<number> {
  if (typeof kv.listKeys === "function") return (await kv.listKeys(scope)).length;
  return (await kv.list(scope)).length;
}

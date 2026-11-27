// Shared helpers for the retention staging scripts (TEE-1158 slice 12). They run in the replica's client container
// (bench/fork/retention/stage.sh run <script>), which reaches agentmemory, Kvrocks and Qdrant on the internal network.
import { connectRedis, type Redis, type Reply } from "../../../scripts/fork/lib/resp.js";

export const AM_URL = process.env.S12_AM_URL ?? "http://agentmemory:3111";
export const SECRET = process.env.S12_SECRET ?? "replica-dummy-secret";
export const STORE_URL = process.env.S12_STORE_URL ?? "";
export const QDRANT_URL = process.env.S12_QDRANT_URL ?? "http://qdrant:6333";
export const QDRANT_KEY = process.env.S12_QDRANT_KEY ?? "replica-dummy-qdrant-key";

export interface AmResponse<T = any> {
  readonly status: number;
  readonly body: T;
  readonly ms: number;
}

/** One REST call with the replica's secret. The body is parsed as JSON when it is JSON. */
export async function am<T = any>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 6 * 3600_000): Promise<AmResponse<T>> {
  const started = Date.now();
  const res = await fetch(`${AM_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed as T, ms: Date.now() - started };
}

export async function qdrant<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: { "api-key": QDRANT_KEY, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { result: T }).result;
}

export const redis = (): Promise<Redis> => connectRedis(STORE_URL);
export const text = (reply: Reply): string => (Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply));

/** State keys of the iii redis adapter: `state:<scope>`, a hash of key -> JSON. */
export async function stateKeys(r: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const reply = (await r.call("SCAN", cursor, "MATCH", "state:*", "COUNT", "1000")) as Reply[];
    cursor = text(reply[0]!);
    for (const key of reply[1] as Reply[]) keys.push(text(key));
  } while (cursor !== "0");
  return keys;
}

/** One scope family name per hash, as `replica.sh counts` groups them. Retention vaults keep their run id. */
export function familyOf(scope: string): string {
  return scope
    .replace(/^mem:obs:.*/, "mem:obs:<session>")
    .replace(/^mem:index:bm25:vec:\d+$/, "mem:index:bm25:vec:<bucket>")
    .replace(/^mem:idx:obs:\d+$/, "mem:idx:obs:<shard>")
    .replace(/^mem:capture:events:.*/, "mem:capture:events:<shard>")
    .replace(/^mem:audit:\d{4}-\d{2}$/, "mem:audit:<month>")
    .replace(/^mem:emb:.*/, "mem:emb:<obs>");
}

/** Bookkeeping that a dry run may write: retention's own scopes and the audit trail. */
export const isBookkeeping = (family: string): boolean => family.startsWith("mem:retention:") || family.startsWith("mem:audit:");

export interface ScopeCounts {
  /** Records per scope family (HLEN summed over the family's hashes). */
  readonly records: Readonly<Record<string, number>>;
  /** Hashes per family. */
  readonly scopes: Readonly<Record<string, number>>;
}

export async function scopeCounts(r?: Redis): Promise<ScopeCounts> {
  const own = r === undefined;
  const conn = r ?? (await redis());
  try {
    const keys = await stateKeys(conn);
    const records: Record<string, number> = {};
    const scopes: Record<string, number> = {};
    for (let i = 0; i < keys.length; i += 500) {
      const slice = keys.slice(i, i + 500);
      const lens = await conn.pipeline(slice.map((k) => ["HLEN", k]));
      slice.forEach((key, j) => {
        const family = familyOf(key.slice("state:".length));
        records[family] = (records[family] ?? 0) + Number(lens[j]);
        scopes[family] = (scopes[family] ?? 0) + 1;
      });
    }
    return { records: sortKeys(records), scopes: sortKeys(scopes) };
  } finally {
    if (own) conn.close();
  }
}

const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export interface QdrantCounts {
  readonly points: number;
  /** Points that are not tombstones (`deleted` is not true). */
  readonly live: number;
  /** Live points that carry a stored vector (`dense` is true). Null when the count call failed (see `denseError`), never 0. */
  readonly liveDense: number | null;
  readonly denseError?: string;
}

const NOT_DELETED = { must_not: [{ key: "deleted", match: { value: true } }] };

/** Exact point counts of every collection. `liveDense` is only asked of the docs layout, which has the `dense` index. */
export async function qdrantCounts(): Promise<Record<string, QdrantCounts>> {
  const list = (await qdrant<{ collections: { name: string }[] }>("GET", "/collections")).collections.map((c) => c.name).sort();
  const out: Record<string, QdrantCounts> = {};
  for (const name of list) {
    const count = async (filter?: unknown): Promise<number> =>
      (await qdrant<{ count: number }>("POST", `/collections/${name}/points/count`, { exact: true, ...(filter ? { filter } : {}) })).count;
    let dense: number | null = null;
    let denseError: string | undefined;
    try {
      dense = await count({ must: [{ key: "dense", match: { value: true } }], ...NOT_DELETED });
    } catch (err) {
      denseError = err instanceof Error ? err.message : String(err);
    }
    out[name] = { points: await count(), live: await count(NOT_DELETED), liveDense: dense, ...(denseError ? { denseError } : {}) };
  }
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  return value === undefined || value.startsWith("--") ? fallback : value;
}

/** A required flag: prints the usage line and exits 2 when it is missing, so a script never runs with `undefined`. */
export function requireArg(name: string, usage: string): string {
  const value = arg(name);
  if (value === undefined) {
    console.error(`missing --${name}; usage: ${usage}`);
    process.exit(2);
  }
  return value;
}
export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** The longest `runSweepRoute` waits for the run to close after the route's 504: a run killed mid-apply never closes by itself. */
export const MAX_POLL_MS = Number(process.env.S12_POLL_MAX_MS ?? 3 * 3600_000);

/**
 * One sweep through the REST route. The route answers 504 after 180 s, the invocation timeout of the agentmemory worker, while
 * the sweep goes on; unless `poll` is false this waits until the newest run is closed and returns its id. `ms` is the wall time
 * from the call to the run's `closedAt`. After `MAX_POLL_MS` it gives up with `pollTimedOut` set and no run id.
 */
export async function runSweepRoute(dryRun: boolean, poll = true): Promise<AmResponse & { runId?: string; pollTimedOut?: boolean }> {
  const started = Date.now();
  const res = await am("POST", "/agentmemory/retention/sweep", { dryRun }).catch((err): AmResponse => ({ status: 0, body: { error: String(err) }, ms: Date.now() - started }));
  let runId: string | undefined = res.body?.runId;
  if ((res.status === 504 || res.status === 0) && poll) {
    for (;;) {
      const row = (await am("GET", "/agentmemory/retention/report", undefined, 120_000).catch(() => null))?.body?.run;
      const closed = row?.phase === "done" ? Date.parse(row.closedAt ?? "") : Number.NaN;
      if (closed >= started - 5_000) {
        runId = row.id;
        return { ...res, runId, ms: closed - started };
      }
      if (Date.now() - started > MAX_POLL_MS) {
        console.error(`no closed run ${Math.round((Date.now() - started) / 1000)} s after the sweep call; newest run: ${row ? `${row.id} phase=${row.phase}` : "unreadable"}`);
        return { ...res, runId: undefined, pollTimedOut: true, ms: Date.now() - started };
      }
      await sleep(5000);
    }
  }
  return { ...res, runId, ms: Date.now() - started };
}

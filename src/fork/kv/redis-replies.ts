import { logger } from "../../logger.js";

/**
 * iii's redis state adapter (state worker 0.22.22) sends every call over one connection behind a lock
 * and fails any reply slower than redis-rs's default response timeout, 500 ms, with no setting and no
 * retry. The only reads it offers are HGETALL (`state::list`), HKEYS (`state::list_keys`) and a point
 * read (`state::get`), so `StateKV` keeps each reply small itself:
 * - `list` reads the keys first and sends one HGETALL only when the scope holds at most
 *   WHOLE_LIST_MAX_KEYS rows; a larger scope is read row by row.
 * - HKEYS still grows with the scope. `noteRedisKeys` warns once per scope when a listed scope passes
 *   KEYS_WARN_COUNT, a growth doubling before HKEYS reaches the limit.
 * - A `state::set` or `state::delete` whose reply times out is retried up to
 *   STATE_WRITE_RETRY_DELAYS_MS.length times inside the key's lock, then rethrown. Both are absolute
 *   and the one connection applies a late first command before the retry, so the end state is one
 *   application. `state::update` is never retried: its ops may increment or append.
 * ponytail: HKEYS has no smaller form through iii; past ~85k keys in one listed scope, shard the scope
 * or get a paged `state::list_keys` (HSCAN) into the state worker.
 */

/** 500 rows of the largest rows measured (observations, 2.8 KB) is 1.4 MB, under 40 ms cold. */
export const WHOLE_LIST_MAX_KEYS = 500;

/** HKEYS measured at up to 5.9 us/key cold at 3x main's data, so 40k keys is about half the limit. */
export const KEYS_WARN_COUNT = 40_000;

const ADAPTER_LIST_TIMEOUT = /Failed to get group from Redis: .*timed out/;

export function isRedisListTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ADAPTER_LIST_TIMEOUT.test(message);
}

const ADAPTER_WRITE_TIMEOUT = /Failed to atomically (?:set|delete) value (?:in|from) Redis: .*timed out/;

export function isRedisWriteTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ADAPTER_WRITE_TIMEOUT.test(message);
}

const warnedScopes = new Set<string>();

export function noteRedisKeys(scope: string, count: number): void {
  if (count <= KEYS_WARN_COUNT || warnedScopes.has(scope)) return;
  warnedScopes.add(scope);
  logger.warn("state: a listed redis scope is nearing the adapter's reply limit; shard it or page its keys", {
    scope,
    keys: count,
    warnAt: KEYS_WARN_COUNT,
  });
}

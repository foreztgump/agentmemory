/**
 * iii's redis state adapter sends every call over one connection and fails any reply slower
 * than the redis client's default response timeout (about 500 ms), with no retry. On Kvrocks a
 * whole-scope `state::list` of a large scope (a 2,000-observation session is about 10 MB) can
 * cross that under boot load, where Valkey answers in about 20 ms. `StateKV.list` then reads the
 * same scope again through `list_keys` and point reads, each far below the limit.
 */
const ADAPTER_LIST_TIMEOUT = /Failed to get group from Redis: .*timed out/;

export function isRedisListTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ADAPTER_LIST_TIMEOUT.test(message);
}

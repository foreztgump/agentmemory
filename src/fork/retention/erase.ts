import type { StateKV } from "../../state/kv.js";
import type { ItemRef } from "./types.js";

/**
 * Explicit forget reaches everything at once (D7, R10, R11). `mem::forget` keeps its immediate hard delete
 * and calls this once with the ids it deleted (seam in src/functions/remember.ts, about 3 lines), so the
 * call is visible at the one caller that needs it. No global KV-delete hook: evict, import-replace and
 * governance-delete keep their own behaviour (their L2/L3 fixes are separate upstream-able commits).
 *
 * For each observation id:
 *   - graph: find nodes and edges through the `observation` and `edgeObservation` postings and mark them
 *     stale with mutateIndexedGraphRecord, the path mem::cascade-update uses; graph queries already skip
 *     stale items. Marked stale, not deleted, in phase 1 (design 4.7).
 *   - session count: assign Session.observationCount from ObservationStats (L4).
 *   - retention copies: a vault entry and its locator (found through mem:retention:items by
 *     `itemKey(ref)`), or a demote record (a point read of mem:retention:demoted; demotes have no locator),
 *     is deleted, so a forgotten item cannot come back by restore. A ref that exists only in a vault (forget
 *     arrived during grace) is erased from there; forget's own not-found answer for it is replaced by
 *     "erased from trash". Observation refs carry their session: bare ids can repeat across imported sessions.
 */
export interface ErasedIds {
  readonly observations: readonly { id: string; sessionId: string }[];
  readonly memories: readonly string[];
}

export function afterForget(kv: StateKV, erased: ErasedIds): Promise<{ graphMarkedStale: number; vaultCopiesErased: number; demoteRecordsDeleted: number; sessionsRecounted: number }> {
  void kv;
  void erased;
  throw new Error("not implemented");
}

/** For refs forget did not find live: erase them from the vault or the demote records if retention holds them; returns the refs erased. */
export function eraseFromVault(kv: StateKV, refs: readonly ItemRef[]): Promise<readonly ItemRef[]> {
  void kv;
  void refs;
  throw new Error("not implemented");
}

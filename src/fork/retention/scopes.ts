import type { ItemRef, RunId } from "./types.js";

/**
 * Every retention scope, declared once. `src/state/schema.ts` re-exports them under `KV` as `retention*`
 * and `src/fork/kv/scope-classes.ts` classifies each one (AGENTS.md: new KV scopes).
 *
 *   vault(runId)  paged-only       key = itemKey(ref), value = VaultEntry; deleted whole when the run empties
 *   items         point-read-only  key = itemKey(ref), value = ItemLocator (which run holds it)
 *   demoted       paged-only       key = memory id, value = DemoteRecord
 *   runs          bounded          key = run id, value = RunRow (about 60 rows a year; D8)
 *   seals         paged-only       key = session id, value = SessionSeal
 *   pins          point-read-only  key = itemKey(ref), value = Pin
 *   tombstones    point-read-only  key = itemKey(observation ref), value = ObservationTombstone
 *   control       bounded          lease, enforced-run count, last report id
 *   reports       bounded          key = run id, value = RunReport (samples capped at 20 per stage)
 *   imageHolds    point-read-only  key = image file path, value = ImageHold (images.ts): the item keys of the vault entries that
 *                                  still hold a reference to the file, and the embedding row parked while no live row uses it
 *   activeDays    point-read-only  key = project, value = sorted day numbers with a session (clock.ts)
 *   sweepScratch  paged-only       key = bare observation id, value = 1: the cited-by-memory set once it passes
 *                                  RETENTION_SPILL_IDS (protect.ts). Point reads for membership; emptied by
 *                                  paging at sweep start and end. Keys are bare because sourceObservationIds
 *                                  are; an id two sessions share protects both rows, which errs toward
 *                                  keeping. The sweep lease admits one writer; a purge pass only reads it.
 */
export const RETENTION_KV = {
  vault: (runId: RunId) => `mem:retention:vault:${runId}`,
  items: "mem:retention:items",
  demoted: "mem:retention:demoted",
  runs: "mem:retention:runs",
  seals: "mem:retention:seals",
  pins: "mem:retention:pins",
  tombstones: "mem:retention:tombstones",
  control: "mem:retention:control",
  reports: "mem:retention:reports",
  imageHolds: "mem:retention:image-holds",
  activeDays: "mem:retention:active-days",
  sweepScratch: "mem:retention:sweep-scratch",
} as const;

/**
 * Key of one item in `vault(runId)`, `items`, `tombstones` and `pins`. Injective: the session id is
 * length-prefixed, so no pair of (session, observation) ids shares a key with another pair, whatever
 * characters an imported id holds. Memories are `memory:<id>`.
 */
export function itemKey(ref: ItemRef): string {
  return ref.kind === "memory" ? `memory:${ref.id}` : `obs:${ref.sessionId.length}:${ref.sessionId}:${ref.id}`;
}

export interface Pin {
  readonly ref: ItemRef;
  readonly who: string;
  readonly reason: string;
  readonly pinnedAt: string;
}

import type { RunId } from "./types.js";

/**
 * Every retention scope, declared once. Slice 1 re-exports these under `KV` in `src/state/schema.ts` and
 * classifies each in `src/fork/kv/scope-classes.ts` (AGENTS.md: new KV scopes). This sketch commit does
 * not register them yet: nothing reads or writes them until slice 1.
 *
 *   vault(runId)  paged-only       key = item id, value = VaultEntry; deleted whole when the run empties
 *   items         point-read-only  key = item id, value = ItemLocator (which run holds it)
 *   demoted       paged-only       key = memory id, value = DemoteRecord
 *   runs          bounded          key = run id, value = RunRow
 *   seals         paged-only       key = session id, value = SessionSeal
 *   pins          point-read-only  key = item id, value = Pin
 *   tombstones    point-read-only  key = observation id, value = ObservationTombstone
 *   control       bounded          lease, enforced-run count, last report id
 *   reports       bounded          key = run id, value = RunReport (samples capped at 20 per stage)
 *   imageHolds    point-read-only  key = image file path, value = number of references held in vaults
 *   activeDays    bounded          key = project, value = sorted day numbers with a session (clock.ts)
 */
export const RETENTION_KV = {
  vault: (runId: RunId | string) => `mem:retention:vault:${runId}`,
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
} as const;

export interface Pin {
  readonly id: string;
  readonly kind: "observation" | "memory";
  readonly who: string;
  readonly reason: string;
  readonly pinnedAt: string;
}

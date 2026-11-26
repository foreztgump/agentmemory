import type { StateKV } from "../../state/kv.js";
import type { ItemLocator, ItemRef, RunId, RunRow, VaultEntry } from "./types.js";

/**
 * The only holder of moved rows. One scope per run (`mem:retention:vault:<runId>`), plus the
 * `mem:retention:items` locator so restore and erase by ref are one point read. Every key is
 * `itemKey(ref)` (scopes.ts): observation ids repeat across imported sessions, so the session is part of the key.
 *
 * Access patterns:
 *   restore by run   page one run's scope (keys, then values in pages).
 *   restore by ref   items.get(itemKey(ref)) -> vault(runId).get(itemKey(ref)).
 *   erase by ref     the same two reads, then delete both (forget reaches trash copies, D7).
 *   purge by age     runs is bounded: visit runs with held > 0 and closedAt older than grace; page their scope.
 *   resume           runs with phase != "done"; the lease admits one.
 *
 * Ordering invariant (R12): `put` is written before the live row is deleted, and `take` is the last
 * step of a restore or purge. So a crash leaves at worst an item that is both live and in the vault,
 * never one that is in neither; `recoverRun` (move.ts) settles the doubles.
 */
export class Vault {
  constructor(private readonly kv: StateKV) {}

  /** Idempotent upsert of the entry and its locator. */
  put(entry: VaultEntry): Promise<void> {
    void entry;
    void this.kv;
    throw new Error("not implemented");
  }

  locate(ref: ItemRef): Promise<ItemLocator | null> {
    void ref;
    throw new Error("not implemented");
  }

  get(runId: RunId, ref: ItemRef): Promise<VaultEntry | null> {
    void runId;
    void ref;
    throw new Error("not implemented");
  }

  /** Keys first, then values in pages of `size`, so a run of any size holds one page in memory. */
  pages(runId: RunId, size: number): AsyncGenerator<readonly VaultEntry[]> {
    void runId;
    void size;
    throw new Error("not implemented");
  }

  /** Deletes the entry and its locator. After this the item exists only where restore or purge put it. */
  take(runId: RunId, ref: ItemRef): Promise<void> {
    void runId;
    void ref;
    throw new Error("not implemented");
  }

  /** Runs whose vault still holds restorable entries. */
  runsHolding(): Promise<readonly RunRow[]> {
    throw new Error("not implemented");
  }
}

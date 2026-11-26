import type { StateKV } from "../../state/kv.js";
import { RETENTION_KV, itemKey } from "./scopes.js";
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
 *                    `held` is kept by the sweep and purge (RunRow), not by `put` and `take`.
 *   resume           runs with phase != "done"; the lease admits one.
 *
 * Ordering invariant (R12): `put` is written before the live row is deleted, and `take` is the last
 * step of a restore or purge. So a crash leaves at worst an item that is both live and in the vault,
 * never one that is in neither; `recoverRun` (move.ts) settles the doubles.
 */
export class Vault {
  constructor(private readonly kv: StateKV) {}

  /** Idempotent upsert of the entry and its locator. The entry lands first, so a locator never points at nothing. */
  async put(entry: VaultEntry): Promise<void> {
    const key = itemKey(entry.ref);
    const locator: ItemLocator = { runId: entry.runId, stage: entry.stage };
    await this.kv.set(RETENTION_KV.vault(entry.runId), key, entry);
    await this.kv.set(RETENTION_KV.items, key, locator);
  }

  locate(ref: ItemRef): Promise<ItemLocator | null> {
    return this.kv.get<ItemLocator>(RETENTION_KV.items, itemKey(ref));
  }

  get(runId: RunId, ref: ItemRef): Promise<VaultEntry | null> {
    return this.kv.get<VaultEntry>(RETENTION_KV.vault(runId), itemKey(ref));
  }

  /** Keys first, then values in pages of `size`, so a run of any size holds one page in memory. */
  async *pages(runId: RunId, size: number): AsyncGenerator<readonly VaultEntry[]> {
    yield* this.kv.iterate<VaultEntry>(RETENTION_KV.vault(runId), { pageSize: size });
  }

  /**
   * Deletes the entry and its locator. After this the item exists only where restore or purge put it.
   * The locator goes first, and only if it still names this run, so a crash leaves an entry that the
   * run's paging finds again, and a later run's claim on the same item survives.
   */
  async take(runId: RunId, ref: ItemRef): Promise<void> {
    const key = itemKey(ref);
    const locator = await this.locate(ref);
    if (locator?.runId === runId) await this.kv.delete(RETENTION_KV.items, key);
    await this.kv.delete(RETENTION_KV.vault(runId), key);
  }

  /** Runs whose vault still holds restorable entries. */
  async runsHolding(): Promise<readonly RunRow[]> {
    return (await this.kv.list<RunRow>(RETENTION_KV.runs)).filter((run) => run.held > 0);
  }
}

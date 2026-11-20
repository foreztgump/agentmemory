import type { RetentionDeps } from "./satellites.js";
import type { Cleared } from "./protect.js";
import type { Reason, RunId, Stage, VaultEntry } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * Soft delete, trim or demote one cleared candidate. Only `Protector.clear` mints `Cleared`, so nothing
 * reaches this without its seal (T, O) or chain proof (S) and its protection verdict.
 *
 * trash (O, S, X): snapshot satellites, vault.put, delete the live row under the session's keyed lock
 *   after re-reading it (a row rewritten since the plan read it is skipped), detach satellites.
 *   Stage O sets seal.trimmed before the first row of a session moves.
 * trim (T): vault.put({source}), rewrite the row with `source: {hookType, originalBytes, truncated: true}`
 *   (the source-budget shape); the row stays live and indexed, the summary fingerprint is unchanged.
 * demote (C): write DemoteRecord (with the vector), set `memory.retention.demotedAt`, remove from both
 *   indexes. `hiddenFromIndex` keeps rebuild and reconcile from re-adding it.
 */
export function displace(deps: RetentionDeps, vault: Vault, runId: RunId, item: Cleared): Promise<{ moved: boolean; bytes: number }> {
  void deps;
  void vault;
  void runId;
  void item;
  throw new Error("not implemented");
}

/**
 * The inverse of displace for one entry: row back (trash) or `source` back (trim) unless a live row
 * now exists with a different fingerprint (then keep the live row and drop the entry), attach
 * satellites, vault.take. For a demote: clear the mark, reattach from DemoteRecord.vector, delete the record.
 * Never embeds (R3). Idempotent.
 */
export function reinstate(deps: RetentionDeps, vault: Vault, entry: VaultEntry): Promise<{ restored: boolean; reembedNeeded: boolean }> {
  void deps;
  void vault;
  void entry;
  throw new Error("not implemented");
}

/**
 * Settles a run that crashed mid-apply (R12). For each entry of the run: live row present with the
 * entry's fingerprint -> finish the move (delete row, detach); live row absent -> detach again
 * (idempotent). After this no id is both live and in the vault, and every satellite matches the row.
 * Called first by every sweep that finds its run row unfinished.
 */
export function recoverRun(deps: RetentionDeps, vault: Vault, runId: RunId): Promise<{ finished: number; detachedAgain: number }> {
  void deps;
  void vault;
  void runId;
  throw new Error("not implemented");
}

export interface MoveRequest {
  readonly stage: Stage;
  readonly reason: Reason;
}

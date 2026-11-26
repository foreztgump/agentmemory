import type { RetentionDeps } from "./satellites.js";
import type { Cleared } from "./protect.js";
import type { CompressedObservation, Memory } from "../../types.js";
import type { DemoteRecord, RunId, VaultEntry } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * The one definition of `EntryBase.rowFingerprint`: displace writes it, reinstate and recoverRun compare it.
 * An observation hashes the summary fingerprint's field set (id, type, title, narrative, facts, files,
 * concepts; design 4.4), which excludes `source`, so the hash of the live row before a stage T rewrite
 * equals the hash after it. A memory hashes the full row.
 */
export function fingerprintRow(row: CompressedObservation | Memory): string {
  void row;
  throw new Error("not implemented");
}

/**
 * Soft delete, trim or demote one cleared candidate. Only `Protector.clear` mints `Cleared`, so nothing
 * reaches this without its seal (T, O) or chain proof (S) and its protection verdict.
 *
 * trash (O, S, X): snapshot satellites, vault.put, delete the live row under the session's keyed lock
 *   after re-reading it (a row rewritten since the plan read it is skipped), detach satellites.
 *   Stage O sets seal.trimmed before the first row of a session moves. The entry's rowFingerprint is
 *   `fingerprintRow` of the row as read here.
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
 * The inverse of displace for one entry: row back (trash) or `source` back (trim), attach satellites,
 * vault.take. Never embeds (R3). Idempotent.
 *
 * Fingerprint check, with `fingerprintRow` on the live row: a trash stage restores the row when none is
 * live; a live row with the entry's fingerprint is an earlier attempt that crashed before `take`, so it
 * only finishes (attach, take); a live row with another fingerprint was written since the move (a
 * recapture), stays, and the entry is dropped.
 * Trim restores `source` onto the live row only when its fingerprint equals `entry.rowFingerprint`; the
 * fingerprint excludes `source`, so the trimmed live row still matches, and a mismatch means the row was
 * rewritten since, so the live row stays and the entry is dropped.
 */
export function reinstate(deps: RetentionDeps, vault: Vault, entry: VaultEntry): Promise<{ restored: boolean; reembedNeeded: boolean }> {
  void deps;
  void vault;
  void entry;
  throw new Error("not implemented");
}

/** Un-demote: clear `retention.demotedAt`, reattach from `record.vector`, delete the record. Never embeds. */
export function reinstateDemote(deps: RetentionDeps, record: DemoteRecord): Promise<{ restored: boolean; reembedNeeded: boolean }> {
  void deps;
  void record;
  throw new Error("not implemented");
}

/**
 * Settles a run that crashed mid-apply (R12), per disposition. Called first by every sweep that finds its
 * run row unfinished.
 *  trash: live row present with the entry's fingerprint -> finish the move (delete row, detach); live row
 *    absent -> detach again. After this no trashed id is both live and in the vault.
 *  trim: finish rewriting the live row's `source` to the truncated shape when `fingerprintRow(live)` equals
 *    the entry's rowFingerprint. That fingerprint hashes only fields that survive a trim (it excludes
 *    `source`), so a row not yet rewritten and one already rewritten both match; a mismatch means the row
 *    was rewritten since and stays as it is. The entry stays in the vault until purge or restore; for a
 *    trim, live row plus vault entry is the normal state.
 *  demote: the record is written first, then the mark, then the index removals, so re-running the demote
 *    for every DemoteRecord of the run converges. They are found by a paged pass over
 *    mem:retention:demoted filtered by runId (small: memories only).
 *
 * Counts: `finished` is a trashed id settled, a trim rewrite completed or a demote replayed;
 * `detachedAgain` is trash only.
 */
export function recoverRun(deps: RetentionDeps, vault: Vault, runId: RunId): Promise<{ finished: number; detachedAgain: number }> {
  void deps;
  void vault;
  void runId;
  throw new Error("not implemented");
}

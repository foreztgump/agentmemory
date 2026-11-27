import { createHash } from "node:crypto";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import { KV } from "../../state/schema.js";
import type { CompressedObservation, Memory } from "../../types.js";
import { demoteLocked, MEMORY_LOCK, recoverDemotes } from "./demote.js";
import { hiddenFromIndex } from "./indexable.js";
import type { Cleared } from "./protect.js";
import { SATELLITES, type RetentionDeps } from "./satellites.js";
import { itemKey, RETENTION_KV } from "./scopes.js";
import { RETENTION_PAGE_SIZE } from "./settings.js";
import {
  STAGE_DISPOSITION,
  type ItemRef, type RowEntry, type RunId, type SatelliteSnapshots, type SessionSeal, type TrimEntry, type VaultEntry,
} from "./types.js";
import type { Vault } from "./vault.js";

export type Live = CompressedObservation | Memory;
type ObservationRef = Extract<ItemRef, { kind: "observation" }>;

/**
 * The one definition of `EntryBase.rowFingerprint`: displace writes it, reinstate and recoverRun compare it.
 * An observation hashes the summary fingerprint's field set (id, type, title, narrative, facts, files,
 * concepts; design 4.4), which excludes `source`, so the hash of the live row before a stage T rewrite
 * equals the hash after it. A memory hashes the full row in a canonical form (object keys sorted, arrays
 * kept in order), so a row rebuilt with its fields in another order hashes the same.
 */
export function fingerprintRow(row: Live): string {
  const shape = "narrative" in row ? [row.id, row.type, row.title, row.narrative, row.facts, row.files, row.concepts] : canonical(row);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

export const scopeOf = (ref: ItemRef): string => (ref.kind === "memory" ? KV.memories : KV.observations(ref.sessionId));

/**
 * The lock every writer of the row holds: summarize publishes under `obs:<session>`, `mem::remember` and
 * `mem::forget` under `mem:remember`. The keyed mutex is not reentrant, so nothing inside it may call `sealSession`.
 */
export const lockOf = (ref: ItemRef): string => (ref.kind === "memory" ? MEMORY_LOCK : `obs:${ref.sessionId}`);

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

type Source = NonNullable<CompressedObservation["source"]>;
const truncatedSource = (source: Source): Source => ({ hookType: source.hookType, originalBytes: source.originalBytes, truncated: true });

export interface DisplaceResult {
  readonly moved: boolean;
  readonly bytes: number;
  /**
   * Why nothing moved. `unreadable`: a satellite could not be read, in practice the stored vector, so the row stays
   * live (a rejected read is not "no vector"). `row-changed`: the live row was rewritten after the plan read it.
   * `already-demoted`: a stage C candidate whose live row was marked between the plan and this hold.
   * `pinned`: a pin landed after the Protector judged the item. `pinItem` writes under the same lock, so whichever runs
   * second sees the other: a pin first stops the move here, a move first leaves the pin to un-demote or to purge's recheck.
   */
  readonly skipped?: "unreadable" | "row-changed" | "gone" | "nothing-to-trim" | "already-demoted" | "pinned";
}

const NOT_MOVED = (skipped: NonNullable<DisplaceResult["skipped"]>): DisplaceResult => ({ moved: false, bytes: 0, skipped });

async function snapshotSatellites(deps: RetentionDeps, ref: ItemRef, row: unknown): Promise<SatelliteSnapshots> {
  const snapshots: SatelliteSnapshots[] = [];
  for (const satellite of SATELLITES) {
    if (satellite.appliesTo.includes(ref.kind) && satellite.snapshot) snapshots.push(await satellite.snapshot(deps, ref, row));
  }
  return Object.assign({}, ...snapshots) as SatelliteSnapshots;
}

async function detachSatellites(deps: RetentionDeps, entry: VaultEntry): Promise<void> {
  for (const satellite of SATELLITES) if (satellite.appliesTo.includes(entry.ref.kind)) await satellite.detach?.(deps, entry);
}

async function attachSatellites(deps: RetentionDeps, entry: VaultEntry): Promise<{ reembedNeeded: boolean }> {
  let reembedNeeded = false;
  for (const satellite of SATELLITES) {
    if (!satellite.appliesTo.includes(entry.ref.kind)) continue;
    const attached = await satellite.attach?.(deps, entry);
    reembedNeeded = reembedNeeded || attached?.reembedNeeded === true;
  }
  return { reembedNeeded };
}

/**
 * Soft delete, trim or demote one cleared candidate. Only `Protector.clear` mints `Cleared`, so nothing
 * reaches this without its seal (T, O) or chain proof (S) and its protection verdict.
 *
 * Every stage first re-reads, under the item's keyed lock, the pin `Protector.judge` read before it: a pinned item is never moved.
 * trash (O, S, X): under the item's keyed lock re-read the row (a row rewritten since the plan read it is
 *   skipped), snapshot satellites from it (a read that rejects refuses the row), set seal.trimmed for stage O,
 *   vault.put, delete the live row, detach satellites. The entry's rowFingerprint is `fingerprintRow` of the
 *   row as read here. The snapshot is inside the lock, so it is of the state that is deleted.
 * trim (T): vault.put({source}), rewrite the row with `source: {hookType, originalBytes, truncated: true}`
 *   (the source-budget shape); the row stays live and indexed, the summary fingerprint is unchanged.
 * demote (C): under `mem:remember`, snapshot the stored vector (a read that rejects refuses the row), then `demoteLocked`
 *   (demote.ts): record with the vector, the mark on the row, index removals. The row stays in `mem:memories`, and a
 *   memory that is already marked is skipped.
 */
export async function displace(deps: RetentionDeps, vault: Vault, runId: RunId, item: Cleared): Promise<DisplaceResult> {
  const disposition = STAGE_DISPOSITION[item.stage];
  const { ref } = item;
  return withKeyedLock(lockOf(ref), async () => {
    const [live, pin] = await Promise.all([deps.kv.get<Live>(scopeOf(ref), ref.id), deps.kv.get(RETENTION_KV.pins, itemKey(ref))]);
    if (!live) return NOT_MOVED("gone");
    if (pin) return NOT_MOVED("pinned");
    const rowFingerprint = fingerprintRow(live);
    if (rowFingerprint !== fingerprintRow(item.row)) return NOT_MOVED("row-changed");
    if (item.stage === "C" && hiddenFromIndex(live as Memory)) return NOT_MOVED("already-demoted");
    let satellites: SatelliteSnapshots = {};
    if (disposition !== "trim") {
      try {
        satellites = await snapshotSatellites(deps, ref, live);
      } catch {
        return NOT_MOVED("unreadable");
      }
    }
    const base = { runId, reason: item.reason, movedAt: deps.now().toISOString(), project: item.project, rowFingerprint, satellites };
    if (item.stage === "T") return trimRow(deps, vault, base, item.ref, live as CompressedObservation);
    if (item.stage === "C") return demoteLocked(deps, base, live as Memory);
    if (item.stage === "O") await markTrimmed(deps, item.ref.sessionId, item.proof.seal);
    const entry = { ...base, stage: item.stage, ref, row: live } as RowEntry;
    await vault.put(entry);
    await deps.kv.delete(scopeOf(ref), ref.id);
    await detachSatellites(deps, entry);
    return { moved: true, bytes: sizeOf(live) };
  });
}

/** Before the first row of the session moves, from the proof when the stored seal is gone, so the summarize veto holds from then on. */
async function markTrimmed(deps: RetentionDeps, sessionId: string, proven: SessionSeal): Promise<void> {
  const stored = await deps.kv.get<SessionSeal>(RETENTION_KV.seals, sessionId);
  if (!stored?.trimmed) await deps.kv.set<SessionSeal>(RETENTION_KV.seals, sessionId, { ...(stored ?? proven), trimmed: true });
}

async function trimRow(
  deps: RetentionDeps,
  vault: Vault,
  base: Omit<TrimEntry, "stage" | "ref" | "source">,
  ref: ObservationRef,
  live: CompressedObservation,
): Promise<DisplaceResult> {
  const { source } = live;
  if (!source || source.truncated) return NOT_MOVED("nothing-to-trim");
  await vault.put({ ...base, stage: "T", ref, source });
  await deps.kv.set(KV.observations(ref.sessionId), ref.id, { ...live, source: truncatedSource(source) });
  return { moved: true, bytes: sizeOf(source) };
}

export interface ReinstateResult {
  readonly restored: boolean;
  readonly reembedNeeded: boolean;
  /** A trim entry whose row is not live now: it stays in the vault, because the row may come back (a trashed one is restored first). */
  readonly deferred?: boolean;
}

/**
 * The inverse of displace for one entry: row back (trash) or `source` back (trim), attach satellites,
 * vault.take. Never embeds (R3). Idempotent. All under the item's keyed lock.
 *
 * Fingerprint check, with `fingerprintRow` on the live row: a trash stage restores the row when none is
 * live; a live row with the entry's fingerprint is an earlier attempt that crashed before `take`, so it
 * only finishes (attach, take); a live row with another fingerprint was written since the move (a
 * recapture), stays, and the entry is dropped.
 * Trim restores `source` onto the live row only when its fingerprint equals `entry.rowFingerprint`; the
 * fingerprint excludes `source`, so the trimmed live row still matches, and a mismatch means the row was
 * rewritten since, so the live row stays and the entry is dropped. A trim entry with no live row is deferred.
 *
 * `entry.restoring` is written before the first change, so recoverRun can tell a restore under way from a
 * move under way. An entry that purge has marked `purging`, or whose image reference is released (purge, or a
 * forget that crashed after it), is deferred: its first irreversible step has begun, so purge finishes it and nothing
 * brings the row back.
 *
 * `listed` is only a key: the entry is read again once the lock is held, because a caller that read it from a page
 * may have waited while a purge, forget or other restore changed or took it. A stale copy would bring back a row
 * whose image, access log and tombstone are settled, and rewrite a vault key purge already took. Null when the
 * entry is gone.
 */
export function reinstate(deps: RetentionDeps, vault: Vault, listed: VaultEntry): Promise<ReinstateResult | null> {
  return withKeyedLock(lockOf(listed.ref), async () => {
    const entry = await vault.get(listed.runId, listed.ref);
    return entry ? reinstateLocked(deps, vault, entry) : null;
  });
}

/**
 * What `reinstateLocked` does with an entry, given its live row (null when none) as read under the item lock. Pure, so a
 * dry run can count what an enforcing pass would do without writing. `drop`: the live row was rewritten since the move,
 * so it stays and the entry goes. `deferred`: purge has begun on the entry, or a trim entry has no live row to restore into.
 */
export function reinstatement(entry: VaultEntry, live: Live | null): "restore" | "drop" | "deferred" {
  if (entry.purging || entry.imageReleased) return "deferred";
  if (live && fingerprintRow(live) !== entry.rowFingerprint) return "drop";
  if (entry.stage === "T" && !live) return "deferred";
  return "restore";
}

/** `reinstate` for a caller that already holds `lockOf(entry.ref)`: the keyed mutex is not reentrant, so a caller holding it must not call `reinstate`. */
export async function reinstateLocked(deps: RetentionDeps, vault: Vault, entry: VaultEntry): Promise<ReinstateResult> {
  const { ref } = entry;
  const live = await deps.kv.get<Live>(scopeOf(ref), ref.id);
  const decision = reinstatement(entry, live);
  if (decision === "deferred") return { restored: false, reembedNeeded: false, deferred: true };
  if (decision === "drop") {
    await vault.take(entry.runId, ref);
    return { restored: false, reembedNeeded: false };
  }
  if (!entry.restoring) await vault.update({ ...entry, restoring: true });
  if (entry.stage === "T") {
    await deps.kv.set(scopeOf(ref), ref.id, { ...live, source: entry.source });
    await vault.take(entry.runId, ref);
    return { restored: true, reembedNeeded: false };
  }
  if (!live) await deps.kv.set(scopeOf(ref), ref.id, entry.row);
  const { reembedNeeded } = await attachSatellites(deps, entry);
  await vault.take(entry.runId, ref);
  return { restored: true, reembedNeeded };
}

/**
 * Settles a run that crashed mid-apply (R12), per disposition. Called first by every sweep that finds its
 * run row unfinished. Each entry is settled under the item's keyed lock, and `put`'s locator is repaired
 * under the same hold, from the entry as it is stored once the lock is held: the page was read earlier, and
 * a restore that ran in between has changed or taken the entry (an entry that is gone is skipped).
 *  restoring: the entry was being restored; finish it (reinstate), never undo it.
 *  trash: live row present with the entry's fingerprint -> finish the move (delete row, detach); live row
 *    absent -> detach again; a live row with another fingerprint was rewritten since and stays, and the entry
 *    is dropped. After this no trashed id is both live and in the vault.
 *  trim: finish rewriting the live row's `source` to the truncated shape when `fingerprintRow(live)` equals
 *    the entry's rowFingerprint. That fingerprint hashes only fields that survive a trim (it excludes
 *    `source`), so a row not yet rewritten and one already rewritten both match; a mismatch means the row
 *    was rewritten since and stays as it is. The entry stays in the vault until purge or restore; for a
 *    trim, live row plus vault entry is the normal state.
 *  demote: `recoverDemotes` (demote.ts), the run's records in `mem:retention:demoted`, each under `mem:remember`.
 *
 * Counts: `finished` is a move, a restore or a trim rewrite completed; `detachedAgain` is a trash entry whose
 * row was already gone and had its detach run again.
 */
export async function recoverRun(deps: RetentionDeps, vault: Vault, runId: RunId): Promise<{ finished: number; detachedAgain: number }> {
  let finished = 0;
  let detachedAgain = 0;
  for await (const page of vault.pages(runId, RETENTION_PAGE_SIZE)) {
    for (const listed of page) {
      const settled = await withKeyedLock(lockOf(listed.ref), async () => {
        const entry = await vault.get(runId, listed.ref);
        if (!entry) return "left";
        await vault.relocate(entry);
        if (!entry.restoring) return settle(deps, vault, entry);
        await reinstateLocked(deps, vault, entry);
        return "finished";
      });
      if (settled === "finished") finished++;
      else if (settled === "detached") detachedAgain++;
    }
  }
  const demoted = await recoverDemotes(deps, runId);
  return { finished: finished + demoted.finished, detachedAgain: detachedAgain + demoted.detachedAgain };
}

async function settle(deps: RetentionDeps, vault: Vault, entry: VaultEntry): Promise<"finished" | "detached" | "left"> {
  const { ref } = entry;
  const live = await deps.kv.get<Live>(scopeOf(ref), ref.id);
  const matches = live ? fingerprintRow(live) === entry.rowFingerprint : false;
  if (entry.stage === "T") {
    const source = (live as CompressedObservation | null)?.source;
    if (!matches || !source || source.truncated) return "left";
    await deps.kv.set(scopeOf(ref), ref.id, { ...live, source: truncatedSource(source) });
    return "finished";
  }
  if (live && !matches) {
    await vault.take(entry.runId, ref);
    return "left";
  }
  if (live) await deps.kv.delete(scopeOf(ref), ref.id);
  await detachSatellites(deps, entry);
  return live ? "finished" : "detached";
}

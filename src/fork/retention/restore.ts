import { safeAudit } from "../../functions/audit.js";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import { demotedBy, reinstateDemote, reinstateDemoteLocked } from "./demote.js";
import { lockOf, reinstate, reinstateLocked, type ReinstateResult } from "./move.js";
import { RunStore } from "./run-store.js";
import type { RetentionDeps } from "./satellites.js";
import { itemKey } from "./scopes.js";
import { RETENTION_PAGE_SIZE } from "./settings.js";
import type { ItemRef, RunId } from "./types.js";
import { Vault } from "./vault.js";

export interface RestoreResult {
  readonly restored: number;
  /** Items whose live row had been rewritten since the move; the live row was kept, the entry dropped. */
  readonly keptLive: number;
  /** Items that had no stored vector; the re-embed loop fills them (expected 0 when vectors were readable). */
  readonly reembedNeeded: number;
  /** Trim entries whose row is in another run's vault: they stay held, and a restore after that run's gives the source back. */
  readonly deferred: number;
}

const EMPTY: RestoreResult = { restored: 0, keptLive: 0, reembedNeeded: 0, deferred: 0 };

const add = (a: RestoreResult, b: RestoreResult): RestoreResult => ({
  restored: a.restored + b.restored,
  keptLive: a.keptLive + b.keptLive,
  reembedNeeded: a.reembedNeeded + b.reembedNeeded,
  deferred: a.deferred + b.deferred,
});

/** An entry that was not restored and not deferred was dropped because its live row had been rewritten. */
const outcome = (r: ReinstateResult): RestoreResult => ({
  restored: r.restored ? 1 : 0,
  keptLive: r.restored || r.deferred ? 0 : 1,
  reembedNeeded: r.reembedNeeded ? 1 : 0,
  deferred: r.deferred ? 1 : 0,
});

/**
 * `RunRow.held` follows the vault: the sweep adds to it, and restore and purge take away. Clamped, since the sweep owns the count.
 * The first reason a run was restored is kept: a later restore that finishes the job (each one is audited with its own reason) must not hide why it started.
 */
export async function release(runs: RunStore, runId: RunId, taken: number, why?: string): Promise<void> {
  const run = await runs.get(runId);
  const reason = run?.restoredBecause ?? why;
  if (run) await runs.save({ ...run, held: Math.max(0, run.held - taken), ...(reason === undefined ? {} : { restoredBecause: reason }) });
}

const taken = (result: RestoreResult) => result.restored + result.keptLive;

/**
 * `beat` runs before each batch of writes (each page and each run row write of `restoreRun`, each ref of `restoreItems`)
 * and throws when the caller's lease is lost, which stops the restore there; every step repeats safely.
 */
export interface RestoreOptions {
  readonly beat?: () => Promise<void>;
}

const noBeat = async (): Promise<void> => {};

async function audit(deps: RetentionDeps, ids: readonly string[], details: Record<string, unknown>, result: RestoreResult): Promise<void> {
  await safeAudit(deps.kv, "retention_restore", "mem::retention-restore", [...ids], { ...details, ...result });
}

/**
 * Restores every entry of a run, paged; the run row records why, and the sweep must re-read the row afterwards,
 * because `held` and `restoredBecause` change here. Audited (R13). Idempotent.
 *
 * A trim and a later stage O for one observation share a key. The locator keeps both (see `ItemLocator.under`),
 * and restore by run restores the entries of that run only: the stage O run first puts the trimmed row back,
 * and the trim run then gives the source back. A trim entry restored while the row sits in a later run's
 * vault is deferred, not dropped. Each entry is read again under its item lock (`reinstate`), so one that a purge
 * or forget took after the page was read is skipped.
 *
 * The run's demotes are un-demoted too and count in `restored`, but not in `held`, which counts vault entries only.
 * The audit entry is written even when the restore stops part way (a lost lease, a failed write), with what it did.
 */
export async function restoreRun(deps: RetentionDeps, runId: RunId, why: string, { beat = noBeat }: RestoreOptions = {}): Promise<RestoreResult> {
  const vault = new Vault(deps.kv);
  const runs = new RunStore(deps.kv, deps.now);
  await beat();
  await release(runs, runId, 0, why);
  let result = EMPTY;
  try {
    for await (const page of vault.pages(runId, RETENTION_PAGE_SIZE)) {
      await beat();
      for (const listed of page) {
        const one = await reinstate(deps, vault, listed);
        if (one) result = add(result, outcome(one));
      }
    }
    await beat();
    await release(runs, runId, taken(result));
    let scanned = 0;
    for await (const record of demotedBy(deps.kv, runId)) {
      if (scanned++ % RETENTION_PAGE_SIZE === 0) await beat();
      const one = await reinstateDemote(deps, record.memoryId);
      if (one) result = add(result, outcome(one));
    }
  } finally {
    await audit(deps, [runId], { runId, why }, result);
  }
  return result;
}

/**
 * Restores single items, located through mem:retention:items by `itemKey(ref)` (one point read each).
 * Takes refs, not bare ids: observation ids can repeat across imported sessions. An item with two claims, a trim
 * and a later stage O, is restored newest first, so one ref gives back the whole row. A memory ref is un-demoted
 * last, so a memory that was demoted and then soft deleted comes back live and indexed.
 *
 * One ref's claims are walked under its item lock, so the locator read, the stale-claim cleanup and each
 * reinstate see one state, against `displace` and `recoverRun`. A run is visited once per ref, so a locator that
 * keeps naming a run it already named cannot loop.
 */
export async function restoreItems(deps: RetentionDeps, refs: readonly ItemRef[], why: string, { beat = noBeat }: RestoreOptions = {}): Promise<RestoreResult> {
  const vault = new Vault(deps.kv);
  const runs = new RunStore(deps.kv, deps.now);
  let result = EMPTY;
  try {
    for (const ref of refs) {
      await beat();
      const claimed: Claimed[] = [];
      const demoted: ReinstateResult[] = [];
      try {
        await withKeyedLock(lockOf(ref), () => restoreClaims(deps, vault, ref, claimed, demoted));
      } finally {
        for (const { runId, one } of claimed) {
          result = add(result, one);
          await release(runs, runId, taken(one));
        }
        for (const one of demoted) result = add(result, outcome(one));
      }
    }
  } finally {
    await audit(deps, refs.map(itemKey), { why }, result);
  }
  return result;
}

interface Claimed {
  readonly runId: RunId;
  readonly one: RestoreResult;
}

/** The caller holds `lockOf(ref)`; `reinstateLocked` is the variant that assumes it. */
async function restoreClaims(deps: RetentionDeps, vault: Vault, ref: ItemRef, claimed: Claimed[], demoted: ReinstateResult[]): Promise<void> {
  const visited = new Set<RunId>();
  for (let claim = await vault.locate(ref); claim && !visited.has(claim.runId); claim = await vault.locate(ref)) {
    visited.add(claim.runId);
    const entry = await vault.get(claim.runId, ref);
    if (!entry) {
      await vault.take(claim.runId, ref);
      continue;
    }
    const one = outcome(await reinstateLocked(deps, vault, entry));
    claimed.push({ runId: claim.runId, one });
    if (one.deferred) break;
  }
  const undemoted = ref.kind === "memory" ? await reinstateDemoteLocked(deps, ref.id) : null;
  if (undemoted) demoted.push(undemoted);
}

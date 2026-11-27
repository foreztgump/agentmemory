import { randomUUID } from "node:crypto";
import { safeAudit } from "../../functions/audit.js";
import { deleteFacetsForTargets } from "../../functions/facets.js";
import { logger } from "../../logger.js";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import type { StateKV } from "../../state/kv.js";
import { loadActiveClock, MS_PER_DAY } from "./clock.js";
import { lockOf, reinstatement, reinstateLocked, scopeOf, type Live, type ReinstateResult } from "./move.js";
import { createProtector, type Protector } from "./protect.js";
import { RunStore } from "./run-store.js";
import { SATELLITES, type RetentionDeps } from "./satellites.js";
import { itemKey, RETENTION_KV } from "./scopes.js";
import { RETENTION_PAGE_PAUSE_MS, RETENTION_PAGE_SIZE, type RetentionSettings } from "./settings.js";
import type { ItemRef, ObservationTombstone, RunId, RunRow, VaultEntry } from "./types.js";
import { Vault } from "./vault.js";

export interface PurgeResult {
  /** Entries finished: their vault copy is gone for good. A dry run counts what it would finish. */
  readonly purged: number;
  /** Became protected during grace (pinned, cited, accessed, important) and went back instead. */
  readonly restoredBack: number;
  /** Entries whose live row had been rewritten since the move: the live row stayed, the vault copy was dropped. */
  readonly dropped: number;
  /**
   * Entries left in the vault: a protected trim entry whose row sits in another run's vault, still restorable from there.
   * A trim entry whose row is neither live nor vaulted has nothing to restore into and is purged, protected or not.
   */
  readonly deferred: number;
  readonly runsEmptied: number;
}

const NOTHING: PurgeResult = { purged: 0, restoredBack: 0, dropped: 0, deferred: 0, runsEmptied: 0 };

const sum = (a: PurgeResult, b: PurgeResult): PurgeResult => ({
  purged: a.purged + b.purged,
  restoredBack: a.restoredBack + b.restoredBack,
  dropped: a.dropped + b.dropped,
  deferred: a.deferred + b.deferred,
  runsEmptied: a.runsEmptied + b.runsEmptied,
});

export interface PurgeOptions {
  /**
   * Called before every page of a run's vault, and between each entry's recheck and its commit; it throws when the lease
   * is lost, and the pass stops. A sweep that takes the lease clears `sweepScratch`, so a spilled Protector's recheck
   * would read an empty cited set: the beat after the recheck stops purge before it commits on that answer.
   */
  readonly beat?: () => Promise<void>;
  /** Report what would happen, with the counts an enforcing pass would return: protection is checked, nothing is written. */
  readonly dryRun?: boolean;
  /** Tests only: the pause between pages, RETENTION_PAGE_PAUSE_MS otherwise. */
  readonly pauseMs?: number;
}

/**
 * Finished runs whose grace period has elapsed and whose vault still holds entries. The grace is the run's own
 * snapshot (`RunRow.graceDays`) counted from `closedAt`; an unfinished run, a dry run and a purged run are never due.
 */
export async function dueRuns(kv: StateKV, now: Date): Promise<RunRow[]> {
  return (await new Vault(kv).runsHolding())
    .filter((run) => run.phase === "done" && !run.dryRun && run.closedAt !== undefined && now.getTime() - Date.parse(run.closedAt) >= run.graceDays * MS_PER_DAY)
    .sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""));
}

interface Pass {
  readonly deps: RetentionDeps;
  readonly protect: Protector;
  readonly now: Date;
  readonly vault: Vault;
  readonly runs: RunStore;
  readonly dryRun: boolean;
  readonly pauseMs: number;
  readonly beat: () => Promise<void>;
}

/**
 * The only irreversible retention step (R4). For every due run, page its vault and settle each entry:
 *
 *   1. under the item's lock: an entry mid-restore, or whose live row came back, is settled by `reinstateLocked`.
 *      `protect.recheck` then judges the entry again with today's pins, citations and accesses; a protected
 *      one is reinstated, not purged (design 4.6).
 *   2. a clear entry is marked `purging`, the commit point: from then on a restore defers it and a re-run finishes
 *      it whatever protection says. Nothing before this is irreversible.
 *   3. the page's facets go in one pass (`deleteFacetsForTargets` reads the whole facet scope).
 *   4. per committed entry, under its lock, stages O, S and X: `finalize` per satellite (image reference released
 *      once with `imageReleased` first, then its hold; access log, retention score), the observation tombstone (never
 *      deleted; the capture event marker from soft delete is left alone, so a replay stays a duplicate) or the demote
 *      record of a memory, and last `vault.take`, which also pops the locator. A stage T entry only drops its vaulted
 *      source; its live row stays.
 *   5. at the end of the run `held` is assigned the entries left (not decremented per page: a run whose `held` reached 0
 *      before it was marked would never be visited again). A run left empty is marked `purgedAt`, and one
 *      `retention_purge` audit entry per run and pass (R13) goes in before the row is saved.
 *
 * A crash anywhere repeats: an entry not yet `purging` is still fully restorable; one that is has only idempotent
 * steps left, each safe to repeat, and the tombstone is written only when absent. A crash after a `take` and before
 * the `held` write leaves `held` too high, never too low, so the run is visited again and the final write assigns it.
 *
 * `protect` is built by the caller once per pass, `createProtector(kv, settings.windows, clock)` with the current
 * settings' windows (not each run's snapshot), under the sweep lease: a spilling Protector clears `sweepScratch`.
 */
export async function purgeExpired(deps: RetentionDeps, protect: Protector, now: Date, opts: PurgeOptions = {}): Promise<PurgeResult> {
  const pass: Pass = {
    deps, protect, now, vault: new Vault(deps.kv), runs: new RunStore(deps.kv, deps.now),
    dryRun: opts.dryRun === true, pauseMs: opts.pauseMs ?? RETENTION_PAGE_PAUSE_MS, beat: opts.beat ?? (async () => {}),
  };
  let total = NOTHING;
  for (const run of await dueRuns(deps.kv, now)) total = sum(total, await purgeRun(pass, run));
  return total;
}

type Commit =
  | { readonly kind: "gone" }
  | { readonly kind: "commit"; readonly entry: VaultEntry }
  | { readonly kind: "settled"; readonly result: ReinstateResult };

async function purgeRun(pass: Pass, run: RunRow): Promise<PurgeResult> {
  const { deps, vault } = pass;
  let tally = NOTHING;
  let remaining = 0;
  for await (const page of vault.pages(run.id, RETENTION_PAGE_SIZE)) {
    await pass.beat();
    const committed: VaultEntry[] = [];
    for (const listed of page) {
      const step = await withKeyedLock(lockOf(listed.ref), () => commit(pass, run.id, listed.ref));
      if (step.kind === "gone") continue;
      if (step.kind === "commit") {
        committed.push(step.entry);
        continue;
      }
      const { restored, deferred } = step.result;
      tally = sum(tally, { ...NOTHING, restoredBack: restored ? 1 : 0, deferred: deferred ? 1 : 0, dropped: restored || deferred ? 0 : 1 });
      if (deferred) remaining++;
    }
    if (pass.dryRun) {
      tally = sum(tally, { ...NOTHING, purged: committed.length });
      continue;
    }
    const facetTargets = committed.filter((entry) => entry.stage !== "T").map((entry) => entry.ref.id);
    if (facetTargets.length > 0) await deleteFacetsForTargets(deps.kv, facetTargets, { targetTypes: ["memory", "observation"] });
    for (const entry of committed) {
      if (await withKeyedLock(lockOf(entry.ref), () => finish(pass, run.id, entry.ref))) tally = sum(tally, { ...NOTHING, purged: 1 });
    }
    if (pass.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pass.pauseMs));
  }
  return closeRun(pass, run, tally, remaining);
}

/** Under the item's lock: settles an entry that must not be purged, or marks it `purging`. */
async function commit(pass: Pass, runId: RunId, ref: ItemRef): Promise<Commit> {
  const { deps, vault } = pass;
  const entry = await vault.get(runId, ref);
  if (!entry) return { kind: "gone" };
  if (entry.purging || entry.imageReleased) return { kind: "commit", entry: { ...entry, purging: true } };
  const live = await deps.kv.get<Live>(scopeOf(ref), ref.id);
  const protectedBy = entry.stage === "T" && !live && !(await rowVaulted(vault, entry))
    ? CLEAR
    : entry.restoring || (entry.stage !== "T" && live) ? null : await pass.protect.recheck(entry);
  if (protectedBy?.kind === "clear") {
    await pass.beat();
    if (pass.dryRun) return { kind: "commit", entry };
    const marked: VaultEntry = { ...entry, purging: true };
    await vault.update(marked);
    return { kind: "commit", entry: marked };
  }
  if (!pass.dryRun) return { kind: "settled", result: await reinstateLocked(deps, vault, entry) };
  const decision = reinstatement(entry, live);
  return { kind: "settled", result: { restored: decision === "restore", reembedNeeded: false, ...(decision === "deferred" ? { deferred: true } : {}) } };
}

const CLEAR = { kind: "clear" } as const;

/**
 * A trim entry restores only onto a live row. With none, its source has a place to go only while another run's vault
 * still holds the row (a later stage O); the locator names that claim. Without one the row was purged or forgotten,
 * nothing can be restored into, and the entry is purged whatever protection says, or it would be held forever.
 */
async function rowVaulted(vault: Vault, entry: VaultEntry): Promise<boolean> {
  const locator = await vault.locate(entry.ref);
  const other = locator?.runId === entry.runId ? locator.under : locator;
  return !!other && other.stage !== "T" && (await vault.get(other.runId, entry.ref)) !== null;
}

/** True when this call took the entry; false when a forget or a restore took it first. */
async function finish(pass: Pass, runId: RunId, ref: ItemRef): Promise<boolean> {
  const { deps, vault } = pass;
  const entry = await vault.get(runId, ref);
  if (!entry) return false;
  if (entry.stage !== "T") {
    for (const satellite of SATELLITES) if (satellite.appliesTo.includes(ref.kind)) await satellite.finalize?.(deps, entry);
    if (ref.kind === "observation") await tombstone(pass, runId, ref.sessionId, itemKey(ref));
    else await deps.kv.delete(RETENTION_KV.demoted, ref.id);
  }
  await vault.take(runId, ref);
  return true;
}

/** Written once and never deleted: provenance for graph items. Not rewritten on a repeat, so a re-run changes nothing. */
async function tombstone(pass: Pass, runId: RunId, sessionId: string, key: string): Promise<void> {
  if ((await pass.deps.kv.get(RETENTION_KV.tombstones, key)) !== null) return;
  await pass.deps.kv.set<ObservationTombstone>(RETENTION_KV.tombstones, key, { sessionId, runId, deletedAt: pass.now.toISOString(), summarySessionId: sessionId });
}

/**
 * Audits the visit when it changed something or deferred an entry, and saves the run row when it changed something.
 * A visit that did neither writes nothing, so a repeated pass is silent. A dry run computes the same result and writes nothing.
 */
async function closeRun(pass: Pass, run: RunRow, tally: PurgeResult, remaining: number): Promise<PurgeResult> {
  const fresh = (await pass.runs.get(run.id)) ?? run;
  const changed = tally.purged + tally.restoredBack + tally.dropped > 0 || fresh.held !== remaining;
  const emptied = changed && remaining === 0;
  const result = { ...tally, runsEmptied: emptied ? 1 : 0 };
  if (pass.dryRun || (!changed && tally.deferred === 0)) return result;
  await safeAudit(pass.deps.kv, "retention_purge", "mem::retention-purge", [run.id], {
    runId: run.id,
    reason: `grace period of ${run.graceDays} day(s) elapsed`,
    graceDays: run.graceDays,
    closedAt: run.closedAt,
    heldBefore: run.held,
    purged: tally.purged,
    restoredBack: tally.restoredBack,
    dropped: tally.dropped,
    deferred: tally.deferred,
    remaining,
  });
  if (changed) await pass.runs.save({ ...fresh, held: remaining, ...(emptied ? { purgedAt: pass.now.toISOString() } : {}) });
  return result;
}

export interface PurgeRequest {
  readonly dryRun: boolean;
  /** Tests only. */
  readonly pauseMs?: number;
  /** Tests only: the Protector's spill threshold. */
  readonly spillIds?: number;
}

export type PurgeOutcome =
  | { readonly kind: "off"; readonly why: string }
  | { readonly kind: "busy"; readonly heldBy: string }
  /** The heartbeat found the lease taken by another process. Purge repeats safely, so the next pass settles the rest. */
  | { readonly kind: "lease-lost" }
  | ({ readonly kind: "done"; readonly dryRun: boolean } & PurgeResult);

class LeaseLost extends Error {}

/**
 * `mem::retention-purge`. Off settings return at once with no read or write. Runs due for purge are found first
 * (reads only), so a stack with none takes no lease. Otherwise the sweep's lease is held for the whole pass, because
 * a spilling Protector clears the scratch scope a sweep may be using; a busy lease returns `busy` and does nothing.
 * The lease is heartbeated before every page and before every commit, and the Protector is released in a finally
 * (not when the lease was lost: the new owner may be using the scratch).
 */
export async function runPurge(deps: RetentionDeps, settings: RetentionSettings, req: PurgeRequest): Promise<PurgeOutcome> {
  if (settings.mode === "off") return { kind: "off", why: settings.why };
  const now = deps.now();
  if ((await dueRuns(deps.kv, now)).length === 0) return { kind: "done", dryRun: req.dryRun, ...NOTHING };
  const runs = new RunStore(deps.kv, deps.now);
  const owner = `purge-${randomUUID()}`;
  const lease = await runs.acquireLease(owner);
  if (!lease.held) return { kind: "busy", heldBy: lease.heldBy };
  let protector: Protector | undefined;
  let lost = false;
  try {
    protector = await createProtector(deps.kv, settings.windows, await loadActiveClock(deps.kv, deps.now), req.spillIds === undefined ? {} : { spillIds: req.spillIds });
    const beat = async (): Promise<void> => {
      if (await runs.heartbeat(owner)) return;
      lost = true;
      throw new LeaseLost();
    };
    const result = await purgeExpired(deps, protector, now, { beat, dryRun: req.dryRun, ...(req.pauseMs === undefined ? {} : { pauseMs: req.pauseMs }) });
    return { kind: "done", dryRun: req.dryRun, ...result };
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: "lease-lost" };
    throw err;
  } finally {
    if (!lost) {
      await protector?.release().catch((err) => logger.warn("retention: purge scratch release failed", { error: String(err) }));
      await runs.releaseLease(owner).catch((err) => logger.warn("retention: purge lease release failed", { error: String(err) }));
    }
  }
}

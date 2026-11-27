import type { IIIClient } from "iii-sdk";
import { safeAudit } from "../../functions/audit.js";
import { logger } from "../../logger.js";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import type { StateKV } from "../../state/kv.js";
import { markGraphStale, type GraphStaleResult } from "./graph-stale.js";
import { lockOf } from "./move.js";
import { release } from "./restore.js";
import { RunStore } from "./run-store.js";
import { assignObservationCount } from "./satellites.js";
import { RETENTION_KV } from "./scopes.js";
import type { ItemRef, RunId, RunRow, VaultEntry } from "./types.js";
import { Vault } from "./vault.js";

type ObservationRef = Extract<ItemRef, { kind: "observation" }>;

const PRECHECK_BATCH = 64;
const SESSION_SCAN_PAGE = 64;
const AUDIT_IDS = 100;
const NO_GRAPH: GraphStaleResult = { nodes: 0, edges: 0, marked: 0, ids: [], deferred: true };

/**
 * What `mem::forget` knew when it finished deleting (seam: src/functions/remember.ts). `sessionId`, `memoryId`
 * and `observationIds` are the request, so a not-found id can be turned back into a ref: an observation id is
 * only meaningful with its session.
 */
export interface ForgetOutcome {
  readonly sessionId?: string;
  readonly memoryId?: string;
  readonly observationIds?: readonly string[];
  /** Rows forget deleted live. */
  readonly observations: readonly { readonly id: string; readonly sessionId: string }[];
  readonly memories: readonly string[];
  readonly notFound: readonly string[];
}

export interface ForgetCleanup {
  /** Ids forget did not find live but erased from retention's copies. Forget counts them as deleted and drops them from `notFound`. */
  readonly trashed: { readonly observationIds: readonly string[]; readonly memoryIds: readonly string[] };
  readonly graph: GraphStaleResult;
  readonly vaultCopiesErased: number;
  readonly demoteRecordsDeleted: number;
  readonly sessionsRecounted: number;
  /** One id per step that failed: a ref (its id), `retention:graph`, `retention:audit` or `retention:recount:<sessionId>`. The rest of the pass still ran. */
  readonly failures: readonly string[];
}

interface Erased {
  readonly vault: number;
  readonly demote: number;
}

/**
 * Explicit forget reaches everything at once (D7, R10, R11). `mem::forget` keeps its immediate hard delete and
 * calls this once, in every mode, so the call is visible at the one caller that needs it. Evict, import-replace and
 * governance-delete keep their own behaviour (their fixes are separate upstream-able commits). It needs no
 * retention setting: with retention off nothing is held, and every lookup answers none.
 *
 *   retention copies  a vault entry and its locator, both claims of a stacked ref (`ItemLocator.under`), and a
 *                     demote record: nothing can restore the item afterwards, and the run's `held` is lowered.
 *                     A ref forget did not find live is looked up too: an item a run displaced during grace is
 *                     erased from the vault, counted as deleted, and its image reference released.
 *   graph             every node and edge that cites one of the ids goes stale (graph-stale.ts), live row or vault copy alike.
 *   session count     `Session.observationCount` is assigned from the stored rows (L4, R11).
 *
 * Forgetting a memory leaves the graph alone: graph items cite observations, and the memory's source observations stay live.
 * Forgetting a whole session pages the vault of every run that holds entries and erases the session's displaced rows
 * like any other ref: the KV has no prefix scan, so the scan is one page of a run's vault at a time (`Vault.runsHolding`
 * is bounded, about 60 runs a year). They count in `trashed`, like a ref forget did not find live.
 * A crash between forget's delete and this call leaves a trim entry for a row that is gone; it is purged at the end of grace.
 *
 * Each ref, the graph step and each session recount are isolated: one that fails is logged and listed in `failures`,
 * and the rest of the pass still runs. Nothing retries a failed ref.
 */
export async function afterForget(sdk: IIIClient, kv: StateKV, forgot: ForgetOutcome): Promise<ForgetCleanup> {
  const failures: string[] = [];
  const fail = (id: string, err: unknown): void => {
    logger.warn("Forget retention step failed", { id, error: err instanceof Error ? err.message : String(err) });
    failures.push(id);
  };
  const guarded: Guarded = async (id, step) => {
    try {
      return await step();
    } catch (err) {
      fail(id, err);
      return undefined;
    }
  };

  const live: ItemRef[] = [
    ...forgot.observations.map((row): ObservationRef => ({ kind: "observation", sessionId: row.sessionId, id: row.id })),
    ...forgot.memories.map((id): ItemRef => ({ kind: "memory", id })),
  ];
  const erased: Erased[] = [];
  for (const ref of await holding(kv, live, guarded)) {
    const one = await guarded(ref.id, () => eraseCopies(sdk, kv, ref, false));
    if (one) erased.push(one);
  }

  const trashed: ItemRef[] = [];
  const noteTrashed = (ref: ItemRef, one: Erased | undefined): void => {
    if (!one) return;
    erased.push(one);
    if (one.vault + one.demote > 0) trashed.push(ref);
  };
  for (const ref of absentRefs(forgot)) noteTrashed(ref, await guarded(ref.id, () => eraseCopies(sdk, kv, ref, true)));
  if (isSessionForget(forgot)) {
    for await (const { ref, runId } of sessionEntries(kv, forgot.sessionId, fail)) {
      noteTrashed(ref, await guarded(ref.id, () => eraseCopies(sdk, kv, ref, true, runId)));
    }
  }

  const gone = [...live, ...trashed].filter((ref): ref is ObservationRef => ref.kind === "observation");
  const graph = (await guarded("retention:graph", () => markGraphStale(kv, gone.map((ref) => ref.id)))) ?? NO_GRAPH;
  let sessionsRecounted = 0;
  for (const sessionId of new Set(gone.map((ref) => ref.sessionId))) {
    if (await guarded(`retention:recount:${sessionId}`, () => assignObservationCount(kv, sessionId))) sessionsRecounted++;
  }
  if (graph.marked > 0 || graph.deferred) await guarded("retention:audit", () => auditGraph(kv, graph, gone.length));

  return {
    trashed: {
      observationIds: [...new Set(trashed.filter((ref) => ref.kind === "observation").map((ref) => ref.id))],
      memoryIds: trashed.filter((ref) => ref.kind === "memory").map((ref) => ref.id),
    },
    graph,
    vaultCopiesErased: erased.reduce((sum, one) => sum + one.vault, 0),
    demoteRecordsDeleted: erased.reduce((sum, one) => sum + one.demote, 0),
    sessionsRecounted,
    failures,
  };
}

type Guarded = <T>(id: string, step: () => Promise<T>) => Promise<T | undefined>;

/** The shape of `mem::forget`'s own whole-session branch (src/functions/remember.ts). */
function isSessionForget(forgot: ForgetOutcome): forgot is ForgetOutcome & { readonly sessionId: string } {
  return Boolean(forgot.sessionId) && !(forgot.observationIds?.length) && !forgot.memoryId;
}

/**
 * The session's observation entries in every vault that still holds some, one page at a time. A locator is keyed by
 * `itemKey`, which starts with the session id, but the KV has no prefix scan, so each run's vault is paged and filtered.
 * Both claims of a stacked ref are found, each in its own run. A run that fails to page is listed in `failures`.
 */
async function* sessionEntries(kv: StateKV, sessionId: string, fail: (id: string, err: unknown) => void): AsyncGenerator<{ ref: ObservationRef; runId: RunId }> {
  const vault = new Vault(kv);
  let runs: readonly RunRow[] = [];
  try {
    runs = await vault.runsHolding();
  } catch (err) {
    fail("retention:vault-scan", err);
  }
  for (const run of runs) {
    try {
      for await (const page of vault.pages(run.id, SESSION_SCAN_PAGE)) {
        for (const entry of page) {
          if (entry.ref.kind === "observation" && entry.ref.sessionId === sessionId) yield { ref: entry.ref, runId: run.id };
        }
      }
    } catch (err) {
      fail(`retention:vault-scan:${run.id}`, err);
    }
  }
}

function absentRefs(forgot: ForgetOutcome): ItemRef[] {
  const missing = new Set(forgot.notFound);
  const refs: ItemRef[] = [];
  if (forgot.memoryId && missing.has(forgot.memoryId)) refs.push({ kind: "memory", id: forgot.memoryId });
  if (forgot.sessionId) {
    for (const id of new Set(forgot.observationIds ?? [])) if (missing.has(id)) refs.push({ kind: "observation", sessionId: forgot.sessionId, id });
  }
  return refs;
}

/** An unlocked point read per ref, so a session of thousands of rows takes the item lock only for the few that retention holds. A ref whose read fails is skipped and listed in `failures`. */
async function holding(kv: StateKV, refs: readonly ItemRef[], guarded: Guarded): Promise<ItemRef[]> {
  const vault = new Vault(kv);
  const held: ItemRef[] = [];
  for (let start = 0; start < refs.length; start += PRECHECK_BATCH) {
    const batch = refs.slice(start, start + PRECHECK_BATCH);
    const claimed = await Promise.all(
      batch.map((ref) =>
        guarded(ref.id, async () => (await vault.locate(ref)) !== null || (ref.kind === "memory" && (await kv.get(RETENTION_KV.demoted, ref.id)) !== null)),
      ),
    );
    held.push(...batch.filter((_, index) => claimed[index]));
  }
  return held;
}

/**
 * Under the item's lock: take each claim newest first, lowering its run's `held`, then delete the demote record.
 * `releaseImages` is for a ref forget did not find live: its image reference was never released, because soft delete
 * keeps it until purge, and forget's own cleanup only reaches the live row.
 * `scannedIn` is the run a whole-session scan found the entry in: it is taken too when the locator no longer names it
 * (a locator lost between the two writes of `Vault.put`).
 */
async function eraseCopies(sdk: IIIClient, kv: StateKV, ref: ItemRef, releaseImages: boolean, scannedIn?: RunId): Promise<Erased> {
  const vault = new Vault(kv);
  const runs = new RunStore(kv, () => new Date());
  return withKeyedLock(lockOf(ref), async () => {
    let erased = 0;
    const takeClaim = async (runId: RunId): Promise<void> => {
      const entry = await vault.get(runId, ref);
      if (entry && releaseImages) await releaseImageRefs(sdk, kv, vault, entry);
      await vault.take(runId, ref);
      if (entry) {
        erased++;
        await release(runs, runId, 1);
      }
    };
    const visited = new Set<RunId>();
    for (let claim = await vault.locate(ref); claim && !visited.has(claim.runId); claim = await vault.locate(ref)) {
      visited.add(claim.runId);
      await takeClaim(claim.runId);
    }
    if (scannedIn !== undefined && !visited.has(scannedIn)) await takeClaim(scannedIn);
    let demote = 0;
    if (ref.kind === "memory" && (await kv.get(RETENTION_KV.demoted, ref.id)) !== null) {
      await kv.delete(RETENTION_KV.demoted, ref.id);
      demote = 1;
    }
    return { vault: erased, demote };
  });
}

/** `imageReleased` is written first, so a crash leaks one reference and never frees a file another row still uses (as at purge). */
async function releaseImageRefs(sdk: IIIClient, kv: StateKV, vault: Vault, entry: VaultEntry): Promise<void> {
  if (entry.stage === "T" || entry.imageReleased) return;
  const row = entry.row as { imageData?: string; imageRef?: string };
  const files = entry.ref.kind === "memory" ? [row.imageRef] : [row.imageData, row.imageRef];
  const paths = [...new Set(files.filter((file): file is string => typeof file === "string" && file.length > 0))];
  if (paths.length === 0) return;
  await vault.update({ ...entry, imageReleased: true });
  const { decrementImageRef } = await import("../../functions/image-refs.js");
  for (const path of paths) await decrementImageRef(kv, sdk, path);
}

async function auditGraph(kv: StateKV, graph: GraphStaleResult, observations: number): Promise<void> {
  await safeAudit(kv, "forget", "mem::forget", graph.ids.slice(0, AUDIT_IDS), {
    resourceType: "Graph",
    change: "graph items marked stale by forget",
    nodes: graph.nodes,
    edges: graph.edges,
    observations,
    idsTruncated: graph.ids.length > AUDIT_IDS,
    deferred: graph.deferred,
    reason: "user-initiated forget",
  });
}

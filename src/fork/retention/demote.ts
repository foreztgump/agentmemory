import { withKeyedLock } from "../../state/keyed-mutex.js";
import type { StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import type { Memory } from "../../types.js";
import { docOfRecord } from "../search/doc-of-record.js";
import { hiddenFromIndex } from "./indexable.js";
import type { DisplaceResult, ReinstateResult } from "./move.js";
import { addDocument, removeDocument, type RetentionDeps } from "./satellites.js";
import { RETENTION_KV } from "./scopes.js";
import { RETENTION_PAGE_SIZE } from "./settings.js";
import type { DemoteRecord, Reason, RunId, SatelliteSnapshots } from "./types.js";

/** The lock `mem::remember` and `mem::forget` write memories under; every demote and un-demote holds it. */
export const MEMORY_LOCK = "mem:remember";

export interface DemoteMove {
  readonly runId: RunId;
  readonly reason: Reason;
  readonly movedAt: string;
  readonly satellites: SatelliteSnapshots;
}

const NOT_RESTORED: ReinstateResult = { restored: false, reembedNeeded: false };

function withoutMark(row: Memory): Memory {
  const copy = { ...row };
  delete copy.retention;
  return copy;
}

/**
 * Stage C, for a caller that holds `MEMORY_LOCK` and has re-read `live`. The record (with the stored vector) lands
 * first, then the mark, then the index removals, so every crash leaves a state `recoverDemotes` settles: a record with
 * no mark is a demote that never landed and is dropped, a mark with a record finishes its index removals.
 * The row stays in `mem:memories` unchanged apart from the mark, so export, the viewer and supersede lookups see it.
 */
export async function demoteLocked(deps: RetentionDeps, move: DemoteMove, live: Memory): Promise<DisplaceResult> {
  const { vector } = move.satellites;
  const record: DemoteRecord = {
    memoryId: live.id, runId: move.runId, demotedAt: move.movedAt, reason: move.reason, ...(vector === undefined ? {} : { vector }),
  };
  await deps.kv.set(RETENTION_KV.demoted, live.id, record);
  await deps.kv.set<Memory>(KV.memories, live.id, { ...live, retention: { demotedAt: record.demotedAt, runId: record.runId, memoryId: live.id } });
  removeDocument(deps, live.id);
  return { moved: true, bytes: Buffer.byteLength(JSON.stringify(record)) };
}

/**
 * Un-demote, for a caller that holds `MEMORY_LOCK`: `restoring` on the record, the mark cleared, the document and its
 * stored vector back in the indexes (never an embedding call, R3), the record deleted. `null` when nothing is held
 * for the id. A record whose row is not marked and is not being restored is a demote that never landed, or a mark a
 * writer dropped: the record goes and the live row is indexed again, so a live row is always in the indexes.
 * A marked row with no record (an export imported from another stack) is restored with no vector, and the re-embed loop fills it.
 */
export async function reinstateDemoteLocked(deps: RetentionDeps, memoryId: string): Promise<ReinstateResult | null> {
  const [record, live] = await Promise.all([
    deps.kv.get<DemoteRecord>(RETENTION_KV.demoted, memoryId),
    deps.kv.get<Memory>(KV.memories, memoryId),
  ]);
  const marked = hiddenFromIndex(live);
  if (!record && !marked) return null;
  if (!live) {
    await deps.kv.delete(RETENTION_KV.demoted, memoryId);
    return NOT_RESTORED;
  }
  const held = record ?? importedRecord(live);
  const finishing = marked || held.restoring === true;
  if (finishing && !held.restoring) await deps.kv.set(RETENTION_KV.demoted, memoryId, { ...held, restoring: true });
  const unmarked = marked ? withoutMark(live) : live;
  if (marked) await deps.kv.set<Memory>(KV.memories, memoryId, unmarked);
  const doc = docOfRecord("memory", unmarked);
  const { reembedNeeded } = doc ? addDocument(deps, doc, held.vector) : NOT_RESTORED;
  await deps.kv.delete(RETENTION_KV.demoted, memoryId);
  return { restored: finishing, reembedNeeded };
}

const importedRecord = (live: Memory): DemoteRecord => ({
  memoryId: live.id,
  runId: live.retention!.runId as RunId,
  demotedAt: live.retention!.demotedAt,
  reason: { stage: "C", ageActiveDays: 0, note: "mark without a record" },
});

export function reinstateDemote(deps: RetentionDeps, memoryId: string): Promise<ReinstateResult | null> {
  return withKeyedLock(MEMORY_LOCK, () => reinstateDemoteLocked(deps, memoryId));
}

/** The records one run wrote, paged: the scope is keyed by memory id, so a run's demotes are found by scanning it. */
export async function* demotedBy(kv: StateKV, runId: RunId): AsyncGenerator<DemoteRecord> {
  for await (const page of kv.iterate<DemoteRecord>(RETENTION_KV.demoted, { pageSize: RETENTION_PAGE_SIZE })) {
    for (const record of page) if (record?.runId === runId) yield record;
  }
}

/**
 * `recoverRun` for stage C. Per record under `MEMORY_LOCK`, from the record as stored once the lock is held:
 *  restoring: finish the un-demote, never undo it.
 *  marked: run the index removals again (a crash can fall between the mark and them).
 *  not marked: the demote never landed, or a writer dropped the mark: drop the record and index the live row.
 * `finished` counts finished un-demotes, `detachedAgain` marked rows whose removals ran again.
 */
export async function recoverDemotes(deps: RetentionDeps, runId: RunId): Promise<{ finished: number; detachedAgain: number }> {
  let finished = 0;
  let detachedAgain = 0;
  for await (const listed of demotedBy(deps.kv, runId)) {
    const settled = await withKeyedLock(MEMORY_LOCK, async () => {
      const held = await deps.kv.get<DemoteRecord>(RETENTION_KV.demoted, listed.memoryId);
      if (!held) return "left";
      if (!held.restoring && hiddenFromIndex(await deps.kv.get<Memory>(KV.memories, held.memoryId))) {
        removeDocument(deps, held.memoryId);
        return "detached";
      }
      await reinstateDemoteLocked(deps, held.memoryId);
      return held.restoring ? "finished" : "left";
    });
    if (settled === "finished") finished++;
    else if (settled === "detached") detachedAgain++;
  }
  return { finished, detachedAgain };
}

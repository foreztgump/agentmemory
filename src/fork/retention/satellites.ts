import type { IIIClient } from "iii-sdk";
import { captureEventScope, isCaptureKey, markCaptureEventDeleted } from "../../capture/event-record.js";
import { indexObservationSession, lookupObservationSession, unindexObservationSession } from "../../state/obs-index.js";
import type { StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import type { SearchRuntime } from "../../state/search-ports.js";
import type { Session } from "../../types.js";
import { sessionObservationTotals } from "../kv/observation-stats.js";
import { docOfRecord } from "../search/doc-of-record.js";
import type { ItemRef, SatelliteSnapshots, VaultEntry } from "./types.js";
import { reattachDocument, type VectorReader } from "./vectors.js";

/** What every satellite and every move needs. Built once in register.ts. */
export interface RetentionDeps {
  readonly sdk: IIIClient;
  /** The stats-wrapped KV from index.ts, so ObservationStats follows every row move (reconcile reads it). */
  readonly kv: StateKV;
  readonly search: () => SearchRuntime;
  readonly vectors: VectorReader;
  readonly now: () => Date;
}

/**
 * Everything that hangs off a row and must leave and return with it. One table drives soft delete,
 * restore and purge, so the three cannot drift apart (graft from the sonnet candidate). Every verb is
 * idempotent: a crash is repaired by running the same verb again.
 */
export interface Satellite {
  readonly name: "search-index" | "capture-event" | "obs-session-index" | "image" | "session-count" | "metadata";
  readonly appliesTo: readonly ItemRef["kind"][];
  /** Read before the row moves; the result is stored in the entry's `satellites`. */
  snapshot?(deps: RetentionDeps, ref: ItemRef, row: unknown): Promise<Partial<SatelliteSnapshots>>;
  /** After the row has left its live scope. Omitted by satellites with purge-only work (metadata). */
  detach?(deps: RetentionDeps, entry: VaultEntry): Promise<void>;
  /** After the row is back in its live scope. `reembedNeeded` says the item went back with no stored vector. */
  attach?(deps: RetentionDeps, entry: VaultEntry): Promise<{ readonly reembedNeeded?: boolean } | void>;
  /** Purge only: clean data keyed by the id that has no restore path. */
  finalize?(deps: RetentionDeps, entry: VaultEntry): Promise<void>;
}

/**
 * Order: snapshot all, vault put, row out, detach in table order. Restore: row in, attach in table order,
 * vault take. Stage T never walks the table: the row stays live and indexed.
 *
 *  search-index     snapshot: vectors.read([id]), which rejects when the backend cannot answer, so displace
 *                   refuses the row. detach: keyword.remove, invalidateRevision, vector.remove. attach:
 *                   reattachDocument (keyword, then the stored vector, one tick). An observation id can repeat
 *                   across imported sessions and the index holds one doc per id, so a doc another session
 *                   owns is neither snapshotted, removed nor overwritten.
 *  capture-event    snapshot: the event row. detach: markCaptureEventDeleted. attach: the snapshot back, or,
 *                   when the event had no row, the marker detach wrote is removed.
 *  obs-session-index detach: unindex, when it still names this session. attach: index, when nothing else holds the id.
 *  session-count    detach and attach: Session.observationCount := ObservationStats rows for the session.
 *                   Assignment converges where +1/-1 does not, and repairs drift (L4, R11).
 *
 * Slice 7 adds the rows that only purge and images need: image (snapshot, detach, attach, finalize) and
 * metadata (finalize).
 */
export const SATELLITES: readonly Satellite[] = [searchIndex(), captureEvent(), obsSessionIndex(), sessionCount()];

type ObsEntry = Extract<VaultEntry, { ref: { kind: "observation" } }>;

/** A remote keyword index answers `sessionOf` only after `prefetch`, so every check prefetches first when the port has it. */
async function indexOwnedElsewhere(deps: RetentionDeps, ref: ItemRef): Promise<boolean> {
  if (ref.kind === "memory") return false;
  const { keyword } = deps.search();
  await keyword.prefetch?.([ref.id]);
  const owner = keyword.sessionOf(ref.id);
  return owner !== undefined && owner !== ref.sessionId;
}

function searchIndex(): Satellite {
  return {
    name: "search-index",
    appliesTo: ["observation", "memory"],
    async snapshot(deps, ref) {
      if (await indexOwnedElsewhere(deps, ref)) return {};
      const vector = (await deps.vectors.read([ref.id])).get(ref.id);
      return vector === undefined ? {} : { vector };
    },
    async detach(deps, entry) {
      if (await indexOwnedElsewhere(deps, entry.ref)) return;
      const runtime = deps.search();
      runtime.keyword.remove(entry.ref.id);
      runtime.keyword.invalidateRevision(entry.ref.id);
      runtime.vector?.remove(entry.ref.id);
      runtime.openPersistence().scheduleSave();
    },
    async attach(deps, entry) {
      if (entry.stage === "T") return;
      const doc = docOfRecord(entry.ref.kind, entry.row);
      if (!doc || (await indexOwnedElsewhere(deps, entry.ref))) return;
      const runtime = deps.search();
      runtime.openPersistence().scheduleSave();
      return reattachDocument(runtime.keyword, runtime.vector, doc.obs, doc.layer, entry.satellites.vector);
    },
  };
}

const captureKeyOf = (row: unknown): string | null => {
  const key = (row as { captureKey?: unknown } | null)?.captureKey;
  return isCaptureKey(key) ? key : null;
};

function captureEvent(): Satellite {
  return {
    name: "capture-event",
    appliesTo: ["observation"],
    async snapshot(deps, _ref, row) {
      const key = captureKeyOf(row);
      const event = key === null ? null : await deps.kv.get(captureEventScope(key), key);
      return event === null ? {} : { captureEvent: event };
    },
    async detach(deps, entry) {
      if (entry.stage !== "T") await markCaptureEventDeleted(deps.kv, entry.row);
    },
    async attach(deps, entry) {
      const key = entry.stage === "T" ? null : captureKeyOf(entry.row);
      if (key === null) return;
      const scope = captureEventScope(key);
      if (entry.satellites.captureEvent !== undefined) await deps.kv.set(scope, key, entry.satellites.captureEvent);
      else await deps.kv.delete(scope, key);
    },
  };
}

function obsSessionIndex(): Satellite {
  return {
    name: "obs-session-index",
    appliesTo: ["observation"],
    async detach(deps, entry) {
      const { ref } = entry as ObsEntry;
      if ((await lookupObservationSession(deps.kv, ref.id)) === ref.sessionId) await unindexObservationSession(deps.kv, ref.id);
    },
    async attach(deps, entry) {
      const { ref } = entry as ObsEntry;
      if ((await lookupObservationSession(deps.kv, ref.id)) === null) await indexObservationSession(deps.kv, ref.id, ref.sessionId);
    },
  };
}

async function assignSessionCount(deps: RetentionDeps, entry: VaultEntry): Promise<void> {
  if (entry.ref.kind !== "observation") return;
  const { sessionId } = entry.ref;
  const rows = (await sessionObservationTotals(deps.kv, sessionId)).rows;
  const session = await deps.kv.get<Session>(KV.sessions, sessionId);
  if (session && session.observationCount !== rows) {
    await deps.kv.update(KV.sessions, sessionId, [{ type: "set", path: "observationCount", value: rows }]);
  }
}

function sessionCount(): Satellite {
  return { name: "session-count", appliesTo: ["observation"], detach: assignSessionCount, attach: assignSessionCount };
}

import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../../state/kv.js";
import type { SearchRuntime } from "../../state/search-ports.js";
import type { ItemRef, SatelliteSnapshots, VaultEntry } from "./types.js";
import type { VectorReader } from "./vectors.js";

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
  /** After the row is back in its live scope. */
  attach?(deps: RetentionDeps, entry: VaultEntry): Promise<void>;
  /** Purge only: clean data keyed by the id that has no restore path. */
  finalize?(deps: RetentionDeps, entry: VaultEntry): Promise<void>;
}

/**
 * Order: snapshot all, vault put, row out, detach in table order. Restore: row in, attach in table order,
 * vault take.
 *
 *  search-index     snapshot: vectors.read([id]). detach: keyword.remove(id), vector?.remove(id).
 *                   attach: reattachDocument (keyword then stored vector, one tick; memories through
 *                   memoryToObservation). Disk mode: the ops ride the docs outbox; the TEE-1169 reconciler
 *                   would also delete the leaked doc, since the record is gone.
 *  capture-event    snapshot: the event row. detach: markCaptureEventDeleted. attach: put the snapshot back.
 *                   Replay of a restored event dedups on the existing row (R8 test covers both).
 *  obs-session-index detach: unindexObservationSession. attach: re-index.
 *  image            snapshot + detach: only when no other live row references the file
 *                   (live refs = mem:image-refs count minus the trashed references held in the vault):
 *                   move the mem:image-embeddings row into the snapshot and call images?.remove(ref).
 *                   That row is TEE-1196's truth, so its reconciler removes the entry rather than repairs it,
 *                   and vision search in memory mode (which reads those rows) stops finding it.
 *                   attach: put the row back, images?.put(row) (the vector is in the row). finalize:
 *                   decrementImageRef once, guarded by entry.imageReleased (R4: file removed only at 0 refs).
 *  session-count    detach and attach: Session.observationCount := ObservationStats rows for the session.
 *                   Assignment converges where +1/-1 does not, and repairs drift (L4, R11).
 *  metadata         finalize: delete mem:access, mem:retention score, facets, mem:emb, mem:latent for the id.
 */
// TODO(slice 4): fill the table. displace, reinstate and purge walk it, so an empty table would make
//  every detach and attach a silent no-op; slice 4's tests assert each row of the comment above.
export const SATELLITES: readonly Satellite[] = [];

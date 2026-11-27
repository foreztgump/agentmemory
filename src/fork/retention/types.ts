// Retention domain types. Design: docs/fork/retention-design.md; rationale: docs/fork/retention-architecture.md.
import type { CompressedObservation, Memory, ObservationSource } from "../../types.js";

export declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, "RetentionRunId">;

/**
 * Observation ids are not unique across sessions. Native captures mint globally unique ids, but imported
 * sessions bring client-supplied ones: the jsonl replay derives them from the transcript's own `uuid`
 * (a resumed or forked transcript repeats earlier uuids under a new session id), and export import
 * accepts any string id. So a ref carries its session, and every retention key for an observation is
 * `itemKey(ref)` (scopes.ts), never the bare id. Memory ids are unique: one scope, one id.
 */
export type ItemRef =
  | { readonly kind: "observation"; readonly sessionId: string; readonly id: string }
  | { readonly kind: "memory"; readonly id: string };

/** T trim raw source, O observation, S superseded memory, X expired memory, C cold memory. */
export type Stage = "T" | "O" | "S" | "X" | "C";

/**
 * How each stage changes what readers see. One table, so no code branches on stage letters.
 * - trim: `source` goes to the vault, the row stays live and indexed.
 * - trash: the row leaves its live scope and is purged after the grace period.
 * - demote: the row stays in `mem:memories` with `retention.demotedAt` set and leaves both indexes;
 *   never purged (D6). Export, viewer and supersede lookups still see it.
 */
export type Disposition = "trim" | "trash" | "demote";
export const STAGE_DISPOSITION: Readonly<Record<Stage, Disposition>> = {
  T: "trim",
  O: "trash",
  S: "trash",
  X: "trash",
  C: "demote",
};

/** Section 6 of the design. Report counts and verdicts key on these. */
export type SignalId =
  | "pin"
  | "importance"
  | "deliberate-save"
  | "cited-by-memory"
  | "cited-by-insight"
  | "cited-by-graph"
  | "retrieved"
  | "lesson"
  | "memory-type";

/** Ages in project-active days (clock.ts). */
export interface Windows {
  readonly trimDays: number;
  readonly observationDays: number;
  readonly supersededDays: number;
  readonly coldDays: number;
}

export interface Reason {
  readonly stage: Stage;
  readonly ageActiveDays: number;
  readonly note: string;
}

/** Written by the sweep once a summary provably covers every row of an ended session (design 3.1). */
export interface SessionSeal {
  readonly sessionId: string;
  readonly sealedAt: string;
  readonly summaryFingerprint: string;
  readonly observationCount: number;
  readonly graphExtracted: boolean;
  /**
   * Set before the first stage-O move in the session. The summarize veto reads it (R7, D10).
   * Never cleared by restore: once set, the stored summary is the digest of record.
   */
  trimmed: boolean;
}

/** Everything that must come back with a row. Captured before the row moves. */
export interface SatelliteSnapshots {
  /** Stored embedding, base64 float32 (the worker's `f32b64`). Restore writes it back, never embeds (R3). */
  readonly vector?: string;
  /** The capture event as it was before `markCaptureEventDeleted`. */
  readonly captureEvent?: unknown;
}

interface EntryBase {
  readonly ref: ItemRef;
  readonly runId: RunId;
  readonly reason: Reason;
  readonly movedAt: string;
  /** Project of the item, read at move time, so the purge-time protection re-check needs no extra lookup. */
  readonly project: string;
  /**
   * `fingerprintRow` of the live row at move time; reinstate and recovery compare it so a row rewritten
   * since stays live. It hashes only fields that survive a trim: for observations the summary
   * fingerprint's field set (id, type, title, narrative, facts, files, concepts; design 4.4), which excludes
   * `source`, so the value is equal before and after a stage T rewrite and a trim entry can be compared
   * against its trimmed live row. Memory entries (S, X; never trimmed) hash the full row.
   */
  readonly rowFingerprint: string;
  readonly satellites: SatelliteSnapshots;
  /** Set before the image ref is released at purge or forget: a crash leaks one reference, never frees a shared file. */
  imageReleased?: boolean;
  /**
   * Written by purge, under the item's lock, before its first irreversible step. From then on the entry is not
   * restorable (`reinstateLocked` defers it) and purge finishes it whatever protection says, so a restore never
   * brings back a row whose image reference, access log or demote record is already gone. An entry with
   * `imageReleased` set counts the same: a forget that crashed after releasing the reference leaves one, and purge
   * finishes it at the end of grace.
   */
  purging?: boolean;
  /**
   * Written, under the item's lock, before the first change of a restore. After a crash the row can be live
   * with the entry still held either way round (displace before its delete, or reinstate before its take), and
   * only this flag says which one was under way, so recoverRun finishes a restore instead of undoing it.
   */
  restoring?: boolean;
}

export interface ObservationRowEntry extends EntryBase {
  readonly stage: "O";
  readonly ref: Extract<ItemRef, { kind: "observation" }>;
  readonly row: CompressedObservation;
}
export interface MemoryRowEntry extends EntryBase {
  readonly stage: "S" | "X";
  readonly ref: Extract<ItemRef, { kind: "memory" }>;
  readonly row: Memory;
}
export type RowEntry = ObservationRowEntry | MemoryRowEntry;
export interface TrimEntry extends EntryBase {
  readonly stage: "T";
  readonly ref: Extract<ItemRef, { kind: "observation" }>;
  readonly source: ObservationSource;
}
/** Value of one key in `mem:retention:vault:<runId>`; the key is `itemKey(entry.ref)`. */
export type VaultEntry = RowEntry | TrimEntry;

/**
 * `mem:retention:demoted`, key = memory id. Demote is not purged (D6), so it lives outside the per-run
 * vault and a run's vault can still empty and be deleted, and no purge, locator or `RunRow.held` reaches it.
 * Holds the vector (base64 float32, as `SatelliteSnapshots.vector`) so un-demote never embeds. Written before the
 * row's mark and deleted after the mark is cleared, so a record without a mark is a demote that never landed.
 */
export interface DemoteRecord {
  readonly memoryId: string;
  readonly runId: RunId;
  readonly demotedAt: string;
  readonly reason: Reason;
  readonly vector?: string;
  /** Written, under the memory lock, before the first change of an un-demote, so recovery finishes it instead of undoing it. */
  readonly restoring?: boolean;
}

/**
 * `mem:retention:items`, key = `itemKey(ref)`: which run holds it. Makes restore and erase by ref one point read.
 * Vault stages only: a demote is found by a point read of `mem:retention:demoted`, keyed by memory id.
 */
export interface ItemLocator {
  readonly runId: RunId;
  readonly stage: Exclude<Stage, "C">;
  /**
   * The claim this one replaced: a trim entry and a later stage O entry for one observation share a key, and
   * the locator names the newest while this keeps the older reachable by ref. `Vault.take` pops it back.
   * ponytail: one level, which is all T then O can stack; a third claim on one key drops the oldest.
   */
  readonly under?: { readonly runId: RunId; readonly stage: Exclude<Stage, "C"> };
}

/**
 * `mem:retention:tombstones`, key = `itemKey` of the observation ref. Written at purge, never deleted:
 * provenance for graph items. A citation carries a bare observation id, so a reader resolves it through
 * the session ids of the citing record (a memory's `sessionIds`); a graph item that cites an id two sessions
 * share is ambiguous upstream already, and a tombstone lookup there may match more than one session.
 */
export interface ObservationTombstone {
  readonly sessionId: string;
  readonly runId: RunId;
  readonly deletedAt: string;
  readonly summarySessionId: string;
}

/** Settle runs before check-after: the docs outbox must be drained so disk-mode removals have landed before the recall check reads the index. */
export type Phase = "seal" | "plan" | "check-before" | "apply" | "settle" | "check-after" | "done";
export type Outcome = "running" | "kept" | "restored" | "dry-run" | "refused";
/** What a finished run reports. A run only reaches "done" with one of these. */
export type FinalOutcome = Exclude<Outcome, "running">;

/**
 * Where the streamed plan resumes. The plan is never stored; it is recomputed from the cursor.
 * A sessions unit is one sealed session, paged: each batch holds one page of that session's rows with
 * their T and O candidates together, so a crash cannot split a row between the two stages. Imported
 * sessions bypass MAX_OBS_PER_SESSION, so a session of any size is walked in pages and `within` records
 * where. A memories unit is one page of memories with its S, X and C candidates.
 */
export interface Cursor {
  readonly unit: "sessions" | "memories";
  /** Last session id or memory id fully handled. */
  readonly after: string | null;
  /**
   * Sessions unit only: progress inside the session `sessionId`, which follows `after`, absent when no session
   * is in progress. A resume applies only to that session; if its seal is gone the next session starts from its
   * first row. Rows are walked in sorted key order, uncited rows first, then graph-cited rows (they go last).
   */
  readonly within?: {
    readonly sessionId: string;
    readonly pass: "uncited" | "graph-cited";
    /** Last row key (observation id) handled in this pass; null before the first page. */
    readonly afterRowId: string | null;
  };
}

export interface StageCounters {
  planned: number;
  moved: number;
  bytes: number;
  protectedHits: number;
}

/** `mem:retention:runs`, key = run id. Bounded: about 60 rows a year, kept with the audit (D8). */
export interface RunRow {
  readonly id: RunId;
  readonly dryRun: boolean;
  readonly startedAt: string;
  /** Snapshot of the settings the run started under; a resumed run finishes under them. */
  readonly windows: Windows;
  readonly graceDays: number;
  phase: Phase;
  outcome: Outcome;
  cursor: Cursor | null;
  counters: Record<Stage, StageCounters>;
  /** Stage O cap for this run (10% of observations on a stack's first enforcing run); null when uncapped. */
  observationCap: number | null;
  /** Entries in this run's vault that are still restorable. Purge visits only runs where this is above zero. */
  held: number;
  /** Process that ran the run last; the live lease and its heartbeat are in mem:retention:control only. */
  ranBy: string;
  restoredBecause?: string;
  closedAt?: string;
  /** Set by purge once the run's vault is empty; a purged run is never visited again. */
  purgedAt?: string;
}

// Retention domain types. Design: docs/fork/retention-design.md; rationale: docs/fork/retention-architecture.md.
import type { CompressedObservation, Memory, ObservationSource } from "../../types.js";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, "RetentionRunId">;

/** Observation ids are unique only with their session scope, so a ref carries it. */
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
  | "memory-type"
  | "undigested";

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
  /** The `mem:image-embeddings` row, moved only when this item held the last live reference (images.ts). */
  readonly imageEmbedding?: unknown;
}

interface EntryBase {
  readonly ref: ItemRef;
  readonly runId: RunId;
  readonly reason: Reason;
  readonly movedAt: string;
  /** Hash of the live row at move time; recovery compares it so a row rewritten since stays live. */
  readonly rowFingerprint: string;
  readonly satellites: SatelliteSnapshots;
  /** Set before the image ref is released at purge: a crash leaks one reference, never frees a shared file. */
  imageReleased?: boolean;
}

export interface RowEntry extends EntryBase {
  readonly stage: "O" | "S" | "X";
  readonly row: CompressedObservation | Memory;
}
export interface TrimEntry extends EntryBase {
  readonly stage: "T";
  readonly ref: Extract<ItemRef, { kind: "observation" }>;
  readonly source: ObservationSource;
}
/** Value of one key in `mem:retention:vault:<runId>`; the key is the item id. */
export type VaultEntry = RowEntry | TrimEntry;

/**
 * `mem:retention:demoted`, key = memory id. Demote is not purged (D6), so it lives outside the per-run
 * vault and a run's vault can still empty and be deleted. Holds the vector so un-demote never embeds.
 */
export interface DemoteRecord {
  readonly memoryId: string;
  readonly runId: RunId;
  readonly demotedAt: string;
  readonly reason: Reason;
  readonly vector?: string;
}

/** `mem:retention:items`, key = item id: which run holds it. Makes restore and erase by id one point read. */
export interface ItemLocator {
  readonly runId: RunId;
  readonly stage: Stage;
  readonly sessionId?: string;
}

/** `mem:retention:tombstones`, key = observation id. Written at purge, never deleted: provenance for graph items. */
export interface ObservationTombstone {
  readonly sessionId: string;
  readonly runId: RunId;
  readonly deletedAt: string;
  readonly summarySessionId: string;
}

export type Phase = "seal" | "plan" | "check-before" | "apply" | "check-after" | "settle" | "done";
export type Outcome = "running" | "kept" | "restored" | "dry-run" | "refused";

/** Where the streamed plan resumes. The plan is never stored; it is recomputed from the cursor. */
export interface Cursor {
  readonly stage: Stage;
  /** Last session id (T, O) or memory id (S, X, C) fully handled. */
  readonly after: string | null;
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
  lease: { readonly owner: string; heartbeatAt: string };
  restoredBecause?: string;
  closedAt?: string;
}

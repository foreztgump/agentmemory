import type { StateKV } from "../../state/kv.js";
import type { CompressedObservation, Memory } from "../../types.js";
import type { ActiveClock } from "./clock.js";
import type { ItemRef, Reason, SessionSeal, SignalId, VaultEntry, Windows } from "./types.js";

declare const cleared: unique symbol;

/** Proof that a session's summary covers every row (seal.ts). Only `judgeSeal` returns one. */
export interface SealProof {
  readonly seal: SessionSeal;
}

/** Proof that a superseded memory's successor exists, is latest and the chain has no cycle. */
export interface ChainProof {
  readonly successorId: string;
}

/** `project` is the item's project (a memory's own, a session's for an observation): the `retrieved` signal reads the project-active clock with it. */
export type Candidate = { readonly project: string } & (
  | { readonly stage: "T" | "O"; readonly ref: Extract<ItemRef, { kind: "observation" }>; readonly row: CompressedObservation; readonly proof: SealProof; readonly reason: Reason }
  | { readonly stage: "S"; readonly ref: Extract<ItemRef, { kind: "memory" }>; readonly row: Memory; readonly proof: ChainProof; readonly reason: Reason }
  | { readonly stage: "X" | "C"; readonly ref: Extract<ItemRef, { kind: "memory" }>; readonly row: Memory; readonly reason: Reason }
);

/** A candidate that passed every protection signal. `displace` accepts nothing else. */
export type Cleared = Candidate & { readonly [cleared]: true };

export type Verdict =
  | { readonly kind: "clear"; readonly item: Cleared }
  | { readonly kind: "protected"; readonly signal: SignalId; readonly candidate: Candidate };

/**
 * Section 6 signals, each a point read or a per-sweep pass over a small collection, never a whole read of
 * a growing one:
 *   pin              mem:retention:pins point read.
 *   importance       row.importance >= RETENTION_IMPORTANCE_FLOOR (settings.ts; only LLM compression writes
 *                    other than 5; off on both stacks today).
 *   deliberate-save  a latest memory is never trashed on age alone (stages X and C only touch it).
 *   cited-by-memory  ids from `sourceObservationIds` of latest memories and of superseded ones still inside
 *                    their window (`windows.supersededDays`: active-day age under it, read from the clock
 *                    with the memory's project and the time it stopped being latest), collected once per
 *                    sweep in one paged pass over mem:memories into a Set. Memories are about 1% of
 *                    observations (760 on buddy). The ids are bare, so an id two sessions share protects
 *                    both rows: the set errs toward keeping.
 *                    ponytail: in-RAM Set, spilled to RETENTION_KV.sweepScratch (scopes.ts, classified in
 *                    scope-classes.ts) above RETENTION_SPILL_IDS ids (design 6).
 *   cited-by-insight Insight.sourceMemoryIds, one paged pass over mem:insights.
 *   cited-by-graph   observation and edgeObservation postings, point reads; not a veto: lowers priority
 *                    so cited rows go last, and counts in the report.
 *   retrieved        mem:access point read: a last access at or after
 *                    `clock.cutoffForActiveDays(project, windows.coldDays)` protects, so the window is
 *                    project-active days, not wall-clock; no access is not evidence.
 *   lesson           lessons are never candidates (R5); the signal exists so the report can say so.
 *   memory-type      architecture and preference memories are never demoted (stage C).
 * Re-run at purge time (design 4.6) through `recheck`: an entry that became protected during grace is
 * restored instead.
 */
export interface Protector {
  judge(candidate: Candidate): Promise<Verdict>;
  /**
   * The same signals for a vault entry, which carries no seal or chain proof and mints no `Cleared`. Purge
   * calls it with a Protector built for that pass, so it sees the current pins and citations.
   */
  recheck(entry: VaultEntry): Promise<{ readonly kind: "clear" } | { readonly kind: "protected"; readonly signal: SignalId }>;
  /** Hits per signal so far in this sweep, for the report (R1, R5). */
  hits(): Readonly<Record<SignalId, number>>;
}

/**
 * One Protector per sweep or purge pass. `windows` and `clock` are the run's: `supersededDays` bounds
 * which superseded memories still count as citing, `coldDays` through the clock's cutoff bounds the
 * `retrieved` signal. The sweep passes its RunRow windows, and purge passes the current settings'.
 */
export function createProtector(
  kv: StateKV,
  windows: Pick<Windows, "supersededDays" | "coldDays">,
  clock: ActiveClock,
): Promise<Protector> {
  void kv;
  void windows;
  void clock;
  // TODO: build the cited-by-memory and cited-by-insight sets with scanRows; return a Protector whose
  //  judge() checks signals in cost order (free fields first, then point reads) and mints Cleared.
  throw new Error("not implemented");
}

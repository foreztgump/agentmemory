import type { StateKV } from "../../state/kv.js";
import type { CompressedObservation, Memory } from "../../types.js";
import type { ItemRef, Reason, SessionSeal, SignalId } from "./types.js";

declare const cleared: unique symbol;

/** Proof that a session's summary covers every row (seal.ts). Only `judgeSeal` returns one. */
export interface SealProof {
  readonly seal: SessionSeal;
}

/** Proof that a superseded memory's successor exists, is latest and the chain has no cycle. */
export interface ChainProof {
  readonly successorId: string;
}

export type Candidate =
  | { readonly stage: "T" | "O"; readonly ref: Extract<ItemRef, { kind: "observation" }>; readonly row: CompressedObservation; readonly proof: SealProof; readonly reason: Reason }
  | { readonly stage: "S"; readonly ref: Extract<ItemRef, { kind: "memory" }>; readonly row: Memory; readonly proof: ChainProof; readonly reason: Reason }
  | { readonly stage: "X" | "C"; readonly ref: Extract<ItemRef, { kind: "memory" }>; readonly row: Memory; readonly reason: Reason };

/** A candidate that passed every protection signal. `displace` accepts nothing else. */
export type Cleared = Candidate & { readonly [cleared]: true };

export type Verdict =
  | { readonly kind: "clear"; readonly item: Cleared }
  | { readonly kind: "protected"; readonly signal: SignalId; readonly candidate: Candidate };

/**
 * Section 6 signals, each a point read or a per-sweep pass over a small collection, never a whole read of
 * a growing one:
 *   pin              mem:retention:pins point read.
 *   importance       row.importance >= 8 (only LLM compression writes other than 5; off on both stacks today).
 *   deliberate-save  a latest memory is never trashed on age alone (stages X and C only touch it).
 *   cited-by-memory  ids from `sourceObservationIds` of latest memories and of superseded ones still inside
 *                    their window, collected once per sweep in one paged pass over mem:memories into a Set.
 *                    Memories are about 1% of observations (760 on buddy).
 *                    ponytail: in-RAM Set, spill to a sweep-scratch scope above 500k ids (design 6).
 *   cited-by-insight Insight.sourceMemoryIds, one paged pass over mem:insights.
 *   cited-by-graph   observation and edgeObservation postings, point reads; not a veto: lowers priority
 *                    so cited rows go last, and counts in the report.
 *   retrieved        mem:access point read: access within the cold window protects; no access is not evidence.
 *   lesson           lessons are never candidates (R5); the signal exists so the report can say so.
 *   memory-type      architecture and preference memories are never demoted (stage C).
 * Re-run at purge time (design 4.6): an entry that became protected during grace is restored instead.
 */
export interface Protector {
  judge(candidate: Candidate): Promise<Verdict>;
  /** Hits per signal so far in this sweep, for the report (R1, R5). */
  hits(): Readonly<Record<SignalId, number>>;
}

export function createProtector(kv: StateKV, coldWindowMs: number): Promise<Protector> {
  void kv;
  void coldWindowMs;
  // TODO: build the cited-by-memory and cited-by-insight sets with scanRows; return a Protector whose
  //  judge() checks signals in cost order (free fields first, then point reads) and mints Cleared.
  throw new Error("not implemented");
}

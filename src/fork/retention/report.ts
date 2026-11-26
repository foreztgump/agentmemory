import type { Candidate } from "./protect.js";
import type { RunId, SignalId, Stage } from "./types.js";
import type { SealRefusal } from "./seal.js";

/** R1: everything the dry-run report must hold. Every run writes one, enforcing or not (D4). */
export interface RunReport {
  readonly runId: RunId;
  readonly dryRun: boolean;
  readonly perStage: Record<Stage, { count: number; bytes: number }>;
  readonly perProject: Record<string, Record<Stage, { count: number; bytes: number }>>;
  /** At most 20 per stage, with reasons. */
  readonly samples: Record<Stage, readonly { id: string; reason: string }[]>;
  readonly protectionHits: Readonly<Record<SignalId, number>>;
  /** Items held back by each signal, at most 20 per signal (R5 lists each protected fixture). */
  readonly protectedSamples: Readonly<Record<SignalId, readonly string[]>>;
  /** Sessions with no seal, by reason. */
  readonly undigested: Readonly<Record<SealRefusal, number>>;
  /** Observations containing an <agentmemory-context> block (design 5.3). */
  readonly injectedContext: number;
  /** Rows not trashed because the backend cannot read their vector back (vectors.ts). */
  readonly vectorUnreadable: number;
  readonly recall?: { readonly before: number; readonly after: number; readonly verdict: string };
  readonly diffFromLastReport?: Partial<Record<Stage, number>>;
}

/** Accumulates a report in bounded memory: counters plus capped sample arrays. */
export interface ReportBuilder {
  candidate(c: Candidate, bytes: number, project: string): void;
  protectedHit(signal: SignalId, id: string): void;
  undigested(why: SealRefusal): void;
  finish(extra: Pick<RunReport, "injectedContext" | "vectorUnreadable" | "recall">): RunReport;
}

export function createReportBuilder(runId: RunId, dryRun: boolean): ReportBuilder {
  void runId;
  void dryRun;
  throw new Error("not implemented");
}

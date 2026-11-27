import type { Candidate } from "./protect.js";
import type { SealRefusal } from "./seal.js";
import type { Outcome, RunId, SignalId, Stage } from "./types.js";

export const REPORT_SAMPLES = 20;
const STAGES: readonly Stage[] = ["T", "O", "S", "X", "C"];
const SEAL_REFUSALS: readonly SealRefusal[] = ["active", "recent-capture", "no-summary", "summary-out-of-date", "compression-pending", "no-session"];
const SIGNALS: readonly SignalId[] = [
  "pin", "importance", "deliberate-save", "cited-by-memory", "cited-by-insight", "cited-by-graph", "retrieved", "lesson", "memory-type",
];

export interface StageTotals {
  readonly count: number;
  readonly bytes: number;
}

/** R1: everything the dry-run report must hold. Every run writes one, enforcing or not (D4). */
export interface RunReport {
  readonly runId: RunId;
  readonly dryRun: boolean;
  readonly outcome: Outcome;
  /** Why a run was refused or restored. */
  readonly why?: string;
  /** True when a sweep that resumed the run finished this report, so its samples and hits cover the resumed part only. */
  readonly resumed: boolean;
  /** `count` and `bytes` are what the plan found; `moved` is what the run displaced. */
  readonly perStage: Readonly<Record<Stage, StageTotals & { readonly moved: number }>>;
  readonly perProject: Readonly<Record<string, Readonly<Record<Stage, StageTotals>>>>;
  /** At most REPORT_SAMPLES per stage. `id` is the memory id, or `<session>/<observation>`. */
  readonly samples: Readonly<Record<Stage, readonly { id: string; reason: string }[]>>;
  readonly protectionHits: Readonly<Record<SignalId, number>>;
  /** Items held back by each signal, at most REPORT_SAMPLES per signal (R5 lists each protected fixture). */
  readonly protectedSamples: Readonly<Record<SignalId, readonly string[]>>;
  /** Sessions sealed this run, and the ones with no seal by reason. */
  readonly sealed: number;
  readonly undigested: Readonly<Record<SealRefusal, number>>;
  /**
   * Planned observations whose row text holds an `<agentmemory-context>` block (design 5.3), out of those the plan
   * read. A row already trimmed holds no source, so this is a floor, and rows that are not candidates are not read.
   */
  readonly injectedContext: number;
  readonly injectedContextScanned: number;
  /** Rows not moved because the backend could not read their vector back (vectors.ts). */
  readonly vectorUnreadable: number;
  /** Stage O cap of this run (10% of observations on a stack's first enforcing run), null when uncapped. */
  readonly observationCap: number | null;
  readonly recall?: {
    readonly before: number;
    readonly after: number | null;
    readonly verdict: "keep" | "restore" | "pending";
    /** Golden cases that hit before the run, so a resumed run can still judge the after-check. */
    readonly goldenBefore: readonly string[];
  };
  readonly restored?: { readonly why: string; readonly restored: number; readonly keptLive: number; readonly deferred: number };
}

/** Accumulates a report in bounded memory: counters plus capped sample arrays. */
export interface ReportBuilder {
  candidate(c: Candidate): void;
  protectedHit(signal: SignalId, c: Candidate): void;
  undigested(why: SealRefusal, count: number): void;
  sealed(count: number): void;
  finish(extra: { readonly protectionHits: Readonly<Record<SignalId, number>>; readonly resumed: boolean }): RunReport;
}

export const idOf = (ref: Candidate["ref"]): string => (ref.kind === "memory" ? ref.id : `${ref.sessionId}/${ref.id}`);

const empty = <T>(make: () => T): Record<Stage, T> => Object.fromEntries(STAGES.map((stage) => [stage, make()])) as Record<Stage, T>;

/** Bytes the move would free: the whole row, or just `source` for a trim. */
const bytesOf = (c: Candidate, rowJson: string): number =>
  Buffer.byteLength(c.stage === "T" && "source" in c.row ? JSON.stringify(c.row.source) ?? "" : rowJson);

export function createReportBuilder(runId: RunId, dryRun: boolean): ReportBuilder {
  const totals = empty(() => ({ count: 0, bytes: 0 }));
  const projects = new Map<string, Record<Stage, { count: number; bytes: number }>>();
  const samples = empty<{ id: string; reason: string }[]>(() => []);
  const held = Object.fromEntries(SIGNALS.map((signal) => [signal, [] as string[]])) as Record<SignalId, string[]>;
  const refusals = Object.fromEntries(SEAL_REFUSALS.map((why) => [why, 0])) as Record<SealRefusal, number>;
  let sealedCount = 0;
  let injected = 0;
  let scanned = 0;
  return {
    candidate(c) {
      const rowJson = JSON.stringify(c.row);
      const bytes = bytesOf(c, rowJson);
      totals[c.stage].count++;
      totals[c.stage].bytes += bytes;
      const project = projects.get(c.project) ?? empty(() => ({ count: 0, bytes: 0 }));
      project[c.stage].count++;
      project[c.stage].bytes += bytes;
      projects.set(c.project, project);
      if (samples[c.stage].length < REPORT_SAMPLES) samples[c.stage].push({ id: idOf(c.ref), reason: `${c.reason.note} (${c.reason.ageActiveDays} active days)` });
      if (c.ref.kind === "observation") {
        scanned++;
        if (rowJson.includes("<agentmemory-context")) injected++;
      }
    },
    protectedHit(signal, c) {
      if (held[signal].length < REPORT_SAMPLES) held[signal].push(idOf(c.ref));
    },
    undigested(why, count) {
      refusals[why] += count;
    },
    sealed(count) {
      sealedCount = count;
    },
    finish: ({ protectionHits, resumed }) => ({
      runId,
      dryRun,
      outcome: dryRun ? "dry-run" : "running",
      resumed,
      perStage: Object.fromEntries(STAGES.map((stage) => [stage, { ...totals[stage], moved: 0 }])) as RunReport["perStage"],
      perProject: Object.fromEntries(projects),
      samples,
      protectionHits,
      protectedSamples: held,
      sealed: sealedCount,
      undigested: refusals,
      injectedContext: injected,
      injectedContextScanned: scanned,
      vectorUnreadable: 0,
      observationCap: null,
    }),
  };
}

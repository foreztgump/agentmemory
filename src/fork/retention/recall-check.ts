/**
 * The recall check before and after an enforcing run (design 7.4, D5).
 *
 * Cases: the stack's golden recall cases from AM_RETENTION_RECALL_CASES (spec AC4; private, mounted on the
 * stack, never committed) plus rare-fact cases drawn from protected memories at sweep start. With no
 * golden cases configured the run is report-only (`refused`): an unmeasured sweep does not delete.
 *
 * Queries go through `mem::smart-search` with sdk.trigger, so they test what agents get, in either mode.
 * Before the after-check, the docs outbox is drained (`settle`) so disk-mode removals have landed.
 */
export interface RecallCase {
  readonly id: string;
  readonly query: string;
  /** Observation or memory ids whose presence in the top 10 counts as recalled. */
  readonly evidence: readonly string[];
  readonly golden: boolean;
}

export interface RecallScore {
  readonly recallAt10: number;
  /** Golden cases with at least one evidence id in the top 10. */
  readonly goldenHit: ReadonlySet<string>;
}

export type RecallJudgement =
  | { readonly kind: "keep" }
  | { readonly kind: "restore"; readonly why: string };

/** Pure: restore when recall@10 drops by more than `stopPoints` or any golden case loses its evidence. */
export function judgeRecall(before: RecallScore, after: RecallScore, stopPoints: number): RecallJudgement {
  void before;
  void after;
  void stopPoints;
  throw new Error("not implemented");
}

export interface RecallHarness {
  /** Drains the search outboxes so the index reflects every move (disk mode); no-op in memory mode. */
  settle(): Promise<void>;
  score(cases: readonly RecallCase[]): Promise<RecallScore>;
}

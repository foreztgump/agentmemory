/**
 * The field the demote slice adds to `Memory` in `src/types.ts` (seam). Typed structurally here
 * until that slice lands, so this sketch compiles against today's `Memory`.
 */
export interface RetentionMark {
  readonly retention?: { readonly demotedAt?: string; readonly runId?: string };
}

/**
 * The fork's addition to "may this memory be indexed". A demoted (cold) memory stays in `mem:memories`
 * but must stay out of every index. Every place that decides indexability from the record applies this:
 *   - memory-mode boot rebuild and `indexRecords` in `src/functions/search.ts` (seam, 2 lines);
 *   - TEE-1169's `docOfRecord` memory branch (reconcile and re-embed, 1 line once TEE-1169 merges);
 * so neither the reconciler nor a restart re-adds a demoted memory (grounding: R8 in disk mode).
 *
 * The mark is presence, not truthiness: `demotedAt` is an ISO timestamp the sweep writes, and any value
 * other than `undefined` (an empty string included) hides the memory, so no writer un-demotes by accident.
 *
 * Observations need no predicate: retention moves a soft-deleted row out of `mem:obs:<session>`, so
 * every reader sees it as absent, exactly as after a delete (design 4.4).
 */
export function hiddenFromIndex(memory: RetentionMark | null | undefined): boolean {
  return memory?.retention?.demotedAt !== undefined;
}

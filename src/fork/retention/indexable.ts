import type { Memory } from "../../types.js";

/**
 * The fork's addition to "may this memory be indexed". A demoted (cold) memory stays in `mem:memories`
 * but must stay out of every index. Every place that decides indexability from the record applies this:
 *   - memory-mode boot rebuild and `indexRecords` in `src/functions/search.ts` (seam, 2 lines);
 *   - TEE-1169's `docOfRecord` memory branch (reconcile and re-embed, 1 line);
 * so neither the reconciler nor a restart re-adds a demoted memory (grounding: R8 in disk mode).
 *
 * The mark is presence, not truthiness: `demotedAt` is an ISO timestamp the sweep writes, and any value
 * other than `undefined` (an empty string included) hides the memory, so no writer un-demotes by accident.
 * The mark names the memory it was written on, so a writer that copies a row into a new memory (`mem::evolve`
 * spreads the old one) does not hide the new version with the old one's mark.
 *
 * Observations need no predicate: retention moves a soft-deleted row out of `mem:obs:<session>`, so
 * every reader sees it as absent, exactly as after a delete (design 4.4).
 */
export function hiddenFromIndex(memory: Pick<Memory, "id" | "retention"> | null | undefined): boolean {
  const mark = memory?.retention;
  return mark !== undefined && mark.demotedAt !== undefined && mark.memoryId === memory?.id;
}

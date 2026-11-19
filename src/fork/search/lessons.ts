import type { StateKV } from "../../state/kv.js";
import { lessonToObservation } from "../../state/memory-utils.js";
import { KV } from "../../state/schema.js";
import type { LessonIndexPort, ScoredId } from "../../state/search-ports.js";
import type { Lesson } from "../../types.js";

export interface LessonCandidates {
  hits: ScoredId[];
  lessonOf(id: string): Lesson | undefined;
}

/**
 * Disk-mode recall candidates: the lessons collection's top hits, then the
 * hits' records from KV. The records live in a map for this call only, so
 * nothing grows with the number of lessons.
 */
export async function diskLessonCandidates(
  index: LessonIndexPort,
  kv: StateKV,
  query: string,
  fetchLimit: number,
): Promise<LessonCandidates> {
  const hits = await index.search(query, fetchLimit, "all");
  if (hits.length === 0) return { hits, lessonOf: () => undefined };
  const rows = await kv.getMany<Lesson>(KV.lessons, hits.map((h) => h.obsId));
  const records = new Map<string, Lesson>();
  rows.forEach((lesson) => {
    if (lesson) records.set(lesson.id, lesson);
  });
  return { hits, lessonOf: (id) => records.get(id) };
}

/** Repairs these ids from KV, re-sending live lessons even when the ledger already holds their revision. Idempotent. */
export async function convergeLessons(index: LessonIndexPort, kv: StateKV, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await kv.getMany<Lesson>(KV.lessons, unique);
  unique.forEach((id, i) => {
    const lesson = rows[i];
    if (lesson && !lesson.deleted) index.add(lessonToObservation(lesson), "lesson");
    else index.remove(id);
  });
}

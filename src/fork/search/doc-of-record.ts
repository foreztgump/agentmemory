import { memoryToObservation, observationEmbedText } from "../../state/memory-utils.js";
import { termSourceOf } from "../../state/term-extraction.js";
import type { CompressedObservation, Memory } from "../../types.js";
import { hiddenFromIndex } from "../retention/indexable.js";
import { contentRev, type ContentRev } from "./protocol.js";

export type RecordKind = "observation" | "memory";

/** What the search index holds for one record. */
export interface IndexDoc {
  obs: CompressedObservation;
  layer: RecordKind;
  rev: ContentRev;
  embedText: string;
}

/**
 * null when the record is absent or not indexable. The predicates are the
 * ones indexRecords and the memory-mode rebuild apply: an observation needs
 * a title and a narrative, a memory must be the latest version with a title
 * and content, and not demoted by retention.
 */
export function docOfRecord(kind: RecordKind, row: unknown): IndexDoc | null {
  if (!row || typeof row !== "object") return null;
  if (kind === "observation") {
    const obs = row as CompressedObservation;
    if (!obs.title || !obs.narrative) return null;
    return { obs, layer: kind, rev: contentRev(termSourceOf(obs)), embedText: observationEmbedText(obs) };
  }
  const memory = row as Memory;
  if (memory.isLatest === false || !memory.title || !memory.content || hiddenFromIndex(memory)) return null;
  const obs = memoryToObservation(memory);
  return {
    obs,
    layer: kind,
    rev: contentRev(termSourceOf(obs)),
    embedText: observationEmbedText(obs),
  };
}

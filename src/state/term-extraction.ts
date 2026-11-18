import type { CompressedObservation } from "../types.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { segmentCjk, hasCjk } from "./cjk-segmenter.js";

const USER_PROMPT_TERM_CAP = 2000;
const ASSISTANT_RESPONSE_TERM_CAP = 1000;
const TOOL_OUTPUT_TERM_CAP = 1000;

const SYNONYM_WEIGHT = 0.7;

export interface WeightedTerm {
  term: string;
  weight: number;
}

export function tokenize(text: string): string[] {
  const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (raw.length < 2) continue;
    if (hasCjk(raw)) {
      for (const seg of segmentCjk(raw)) {
        if (seg.length >= 1) out.push(seg);
      }
    } else {
      out.push(stem(raw));
    }
  }
  return out;
}

export function extractTerms(obs: CompressedObservation): string[] {
  const parts = [
    obs.title,
    obs.subtitle || "",
    obs.narrative,
    ...obs.facts,
    ...obs.concepts,
    ...obs.files,
    obs.type,
  ];
  if (obs.source?.userPrompt) {
    parts.push(obs.source.userPrompt.slice(0, USER_PROMPT_TERM_CAP));
  }
  if (obs.source?.assistantResponse) {
    parts.push(
      obs.source.assistantResponse.slice(0, ASSISTANT_RESPONSE_TERM_CAP),
    );
  }
  if (
    obs.source?.toolName === "conversation" &&
    typeof obs.source.toolOutput === "string"
  ) {
    parts.push(obs.source.toolOutput.slice(0, TOOL_OUTPUT_TERM_CAP));
  }
  return tokenize(parts.join(" ").toLowerCase());
}

export function queryTerms(query: string): WeightedTerm[] {
  const terms: WeightedTerm[] = [];
  const seen = new Set<string>();
  for (const term of tokenize(query.toLowerCase())) {
    if (!seen.has(term)) {
      seen.add(term);
      terms.push({ term, weight: 1.0 });
    }
    for (const syn of getSynonyms(term)) {
      if (!seen.has(syn)) {
        seen.add(syn);
        terms.push({ term: syn, weight: SYNONYM_WEIGHT });
      }
    }
  }
  return terms;
}

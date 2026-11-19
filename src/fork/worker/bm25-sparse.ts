import { extractTerms, queryTerms, type TermSource, type WeightedTerm } from "../../state/term-extraction.js";

// Same constants as SearchIndex. Qdrant's idf modifier computes
// ln((N - n + 0.5) / (n + 0.5) + 1), which is SearchIndex's idf, so only the
// tf and length part of BM25 is computed here.
const K1 = 1.2;
const B = 0.75;

export interface Sparse {
  indices: number[];
  values: number[];
}

/** FNV-1a, 32 bit. Two terms that collide share a posting list; the spike measured recall with this hash. */
export function termId(term: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(term, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// The tokenizer keeps a trailing ". / \\ ] ^ _", so "deploy." ends a sentence as
// its own term. SearchIndex still matches the query "deploy" through prefix
// expansion at half the idf; Qdrant has no prefix search, so the bare form is
// indexed beside it at half weight.
const TRAILING_PUNCTUATION = /[./\\\]^_]+$/u;
export const PREFIX_WEIGHT = 0.5;

export function bareForm(term: string): string {
  return term.replace(TRAILING_PUNCTUATION, "");
}

export function docSparse(fields: TermSource, avgdl: number): Sparse {
  return termsSparse(extractTerms(fields), avgdl);
}

/** BM25 document weights for the extracted terms of one document, normalised by the corpus mean length. */
export function termsSparse(terms: readonly string[], avgdl: number): Sparse {
  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  const norm = K1 * (1 - B + (B * terms.length) / avgdl);
  const weight = (tf: number) => (tf * (K1 + 1)) / (tf + norm);
  const weights = new Map<number, number>();
  for (const [term, tf] of counts) {
    const id = termId(term);
    weights.set(id, (weights.get(id) ?? 0) + weight(tf));
  }
  for (const [term, tf] of counts) {
    const bare = bareForm(term);
    if (bare === term || bare.length < 2 || counts.has(bare)) continue;
    const id = termId(bare);
    weights.set(id, Math.max(weights.get(id) ?? 0, PREFIX_WEIGHT * weight(tf)));
  }
  return { indices: [...weights.keys()], values: [...weights.values()] };
}

/** The query's own terms (one weight per id), plus prefix terms, which add: each scores for its own query term, as in SearchIndex. */
export function querySparse(query: string, expand?: (terms: readonly WeightedTerm[]) => WeightedTerm[]): Sparse {
  const exact = queryTerms(query);
  const weights = new Map<number, number>();
  for (const { term, weight } of exact) {
    const id = termId(term);
    weights.set(id, Math.max(weights.get(id) ?? 0, weight));
  }
  for (const { term, weight } of expand?.(exact) ?? []) {
    const id = termId(term);
    weights.set(id, (weights.get(id) ?? 0) + weight);
  }
  return { indices: [...weights.keys()], values: [...weights.values()] };
}

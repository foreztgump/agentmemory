import type { WeightedTerm } from "../../state/term-extraction.js";
import type { Hit } from "../search/protocol.js";

const K1 = 1.2;
const B = 0.75;

export interface LexicalDocument {
  id: string;
  sessionId: string;
  terms: readonly string[];
  dl: number;
}

export interface LexicalTerm extends WeightedTerm {
  prefixes: string[];
}

const sortedVocabularies = new WeakMap<ReadonlyMap<string, number>, string[]>();

/** The vocabulary in sort order, computed once per cached frequency map rather than per query. */
function sortedVocabulary(frequencies: ReadonlyMap<string, number>): string[] {
  let sorted = sortedVocabularies.get(frequencies);
  if (!sorted) sortedVocabularies.set(frequencies, (sorted = [...frequencies.keys()].sort()));
  return sorted;
}

/** The first index whose term is not below `term`. */
export function lowerBound(sorted: readonly string[], term: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < term) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function expandLexicalTerms(query: readonly WeightedTerm[], frequencies: ReadonlyMap<string, number>): LexicalTerm[] {
  const vocabulary = sortedVocabulary(frequencies);
  return query.map(({ term, weight }) => {
    const prefixes: string[] = [];
    for (let i = lowerBound(vocabulary, term); i < vocabulary.length && vocabulary[i]!.startsWith(term); i++) {
      if (vocabulary[i] !== term) prefixes.push(vocabulary[i]!);
    }
    return { term, weight, prefixes };
  });
}

export function lexicalBm25(
  documents: readonly LexicalDocument[],
  query: readonly LexicalTerm[],
  frequencies: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number,
  limit: number,
): Hit[] {
  if (documentCount === 0 || query.length === 0) return [];
  const postings = new Map<string, Map<LexicalDocument, number>>();
  for (const doc of documents) {
    for (const term of doc.terms) {
      let posting = postings.get(term);
      if (!posting) postings.set(term, posting = new Map());
      posting.set(doc, (posting.get(doc) ?? 0) + 1);
    }
  }
  const scores = new Map<LexicalDocument, number>();
  const score = (term: string, tf: number, dl: number, weight: number, prefix: boolean): number => {
    // ponytail: beyond the vocabulary's maxTerms ceiling (or during a concurrent fill), candidate df is the bounded fallback.
    const candidateDocumentFrequency = postings.get(term)?.size ?? 1;
    const df = frequencies.get(term) ?? candidateDocumentFrequency;
    const idf = Math.log((documentCount - df + 0.5) / (df + 0.5) + 1) * (prefix ? 0.5 : 1);
    const numerator = tf * (K1 + 1);
    const denominator = tf + K1 * (1 - B + B * (dl / averageLength));
    return idf * (numerator / denominator) * weight;
  };
  for (const { term, weight, prefixes } of query) {
    const exact = postings.get(term);
    for (const [doc, tf] of exact ?? []) {
      scores.set(doc, (scores.get(doc) || 0) + score(term, tf, doc.dl, weight, false));
    }
    const prefixScores = new Map<LexicalDocument, number>();
    for (const prefix of prefixes) {
      for (const [doc, tf] of postings.get(prefix) ?? []) {
        if (exact?.has(doc)) continue;
        prefixScores.set(doc, Math.max(prefixScores.get(doc) ?? 0, score(prefix, tf, doc.dl, weight, true)));
      }
    }
    for (const [doc, value] of prefixScores) scores.set(doc, (scores.get(doc) ?? 0) + value);
  }
  return [...scores].map(([doc, score]) => ({ id: doc.id, sessionId: doc.sessionId, score }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

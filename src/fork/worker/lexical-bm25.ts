import type { WeightedTerm } from "../../state/term-extraction.js";
import type { Hit } from "../search/protocol.js";

const K1 = 1.2;
const B = 0.75;
/**
 * No document's exact BM25 weight for one term reaches this: tf(K1 + 1) / (tf + K1(1 - B + B dl/avgdl)) with 1 - B > 0.
 * A stored weight at a hashed id can pass it when two terms collide, but a bound on one term's weight may still clamp to it.
 */
export const TERM_WEIGHT_CAP = K1 + 1;

export interface LexicalDocument {
  id: string;
  sessionId: string;
  terms: readonly string[];
  dl: number;
}

export interface LexicalTerm extends WeightedTerm {
  prefixes: string[];
}

/** The terms and length a stored point was indexed with; undefined for a payload without valid terms. */
export function storedDocument(payload: { terms?: unknown; dl?: unknown } | undefined): { terms: string[]; dl: number } | undefined {
  const terms = payload?.terms;
  if (!Array.isArray(terms) || !terms.every((term): term is string => typeof term === "string")) return undefined;
  return { terms, dl: typeof payload?.dl === "number" ? payload.dl : terms.length };
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

function termScore(df: number, documentCount: number, tf: number, dl: number, averageLength: number, weight: number, prefix: boolean): number {
  const idf = Math.log((documentCount - df + 0.5) / (df + 0.5) + 1) * (prefix ? 0.5 : 1);
  const numerator = tf * (K1 + 1);
  const denominator = tf + K1 * (1 - B + B * (dl / averageLength));
  return idf * (numerator / denominator) * weight;
}

/**
 * One document's lexicalBm25 score with the same arithmetic in the same order, or undefined when it matches no query term.
 * A term the vocabulary lacks scores 0 here, where lexicalBm25 falls back to its candidates' df, so this never exceeds
 * lexicalBm25's score for the document in any candidate set.
 */
export function documentBm25(
  document: LexicalDocument,
  query: readonly WeightedTerm[],
  frequencies: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number,
): number | undefined {
  if (documentCount === 0) return undefined;
  const counts = new Map<string, number>();
  for (const term of document.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  const score = (term: string, tf: number, weight: number, prefix: boolean) => {
    const df = frequencies.get(term);
    return df ? termScore(df, documentCount, tf, document.dl, averageLength, weight, prefix) : 0;
  };
  let total: number | undefined;
  for (const { term, weight } of query) {
    const exact = counts.get(term);
    let value: number | undefined;
    if (exact !== undefined) value = score(term, exact, weight, false);
    else {
      for (const [candidate, tf] of counts) {
        if (candidate !== term && candidate.startsWith(term)) value = Math.max(value ?? 0, score(candidate, tf, weight, true));
      }
    }
    if (value !== undefined) total = (total ?? 0) + value;
  }
  return total;
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
    const df = frequencies.get(term) || candidateDocumentFrequency;
    return termScore(df, documentCount, tf, dl, averageLength, weight, prefix);
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

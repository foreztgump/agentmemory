import { extractTerms, queryTerms, type TermSource } from "../../state/term-extraction.js";

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

export function docSparse(fields: TermSource, avgdl: number): Sparse {
  const terms = extractTerms(fields);
  const tf = new Map<number, number>();
  for (const t of terms) {
    const id = termId(t);
    tf.set(id, (tf.get(id) ?? 0) + 1);
  }
  const norm = K1 * (1 - B + (B * terms.length) / avgdl);
  const indices = [...tf.keys()];
  return { indices, values: indices.map((id) => (tf.get(id)! * (K1 + 1)) / (tf.get(id)! + norm)) };
}

export function querySparse(query: string): Sparse {
  const weights = new Map<number, number>();
  for (const { term, weight } of queryTerms(query)) {
    const id = termId(term);
    weights.set(id, Math.max(weights.get(id) ?? 0, weight));
  }
  return { indices: [...weights.keys()], values: [...weights.values()] };
}

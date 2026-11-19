import type { WeightedTerm } from "../../state/term-extraction.js";
import { logger } from "../../logger.js";
import { bareForm, PREFIX_WEIGHT } from "./bm25-sparse.js";
import { lowerBound } from "./lexical-bm25.js";
import type { Qdrant } from "./qdrant.js";
import { TOMBSTONE } from "./versioned.js";

export interface VocabularyLimits {
  /** Distinct terms held. Past it new terms are not learned; their exact matches still work. */
  maxTerms: number;
  /** Prefix terms one query term adds; the rarest survive, as they score highest. */
  expansionsPerTerm: number;
}

// About 61 B per term measured in TEE-1167, so the bound is about 60 MiB.
export const DEFAULT_VOCABULARY_LIMITS: VocabularyLimits = { maxTerms: 1_000_000, expansionsPerTerm: 64 };

/**
 * Terms learned since the last fold are scanned linearly; past this many they
 * merge into the sorted array. Growing with the array keeps a fold's copy
 * amortized at about 64 moves per learned term.
 */
const foldAfter = (sorted: number) => Math.max(1024, sorted >>> 6);
/** Prefix matches examined per query term, so a two-letter term cannot walk the whole vocabulary. */
const MAX_SCAN = 8192;
const FILL_PAGE = 1000;

interface ScrollPage {
  points: Array<{ payload?: { terms?: unknown } }>;
  next_page_offset?: string | null;
}

/**
 * The docs collection's terms with an approximate document frequency, for
 * prefix expansion of keyword queries. One background scroll of the stored
 * `terms` payload fills it; afterwards the engine's writes teach it new
 * terms, so a write never invalidates it. df only orders expansions (Qdrant
 * owns the idf the score uses), so it is never decremented.
 */
export class PrefixVocabulary {
  private df = new Map<string, number>();
  private sorted: string[] = [];
  private fresh: string[] = [];
  private filling: Promise<void> | null = null;
  private filled = false;
  private epoch = 0;
  private refused = 0;

  constructor(
    private readonly qdrant: Qdrant,
    private readonly ready: () => Promise<void>,
    private readonly limits: VocabularyLimits = DEFAULT_VOCABULARY_LIMITS,
  ) {}

  get size(): number {
    return this.df.size;
  }

  /** Terms not learned because the vocabulary was full. */
  get refusedTerms(): number {
    return this.refused;
  }

  /** The terms of one written document. */
  observe(terms: readonly string[]): void {
    for (const term of new Set(terms)) this.learn(term, 1);
    if (this.fresh.length > foldAfter(this.sorted.length)) this.fold();
  }

  /** The prefix terms of each query term at half its weight; none until the first fill lands. */
  expand(terms: readonly WeightedTerm[]): WeightedTerm[] {
    const out: WeightedTerm[] = [];
    for (const { term, weight } of terms) {
      for (const prefix of this.prefixesOf(term)) out.push({ term: prefix, weight: PREFIX_WEIGHT * weight });
    }
    return out;
  }

  /** Starts the one read of the collection; a no-op once filled or while running. A search never awaits it. */
  fillInBackground(): void {
    if (this.filled || this.filling) return;
    const filling = this.fill()
      .catch((error) => logger.warn("am-search could not read the prefix vocabulary; the next search retries", { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (this.filling === filling) this.filling = null;
      });
    this.filling = filling;
  }

  async settled(): Promise<void> {
    while (this.filling) await this.filling;
  }

  /** The collection was dropped; a running fill is discarded. */
  clear(): void {
    this.df = new Map();
    this.sorted = [];
    this.fresh = [];
    this.filled = false;
    this.filling = null;
    this.refused = 0;
    this.epoch++;
  }

  private learn(term: string, count: number): void {
    const known = this.df.get(term);
    if (known !== undefined) {
      this.df.set(term, known + count);
      return;
    }
    if (this.df.size >= this.limits.maxTerms) {
      if (this.refused++ === 0) logger.warn("am-search prefix vocabulary is full; new terms match only exactly", { maxTerms: this.limits.maxTerms });
      return;
    }
    this.df.set(term, count);
    this.fresh.push(term);
  }

  private fold(): void {
    const fresh = this.fresh.sort();
    const merged: string[] = new Array(this.sorted.length + fresh.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < this.sorted.length && j < fresh.length) merged[k++] = this.sorted[i]! < fresh[j]! ? this.sorted[i++]! : fresh[j++]!;
    while (i < this.sorted.length) merged[k++] = this.sorted[i++]!;
    while (j < fresh.length) merged[k++] = fresh[j++]!;
    this.sorted = merged;
    this.fresh = [];
  }

  private prefixesOf(term: string): string[] {
    const found: string[] = [];
    // The stored document vector already gives "deploy." the bare form "deploy" at half weight.
    const keep = (candidate: string) => candidate !== term && candidate.startsWith(term) && bareForm(candidate) !== term;
    for (let i = lowerBound(this.sorted, term), scanned = 0; i < this.sorted.length && scanned < MAX_SCAN; i++, scanned++) {
      const candidate = this.sorted[i]!;
      if (!candidate.startsWith(term)) break;
      if (keep(candidate)) found.push(candidate);
    }
    for (const candidate of this.fresh) if (keep(candidate)) found.push(candidate);
    if (found.length <= this.limits.expansionsPerTerm) return found;
    const rarity = (t: string) => this.df.get(t) ?? 0;
    return found.sort((a, b) => rarity(a) - rarity(b) || (a < b ? -1 : 1)).slice(0, this.limits.expansionsPerTerm);
  }

  private async fill(): Promise<void> {
    const epoch = this.epoch;
    await this.ready();
    const counted = new Map<string, number>();
    let offset: string | undefined;
    do {
      const page = await this.qdrant.call<ScrollPage>("POST", `${this.qdrant.path}/points/scroll`, {
        filter: { must_not: [TOMBSTONE] },
        limit: FILL_PAGE,
        ...(offset ? { offset } : {}),
        with_payload: ["terms"],
        with_vector: false,
      });
      if (epoch !== this.epoch) return;
      for (const { payload } of page.points) {
        if (!Array.isArray(payload?.terms)) continue;
        for (const term of new Set(payload.terms)) if (typeof term === "string") counted.set(term, (counted.get(term) ?? 0) + 1);
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset);
    // Terms written during the scroll are in df already; a document seen by both counts twice, which only nudges the order.
    for (const [term, count] of counted) {
      if (this.df.has(term)) this.df.set(term, Math.max(this.df.get(term)!, count));
      else this.learn(term, count);
    }
    this.fold();
    this.filled = true;
    logger.info("am-search prefix vocabulary ready", { terms: this.df.size, refused: this.refused });
  }
}

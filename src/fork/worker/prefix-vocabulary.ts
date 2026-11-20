import type { WeightedTerm } from "../../state/term-extraction.js";
import { logger } from "../../logger.js";
import { bareForm, PREFIX_WEIGHT } from "./bm25-sparse.js";
import { lowerBound, storedDocument } from "./lexical-bm25.js";
import type { Qdrant } from "./qdrant.js";
import { TOMBSTONE } from "./versioned.js";

export interface VocabularyLimits {
  /** Distinct terms held. Past it new terms are not learned; their exact matches still work. */
  maxTerms: number;
  /** Prefix terms one query term adds. */
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
  points: Array<{ payload?: { terms?: unknown; dl?: number } }>;
  next_page_offset?: string | null;
}

export class PrefixVocabulary {
  private df = new Map<string, number>();
  private sorted: string[] = [];
  private fresh: string[] = [];
  private filling: Promise<void> | null = null;
  private filled = false;
  private epoch = 0;
  private refused = 0;
  private documents = 0;
  private totalLength = 0;

  constructor(
    private readonly qdrant: Qdrant,
    private readonly ready: () => Promise<void>,
    private readonly limits: VocabularyLimits = DEFAULT_VOCABULARY_LIMITS,
  ) {}

  get size(): number {
    return this.df.size;
  }

  /** Term occurrences (not distinct terms) declined because the vocabulary was full. */
  get refusals(): number {
    return this.refused;
  }

  get isReady(): boolean {
    return this.filled;
  }

  get frequencies(): ReadonlyMap<string, number> {
    return this.df;
  }

  get documentCount(): number {
    return this.documents;
  }

  get averageLength(): number {
    return this.documents > 0 ? this.totalLength / this.documents : 0;
  }

  observe(terms: readonly string[]): void {
    this.replace(undefined, { terms, dl: terms.length });
  }

  replace(previous: { terms: readonly string[]; dl: number } | undefined, next: { terms: readonly string[]; dl: number } | undefined): void {
    if (previous) {
      this.documents--;
      this.totalLength -= previous.dl;
      for (const term of new Set(previous.terms)) {
        const count = this.df.get(term);
        if (count !== undefined) this.df.set(term, Math.max(0, count - 1));
      }
    }
    if (next) {
      this.documents++;
      this.totalLength += next.dl;
      for (const term of new Set(next.terms)) this.learn(term, 1);
    }
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
    this.documents = 0;
    this.totalLength = 0;
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
    const keep = (candidate: string) => (this.df.get(candidate) ?? 0) > 0 && candidate !== term && candidate.startsWith(term) && bareForm(candidate) !== term;
    for (let i = lowerBound(this.sorted, term), scanned = 0; i < this.sorted.length && scanned < MAX_SCAN; i++, scanned++) {
      const candidate = this.sorted[i]!;
      if (!candidate.startsWith(term)) break;
      if (keep(candidate)) found.push(candidate);
    }
    for (const candidate of this.fresh) if (keep(candidate)) found.push(candidate);
    if (found.length <= this.limits.expansionsPerTerm) return found;
    const rarity = (t: string) => this.df.get(t) ?? 0;
    const ranked = found.sort((a, b) => rarity(a) - rarity(b) || (a < b ? -1 : 1));
    // Common terms can win on short documents despite their lower idf.
    const common = Math.floor(this.limits.expansionsPerTerm / 4);
    return [...ranked.slice(0, this.limits.expansionsPerTerm - common), ...(common > 0 ? ranked.slice(-common) : [])];
  }

  private async fill(): Promise<void> {
    const epoch = this.epoch;
    await this.ready();
    const counted = new Map<string, number>();
    let documents = 0;
    let totalLength = 0;
    let offset: string | undefined;
    do {
      const page = await this.qdrant.call<ScrollPage>("POST", `${this.qdrant.path}/points/scroll`, {
        filter: { must_not: [TOMBSTONE] },
        limit: FILL_PAGE,
        ...(offset ? { offset } : {}),
        with_payload: ["terms", "dl"],
        with_vector: false,
      });
      if (epoch !== this.epoch) return;
      for (const { payload } of page.points) {
        // The engine's stored-document read too, so a later replace or delete subtracts what was added here.
        const stored = storedDocument(payload);
        if (!stored) continue;
        documents++;
        totalLength += stored.dl;
        for (const term of new Set(stored.terms)) {
          const known = counted.get(term);
          if (known !== undefined) counted.set(term, known + 1);
          else if (counted.size < this.limits.maxTerms) counted.set(term, 1);
          else this.refused++;
        }
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset);
    // ponytail: scrolls are not snapshots; error is bounded by the doc/del operations overlapping this fill and their lengths.
    for (const [term, count] of counted) {
      if (this.df.has(term)) this.df.set(term, Math.max(this.df.get(term)!, count));
      else this.learn(term, count);
    }
    this.documents = documents;
    this.totalLength = totalLength;
    this.fold();
    this.filled = true;
    logger.info("am-search prefix vocabulary ready", { terms: this.df.size, refused: this.refused });
  }
}

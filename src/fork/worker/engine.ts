import { base64ToFloat32 } from "../../state/vector-index.js";
import { isSearchLayer, isSearchResultLayer, type SearchLayer, type SearchResultLayer } from "../../state/search-layer.js";
import { extractTerms, queryTerms } from "../../state/term-extraction.js";
import { logger } from "../../logger.js";
import {
  type ApplyResult,
  type ContentRev,
  type DocOp,
  type HealthResult,
  type Hit,
  type LookupResult,
  type Op,
  type OpVersion,
  type ScanDocsResult,
  type ScanMissingResult,
  type StatsResult,
} from "../search/protocol.js";
import { querySparse, termsSparse } from "./bm25-sparse.js";
import { expandLexicalTerms, lexicalBm25, storedDocument, type LexicalDocument } from "./lexical-bm25.js";
import { DEFAULT_VOCABULARY_LIMITS, PrefixVocabulary, type VocabularyLimits } from "./prefix-vocabulary.js";
import { pointId, type Qdrant } from "./qdrant.js";
import { notNewerThan, TOMBSTONE, VersionClock } from "./versioned.js";

interface ScoredPoint { id: string; score: number; payload?: RecordPoint["payload"] }
interface RecordPoint {
  id: string;
  payload?: { doc_id?: string; session_id?: string; layer?: string; rev?: string; deleted?: boolean; terms?: unknown; dl?: number; lexical_order?: [number, number]; v?: unknown };
}
interface StoredPayload {
  rev?: ContentRev;
  v?: unknown;
  deleted?: boolean;
  document?: { terms: string[]; dl: number };
}

const HIT_PAYLOAD = ["doc_id", "session_id"];
export const MAX_LIMIT = 1000;
const LAYERS: SearchResultLayer[] = ["memory", "observation", "lesson", "insight"];

// Stored BM25 weights are rewritten once the corpus mean drifts this far from
// the mean they were computed with; BM25 rankings barely move inside it.
const AVGDL_DRIFT = 0.1;
const REWEIGHT_PAGE = 256;
const DL_FACET_LIMIT = 100_000;
const LESSON_TERMS_FILTER_LIMIT = 1024;
const KEYWORD_CANDIDATE_MULTIPLIER = 4;
const KEYWORD_CANDIDATE_MARGIN = 500;

const LIVE_DOCS = { must: [{ key: "layer", match: { any: LAYERS } }] };

function meanLength(docs: string[][]): number | null {
  const total = docs.reduce((n, terms) => n + terms.length, 0);
  return total > 0 ? total / docs.length : null;
}

function layerFilter(layer: SearchLayer): unknown {
  return { ...(layer === "all" ? {} : { must: [{ key: "layer", match: { value: layer } }] }), must_not: [TOMBSTONE] };
}

const MISSING_VECTOR_FILTER = {
  must: [
    { key: "dense", match: { value: false } },
    { key: "layer", match: { any: ["observation", "memory"] } },
  ],
};

function toHits(points: ScoredPoint[]): Hit[] {
  return points.flatMap((p) => (p.payload?.doc_id ? [{ id: p.payload.doc_id, sessionId: p.payload.session_id ?? "", score: p.score }] : []));
}

export function clampLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit))) : 20;
}

/** Shape check at the wire boundary; anything else is reported per id, not thrown. */
function opError(op: unknown): string | null {
  if (!op || typeof op !== "object") return "op is not an object";
  const o = op as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return "id must be a non-empty string";
  switch (o.k) {
    case "del":
    case "vec-del":
      return null;
    case "vec":
      return typeof o.rev === "string" && typeof o.f32b64 === "string" ? null : "vec needs rev and f32b64";
    case "doc":
      if (typeof o.sessionId !== "string" || !isSearchResultLayer(o.layer) || typeof o.rev !== "string") return "doc needs sessionId, layer and rev";
      if (typeof o.ts !== "number" || !o.fields || typeof o.fields !== "object") return "doc needs ts and fields";
      return null;
    default:
      return `unknown op kind ${String(o.k)}`;
  }
}

export class SearchEngine {
  private ensured: Promise<void> | null = null;
  private vocabulary: Promise<Map<string, number>> | null = null;
  private lastVocabularySize = 0;
  /** The mean document length new BM25 weights are computed with; null until read from the collection. */
  private avgdl: number | null = null;
  private corpusChanged = false;
  private reweighting: Promise<void> | null = null;
  /** Bumped when clear("all") drops the collection; a reweighting pass from before it stops. */
  private collectionEpoch = 0;
  private readonly clock: VersionClock;
  /** Prefix expansion for the docs collection's keyword search; the lessons collection expands exactly. */
  readonly prefixes: PrefixVocabulary | null;

  constructor(private readonly qdrant: Qdrant, private readonly fallbackAvgdl: number, vocabulary: VocabularyLimits = DEFAULT_VOCABULARY_LIMITS) {
    this.clock = new VersionClock(qdrant, () => this.ready());
    this.prefixes = qdrant.config.layout === "lessons" ? null : new PrefixVocabulary(qdrant, () => this.ready(), vocabulary);
  }

  maxVersion(): Promise<OpVersion> {
    return this.clock.maxVersion();
  }

  /** Resolves once no reweighting pass or prefix vocabulary read is running. */
  async settled(): Promise<void> {
    while (this.reweighting) await this.reweighting;
    await this.prefixes?.settled();
  }

  /** Every call waits for the collection and its payload indexes; a facet before the index exists fails. */
  private ready(): Promise<void> {
    return (this.ensured ??= this.qdrant.ensure().catch((error) => {
      this.ensured = null;
      throw error;
    }));
  }

  /**
   * Applies ops in order in one Qdrant batch, every op conditional on the
   * point at the moment Qdrant applies it (see notNewerThan). A vector is
   * stored only while the point's rev equals the rev the vector was embedded
   * from, so an embedding that finishes after its record changed or was
   * deleted is dropped (reported in `fenced`).
   */
  async apply(rawOps: unknown[], rawVersion?: unknown): Promise<ApplyResult> {
    this.vocabulary = null;
    const version = await this.clock.versionFor(rawVersion);
    const failed: ApplyResult["failed"] = [];
    const ops: Op[] = [];
    const terms = new Map<DocOp, string[]>();
    for (const op of rawOps) {
      const error = opError(op);
      if (error) {
        failed.push({ id: String((op as { id?: unknown })?.id ?? ""), error });
        continue;
      }
      const validOp = op as Op;
      if (validOp.k === "doc") {
        try {
          terms.set(validOp, extractTerms(validOp.fields));
        } catch (cause) {
          failed.push({ id: validOp.id, error: `invalid doc fields: ${cause instanceof Error ? cause.message : String(cause)}` });
          continue;
        }
      }
      ops.push(validOp);
    }

    const writtenFirst = new Set<string>();
    const lookup = new Set<string>();
    for (const op of ops) {
      if (op.k === "doc" || op.k === "del") writtenFirst.add(op.id);
      else if (op.k === "vec" && !writtenFirst.has(op.id)) lookup.add(op.id);
    }
    const corpusIds = this.prefixes ? [...writtenFirst] : [];
    const epoch = this.collectionEpoch;
    for (const id of corpusIds) lookup.add(id);
    await this.ready();
    const stored = await this.storedPayloads([...lookup]);
    const rev = new Map<string, ContentRev | null>();
    const revOf = (id: string) => (rev.has(id) ? rev.get(id)! : stored.get(id)?.rev ?? null);
    const avgdl = terms.size > 0 ? await this.writeAvgdl([...terms.values()]) : this.fallbackAvgdl;

    // Ops are grouped by kind into a few Qdrant operations; Qdrant charges per
    // operation, not per point. Every id's document change still precedes its
    // vector change, and every group is conditional per point.
    const claimedNow = { key: "v", match: { value: version } };
    if (terms.size > 0) this.prefixes?.noteIndexedAverageLength(avgdl);
    const docPoints: unknown[] = [];
    const docPayloads: unknown[] = [];
    const docWeights: unknown[] = [];
    const tombstones: unknown[] = [];
    const vecClaims: unknown[] = [];
    const vecPoints: Array<{ id: string; vector: { dense: number[] } }> = [];
    const vecDeletes: string[] = [];
    const fenced: string[] = [];
    const written: Array<{ id: string; rev: ContentRev }> = [];
    let applied = 0;
    let lexicalPosition = 0;
    for (const op of ops) {
      const id = pointId(op.id);
      switch (op.k) {
        case "doc": {
          const docTerms = terms.get(op)!;
          const bm25 = termsSparse(docTerms, avgdl);
          const payload = {
            doc_id: op.id, session_id: op.sessionId, layer: op.layer, ts: op.ts, rev: op.rev, v: version, dl: docTerms.length, ad: avgdl, terms: docTerms,
            lexical_order: [version, lexicalPosition++],
          };
          docPoints.push({ id, vector: { bm25 }, payload: { ...payload, dense: false } });
          docPayloads.push({ set_payload: { payload, filter: { must: [{ has_id: [id] }, notNewerThan(version)], must_not: [TOMBSTONE] } } });
          docWeights.push({ id, vector: { bm25 } });
          rev.set(op.id, op.rev);
          break;
        }
        case "del":
          tombstones.push({ id, vector: {}, payload: { doc_id: op.id, deleted: true, dense: false, v: version } });
          rev.set(op.id, null);
          break;
        case "vec": {
          const dense = Array.from(base64ToFloat32(op.f32b64));
          if (dense.length !== this.qdrant.config.dimensions) {
            failed.push({ id: op.id, error: `vector length ${dense.length} does not match dimensions ${this.qdrant.config.dimensions}` });
            continue;
          }
          if (revOf(op.id) !== op.rev) {
            fenced.push(op.id);
            continue;
          }
          // The claim takes the point only while it still holds this rev and nothing newer reached it.
          vecClaims.push({ set_payload: { payload: { v: version }, filter: { must: [{ has_id: [id] }, { key: "rev", match: { value: op.rev } }, notNewerThan(version)], must_not: [TOMBSTONE] } } });
          vecPoints.push({ id, vector: { dense } });
          written.push({ id: op.id, rev: op.rev });
          break;
        }
        case "vec-del":
          vecDeletes.push(op.id);
          break;
      }
      applied++;
    }

    const operations: unknown[] = [];
    if (docPoints.length > 0) {
      operations.push(
        // Inserts new points and replaces older tombstones; a live point keeps its dense vector.
        { upsert: { points: docPoints, update_filter: { must: [TOMBSTONE, notNewerThan(version)] } } },
        ...docPayloads,
        { update_vectors: { points: docWeights, update_filter: { must: [claimedNow], must_not: [TOMBSTONE] } } },
      );
    }
    if (tombstones.length > 0) operations.push({ upsert: { points: tombstones, update_filter: notNewerThan(version) } });
    if (vecPoints.length > 0) {
      operations.push(
        ...vecClaims,
        { update_vectors: { points: vecPoints, update_filter: { must: [claimedNow], must_not: [TOMBSTONE] } } },
        { set_payload: { payload: { dense: true }, filter: { must: [{ has_id: vecPoints.map((p) => p.id) }, claimedNow], must_not: [TOMBSTONE] } } },
      );
    }
    if (vecDeletes.length > 0) {
      const ids = vecDeletes.map(pointId);
      const claimed = { must: [{ has_id: ids }, claimedNow], must_not: [TOMBSTONE] };
      operations.push(
        { set_payload: { payload: { v: version }, filter: { must: [{ has_id: ids }, notNewerThan(version)], must_not: [TOMBSTONE] } } },
        { delete_vectors: { filter: claimed, vector: ["dense"] } },
        { set_payload: { payload: { dense: false }, filter: claimed } },
      );
    }
    if (operations.length > 0) {
      try {
        await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, { operations });
      } finally {
        this.vocabulary = null;
      }
    }
    if (terms.size > 0 || ops.some((op) => op.k === "del")) this.corpusDidChange();
    // A vector change applied only if its claim held: the point is live and carries this version.
    // A vector delete on a tombstone or an absent point leaves no vector either way.
    if (written.length > 0 || vecDeletes.length > 0 || corpusIds.length > 0) {
      const now = await this.storedPayloads([...new Set([...written.map((w) => w.id), ...vecDeletes, ...corpusIds])]);
      for (const id of corpusIds) {
        const current = now.get(id);
        if (epoch !== this.collectionEpoch || !this.prefixes?.counting || current?.v !== version) continue;
        const previous = stored.get(id);
        this.prefixes.replace(previous?.deleted ? undefined : previous?.document, current.deleted ? undefined : current.document);
      }
      const lost = [
        ...written.filter((w) => { const p = now.get(w.id); return !(p && !p.deleted && p.rev === w.rev && p.v === version); }).map((w) => w.id),
        ...vecDeletes.filter((id) => { const p = now.get(id); return p !== undefined && !p.deleted && p.v !== version; }),
      ];
      fenced.push(...lost);
      applied -= lost.length;
    }
    return { applied, fenced, failed };
  }

  /** Live documents among ids, read from their payload. */
  async lookup(rawIds: unknown): Promise<LookupResult["items"]> {
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, MAX_LIMIT) : [];
    if (ids.length === 0) return [];
    await this.ready();
    const points = await this.qdrant.call<RecordPoint[]>("POST", `${this.qdrant.path}/points`, {
      ids: ids.map(pointId),
      with_payload: ["doc_id", "session_id", "layer", "rev", "deleted"],
      with_vector: false,
    });
    return points.flatMap(({ payload: p }) =>
      p?.doc_id && !p.deleted && isSearchResultLayer(p.layer) && typeof p.rev === "string"
        ? [{ id: p.doc_id, sessionId: p.session_id ?? "", layer: p.layer, rev: p.rev as ContentRev }]
        : [],
    );
  }

  private async storedPayloads(docIds: string[]): Promise<Map<string, StoredPayload>> {
    const payloads = new Map<string, StoredPayload>();
    if (docIds.length === 0) return payloads;
    const points = await this.qdrant.call<RecordPoint[]>("POST", `${this.qdrant.path}/points`, {
      ids: docIds.map(pointId),
      with_payload: ["doc_id", "rev", "v", "deleted", "terms", "dl"],
      with_vector: false,
    });
    for (const { payload: p } of points) {
      if (p?.doc_id) payloads.set(p.doc_id, {
        rev: typeof p.rev === "string" ? (p.rev as ContentRev) : undefined, v: p.v, deleted: p.deleted === true,
        document: storedDocument(p),
      });
    }
    return payloads;
  }

  /**
   * BM25 needs the corpus's mean document length, as SearchIndex computes it.
   * Each point stores its term count (`dl`), so the mean is one facet over
   * `dl`. Weights are computed at write time with the current mean and stored
   * with it (`ad`); after a write the worker re-reads the mean and, once it
   * has drifted past AVGDL_DRIFT, rewrites the weights of every document
   * outside that band from its stored terms.
   */
  private async writeAvgdl(batch: string[][]): Promise<number> {
    if (this.avgdl !== null) return this.avgdl;
    // A write must not fail for want of the mean; the reweighting pass corrects these weights later.
    const corpus = await this.corpusMean().catch(() => undefined);
    const mean = corpus ?? meanLength(batch) ?? this.fallbackAvgdl;
    if (corpus !== undefined) this.avgdl ??= mean;
    return this.avgdl ?? mean;
  }

  private async corpusMean(): Promise<number | null> {
    const res = await this.qdrant.call<{ hits: Array<{ value: number; count: number }> }>("POST", `${this.qdrant.path}/facet`, {
      key: "dl",
      filter: { must_not: [TOMBSTONE] },
      limit: DL_FACET_LIMIT,
      exact: true,
    });
    let docs = 0;
    let total = 0;
    for (const { value, count } of res.hits) {
      docs += count;
      total += value * count;
    }
    return docs > 0 && total > 0 ? total / docs : null;
  }

  private corpusDidChange(): void {
    if (this.qdrant.config.layout === "lessons") return;
    this.corpusChanged = true;
    this.reweighting ??= this.reweightWhileChanging().finally(() => {
      this.reweighting = null;
      if (this.corpusChanged) this.corpusDidChange();
    });
  }

  private async reweightWhileChanging(): Promise<void> {
    const epoch = this.collectionEpoch;
    while (this.corpusChanged && epoch === this.collectionEpoch) {
      this.corpusChanged = false;
      try {
        const mean = await this.corpusMean();
        if (epoch !== this.collectionEpoch) return;
        if (mean === null) continue;
        if (this.avgdl === null || Math.abs(mean / this.avgdl - 1) > AVGDL_DRIFT) this.avgdl = mean;
        await this.reweight(this.avgdl);
      } catch (error) {
        logger.warn("am-search could not refresh BM25 weights; the next write retries", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async reweight(avgdl: number): Promise<void> {
    this.prefixes?.noteIndexedAverageLength(avgdl);
    const epoch = this.collectionEpoch;
    const filter = {
      must_not: [{ is_empty: { key: "terms" } }, { key: "ad", range: { gte: avgdl * (1 - AVGDL_DRIFT), lte: avgdl * (1 + AVGDL_DRIFT) } }],
    };
    let offset: string | undefined;
    do {
      const page = await this.qdrant.call<{ points: RecordPoint[]; next_page_offset?: string | null }>("POST", `${this.qdrant.path}/points/scroll`, {
        filter,
        limit: REWEIGHT_PAGE,
        ...(offset ? { offset } : {}),
        with_payload: ["terms", "rev"],
        with_vector: false,
      });
      if (epoch !== this.collectionEpoch) return;
      const operations = page.points.flatMap(({ id, payload }) => {
        const stored = storedDocument(payload);
        const rev = payload?.rev;
        if (!stored || typeof rev !== "string") return [];
        // Keyed on rev, not v: the stored terms are the content of that rev, whichever op wrote it.
        const same = [{ key: "rev", match: { value: rev } }];
        return [
          { update_vectors: { points: [{ id, vector: { bm25: termsSparse(stored.terms, avgdl) } }], update_filter: { must: same, must_not: [TOMBSTONE] } } },
          { set_payload: { payload: { ad: avgdl }, filter: { must: [{ has_id: [id] }, ...same], must_not: [TOMBSTONE] } } },
        ];
      });
      if (operations.length > 0) await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, { operations });
      offset = page.next_page_offset ?? undefined;
    } while (offset && epoch === this.collectionEpoch);
  }

  async keyword(query: unknown, limit: unknown, layer: unknown): Promise<Hit[]> {
    if (typeof query !== "string") return [];
    if (this.qdrant.config.layout === "lessons") {
      return this.lessonKeyword(query, clampLimit(limit), isSearchLayer(layer) ? layer : "all");
    }
    const prefixes = this.prefixes;
    prefixes?.fillInBackground();
    const rescore = (prefixes?.isReady ?? false) && prefixes!.documentCount > 0;
    const sparse = querySparse(query, prefixes ? (terms) => prefixes.expand(terms, rescore) : undefined);
    if (sparse.indices.length === 0) return [];
    await this.ready();
    if (this.avgdl === null) this.corpusDidChange();
    const count = clampLimit(limit);
    const filter = layerFilter(isSearchLayer(layer) ? layer : "all");
    const terms = queryTerms(query);
    const factor = rescore ? prefixes!.scoreUpperBound(terms, sparse) : Infinity;
    const depth = Math.min(MAX_LIMIT, Math.max(count * KEYWORD_CANDIDATE_MULTIPLIER, count + KEYWORD_CANDIDATE_MARGIN));
    const shallow = Number.isFinite(factor) ? Math.min(depth, count + 16) : depth;
    const res = await this.qdrant.call<{ points: ScoredPoint[] }>("POST", this.qdrant.path + "/points/query", {
      query: sparse, using: "bm25", limit: rescore ? shallow : count, filter,
      with_payload: rescore ? [...HIT_PAYLOAD, "terms", "dl", "lexical_order"] : HIT_PAYLOAD,
    });
    if (!rescore || !prefixes?.isReady) return toHits(res.points);
    const documents: Array<LexicalDocument & { order: [number, number] }> = [];
    const candidateTerms = new Map<string, number>();
    const add = (points: RecordPoint[]) => {
      for (const { payload } of points) {
        const stored = storedDocument(payload);
        if (!payload?.doc_id || payload.deleted || !stored) continue;
        documents.push({ id: payload.doc_id, sessionId: payload.session_id ?? "", ...stored, order: payload.lexical_order ?? [0, 0] });
        for (const term of stored.terms) candidateTerms.set(term, 1);
      }
    };
    const score = () => {
      documents.sort((a, b) => (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]) || (a.id < b.id ? -1 : Number(a.id > b.id)));
      return lexicalBm25(documents, expandLexicalTerms(terms, new Map(candidateTerms)), prefixes.frequencies, prefixes.documentCount, prefixes.averageLength, count);
    };
    add(res.points);
    let hits = score();
    if (shallow < depth && res.points.length === shallow && (hits.length < count || res.points.at(-1)!.score * factor >= hits[count - 1]!.score)) {
      const deep = await this.qdrant.call<{ points: ScoredPoint[] }>("POST", this.qdrant.path + "/points/query", {
        query: sparse, using: "bm25", limit: depth, filter,
        ...(hits.length >= count ? { score_threshold: hits[count - 1]!.score / factor } : {}),
        with_payload: [...HIT_PAYLOAD, "terms", "dl", "lexical_order"],
      });
      const seen = new Set(res.points.map(({ id }) => id));
      add(deep.points.filter(({ id }) => !seen.has(id)));
      hits = score();
    }
    return hits;
  }

  private lessonVocabulary(): Promise<Map<string, number>> {
    if (this.vocabulary) return this.vocabulary;
    const pending = this.readVocabulary().catch((error) => {
      if (this.vocabulary === pending) this.vocabulary = null;
      throw error;
    });
    this.vocabulary = pending;
    return pending;
  }

  private async readVocabulary(): Promise<Map<string, number>> {
    let limit = Math.max(1024, 2 * this.lastVocabularySize);
    for (;;) {
      const { hits } = await this.qdrant.call<{ hits: Array<{ value: string; count: number }> }>("POST", `${this.qdrant.path}/facet`, {
        key: "terms",
        filter: { must_not: [TOMBSTONE] },
        exact: true,
        limit,
      });
      if (hits.length < limit) {
        this.lastVocabularySize = hits.length;
        return new Map(hits.map(({ value, count }) => [value, count]));
      }
      limit *= 2;
    }
  }

  private async lessonKeyword(query: string, limit: number, layer: SearchLayer): Promise<Hit[]> {
    const weightedTerms = queryTerms(query);
    if (weightedTerms.length === 0) return [];
    await this.ready();
    const [frequencies, count, averageLength] = await Promise.all([
      this.lessonVocabulary(),
      this.qdrant.count({ must_not: [TOMBSTONE] }),
      this.corpusMean(),
    ]);
    if (count === 0 || averageLength === null) return [];
    const expanded = expandLexicalTerms(weightedTerms, frequencies);
    const terms = new Set(expanded.flatMap(({ term, prefixes }) => [term, ...prefixes]));
    const filter = {
      must: [
        ...(terms.size <= LESSON_TERMS_FILTER_LIMIT ? [{ key: "terms", match: { any: [...terms] } }] : []),
        ...(layer === "all" ? [] : [{ key: "layer", match: { value: layer } }]),
      ],
      must_not: [TOMBSTONE],
    };
    // ponytail: above the 1024-term filter ceiling, scroll every live lesson; retained candidates still grow with matching lessons. Upgrade to disk-backed postings and exact top-K scoring for larger corpora.
    const documents: Array<LexicalDocument & { order: [number, number] }> = [];
    let offset: string | undefined;
    do {
      const page = await this.qdrant.call<{ points: RecordPoint[]; next_page_offset?: string | null }>("POST", `${this.qdrant.path}/points/scroll`, {
        filter,
        limit: REWEIGHT_PAGE,
        ...(offset ? { offset } : {}),
        with_payload: ["doc_id", "session_id", "terms", "dl", "lexical_order"],
        with_vector: false,
      });
      for (const { payload } of page.points) {
        const stored = storedDocument(payload);
        if (!payload?.doc_id || !stored) continue;
        const matchedTerms = stored.terms.filter((term) => terms.has(term));
        if (matchedTerms.length === 0) continue;
        documents.push({ id: payload.doc_id, sessionId: payload.session_id ?? "", terms: matchedTerms, dl: stored.dl, order: payload.lexical_order ?? [0, 0] });
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset);
    documents.sort((a, b) => (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]) || (a.id < b.id ? -1 : Number(a.id > b.id)));
    return lexicalBm25(documents, expanded, frequencies, count, averageLength, limit);
  }

  async vector(f32b64: unknown, limit: unknown, layer: unknown, oversampling: number): Promise<Hit[]> {
    if (typeof f32b64 !== "string") return [];
    await this.ready();
    const res = await this.qdrant.call<{ points: ScoredPoint[] }>("POST", `${this.qdrant.path}/points/query`, {
      query: Array.from(base64ToFloat32(f32b64)),
      using: "dense",
      limit: clampLimit(limit),
      filter: layerFilter(isSearchLayer(layer) ? layer : "all"),
      params: { quantization: { rescore: true, oversampling } },
      with_payload: HIT_PAYLOAD,
    });
    return toHits(res.points);
  }

  async stats(): Promise<StatsResult> {
    await this.ready();
    const rankingReady = this.prefixes?.isReady ?? true;
    this.prefixes?.fillInBackground();
    const byLayer = (value: SearchResultLayer) => ({ must: [{ key: "layer", match: { value } }] });
    const [docs, vectors, memories, lessons, missingVectors] = await Promise.all([
      this.qdrant.count(LIVE_DOCS),
      this.qdrant.count({ must: [{ key: "dense", match: { value: true } }], must_not: [TOMBSTONE] }),
      this.qdrant.count(byLayer("memory")),
      this.qdrant.count(byLayer("lesson")),
      this.qdrant.count(MISSING_VECTOR_FILTER),
    ]);
    return { docs, vectors, memories, lessons, missingVectors, rankingReady };
  }

  async sessionCounts(): Promise<Array<[string, number]>> {
    await this.ready();
    const res = await this.qdrant.call<{ hits: Array<{ value: string; count: number }> }>("POST", `${this.qdrant.path}/facet`, {
      key: "session_id",
      filter: { must: [{ key: "layer", match: { value: "observation" } }] },
      limit: 1_000_000,
      exact: true,
    });
    return res.hits.map((h) => [h.value, h.count]);
  }

  async scanMissingVectors(cursor: unknown, limit: unknown): Promise<ScanMissingResult> {
    return this.scrollStubs(MISSING_VECTOR_FILTER, cursor, limit);
  }

  /** One page of live docs: a session's observations, or every memory when sessionId is not a string. */
  async scanDocs(sessionId: unknown, cursor: unknown, limit: unknown): Promise<ScanDocsResult> {
    const must = typeof sessionId === "string"
      ? [{ key: "layer", match: { value: "observation" } }, { key: "session_id", match: { value: sessionId } }]
      : [{ key: "layer", match: { value: "memory" } }];
    return this.scrollStubs({ must, must_not: [TOMBSTONE] }, cursor, limit);
  }

  private async scrollStubs(filter: unknown, cursor: unknown, limit: unknown): Promise<ScanDocsResult> {
    await this.ready();
    const res = await this.qdrant.call<{ points: RecordPoint[]; next_page_offset?: string | null }>("POST", `${this.qdrant.path}/points/scroll`, {
      filter,
      limit: clampLimit(limit),
      ...(typeof cursor === "string" ? { offset: cursor } : {}),
      with_payload: ["doc_id", "session_id", "layer", "rev"],
      with_vector: false,
    });
    const items = res.points.flatMap((p) => {
      const { doc_id, session_id, layer, rev } = p.payload ?? {};
      return doc_id && isSearchResultLayer(layer) && typeof rev === "string"
        ? [{ id: doc_id, sessionId: session_id ?? "", layer, rev: rev as ContentRev }]
        : [];
    });
    return { items, ...(res.next_page_offset ? { next: res.next_page_offset } : {}) };
  }

  async clear(scope: unknown): Promise<void> {
    if (scope !== "all" && scope !== "vectors") throw new Error("clear scope must be all or vectors");
    this.vocabulary = null;
    if (scope === "all") {
      await this.ready();
      await this.qdrant.drop();
      this.vocabulary = null;
      this.prefixes?.clear();
      this.lastVocabularySize = 0;
      this.collectionEpoch++;
      this.corpusChanged = false;
      this.ensured = null;
      this.avgdl = null;
      await this.ready();
      return;
    }
    await this.ready();
    const filter = { must: [{ key: "dense", match: { value: true } }] };
    await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, {
      operations: [
        { delete_vectors: { filter, vector: ["dense"] } },
        { set_payload: { payload: { dense: false }, filter } },
      ],
    });
  }

  async health(): Promise<HealthResult> {
    const { collection } = this.qdrant.config;
    try {
      await this.ready();
      const info = await this.qdrant.call<{ status: string; config: { params: { vectors: { dense?: { size: number } } } } }>("GET", this.qdrant.path);
      const dimensions = info.config.params.vectors.dense?.size ?? 0;
      return { ok: info.status !== "red", collection, dimensions, status: info.status };
    } catch (error) {
      return { ok: false, collection, dimensions: 0, status: "unreachable", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

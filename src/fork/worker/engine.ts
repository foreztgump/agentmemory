import { base64ToFloat32, float32ToBase64 } from "../../state/vector-index.js";
import { isSearchLayer, isSearchResultLayer, type SearchLayer, type SearchResultLayer } from "../../state/search-layer.js";
import { extractTerms, queryTerms, type WeightedTerm } from "../../state/term-extraction.js";
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
  type ReadVectorsResult,
  type ScanDocsResult,
  type ScanEntriesResult,
  type ScanMissingResult,
  type StatsResult,
} from "../search/protocol.js";
import { querySparse, termId, termsSparse, type Sparse } from "./bm25-sparse.js";
import { documentBm25, expandLexicalTerms, lexicalBm25, storedDocument, TERM_WEIGHT_CAP, type LexicalDocument } from "./lexical-bm25.js";
import { DEFAULT_VOCABULARY_LIMITS, PrefixVocabulary, type VocabularyLimits } from "./prefix-vocabulary.js";
import { pointId, type Qdrant } from "./qdrant.js";
import { notNewerThan, TOMBSTONE, VersionClock } from "./versioned.js";

interface ScoredPoint { id: string; score: number; payload?: RecordPoint["payload"]; vector?: { bm25?: Sparse } }
interface RecordPoint {
  id: string;
  payload?: { doc_id?: string; session_id?: string; layer?: string; rev?: string; deleted?: boolean; terms?: unknown; dl?: number; lexical_order?: [number, number]; v?: unknown };
}
interface DenseRecordPoint extends RecordPoint { vector?: { dense?: number[] } | null }
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
// The deep read stops at max(4 x limit, limit + 500) ids. Qdrant sums a term's prefix matches where SearchIndex takes the best one,
// so on a short prefix query ("bes" at 200k synthetic docs) the exact top docs can sit near Qdrant position 2,000; a deep read that
// comes back full hands the rest to single-term lists (readPastDepth).
const KEYWORD_CANDIDATE_MULTIPLIER = 4;
const KEYWORD_CANDIDATE_MARGIN = 500;
/** Candidates read past the limit before the score bound decides whether a deeper read is needed. */
const KEYWORD_SHALLOW_SLACK = 16;
/** Deep candidates whose payload the first request fetches; small, so a rising k-th score stops the read early. Each next request doubles it. */
const KEYWORD_PAYLOAD_CHUNK = 16;
/** Single-term lists past the deep read's depth start at this many times the shallow read and deepen by it each round. */
const KEYWORD_LIST_GROWTH = 4;
/** Single-term lists one request carries, at least; a round spreads its lists over up to KEYWORD_LIST_REQUESTS concurrent requests. */
const KEYWORD_LISTS_PER_REQUEST = 32;
const KEYWORD_LIST_REQUESTS = 8;
/** Sparse query size past which the deep read also takes each candidate's vector: a per-document bound costs less than the payloads a loose global bound would fetch. */
const KEYWORD_VECTOR_BOUND_TERMS = 1024;

const LIVE_DOCS = { must: [{ key: "layer", match: { any: LAYERS } }] };

/**
 * The payload of a live document point; apply and load both write it.
 * `lexical_order` is its write order, which exact lexical ranking breaks ties by.
 */
function docPayload(op: DocOp, terms: string[], avgdl: number, version: OpVersion, lexicalOrder: [OpVersion, number]) {
  return {
    doc_id: op.id, session_id: op.sessionId, layer: op.layer, ts: op.ts, rev: op.rev, v: version, dl: terms.length, ad: avgdl, terms,
    lexical_order: lexicalOrder,
  };
}

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

function weightAt(vector: Sparse | undefined, id: number): number {
  const i = vector ? vector.indices.indexOf(id) : -1;
  return i >= 0 ? vector!.values[i]! : NaN;
}

/**
 * One term's single-term list past the deep read: the stored weights it listed, capped at TERM_WEIGHT_CAP, and the weight
 * no unlisted point exceeds. That floor is the cap until a request reads the list, then its last listed weight, 0 once exhausted.
 */
interface TermList {
  id: number;
  limit: number;
  uses: Array<{ query: number; coefficient: number }>;
  weights: Array<[string, number]>;
  floor: number;
}

/** The documents one disk keyword search has read: each scored once as it arrives, ranked exactly at the end. */
class KeywordCandidates {
  /** Point ids whose payload was read, whether or not it held a document. */
  readonly read = new Set<string>();
  private readonly documents: Array<LexicalDocument & { order: [number, number] }> = [];
  private readonly terms = new Set<string>();
  private best: number[] = [];

  constructor(private readonly query: readonly WeightedTerm[], private readonly vocabulary: PrefixVocabulary, readonly limit: number) {}

  add(points: readonly RecordPoint[]): void {
    const { frequencies, documentCount, averageLength } = this.vocabulary;
    for (const { id, payload } of points) {
      this.read.add(id);
      const stored = storedDocument(payload);
      if (!payload?.doc_id || !stored) continue;
      const document = { id: payload.doc_id, sessionId: payload.session_id ?? "", ...stored, order: payload.lexical_order ?? [0, 0] };
      this.documents.push(document);
      for (const term of stored.terms) this.terms.add(term);
      const score = documentBm25(document, this.query, frequencies, documentCount, averageLength);
      if (score !== undefined) this.best.push(score);
    }
    this.best = this.best.sort((a, b) => b - a).slice(0, this.limit);
  }

  /** The k-th score read so far, 0 while fewer than k documents match; never above the k-th score of ranked(). */
  get threshold(): number {
    return this.best.length >= this.limit ? this.best[this.limit - 1]! : 0;
  }

  ranked(): Hit[] {
    this.documents.sort((a, b) => (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]) || (a.id < b.id ? -1 : Number(a.id > b.id)));
    const matching = new Map([...this.terms].filter((term) => this.query.some((q) => term.startsWith(q.term))).map((term) => [term, 1]));
    const { frequencies, documentCount, averageLength } = this.vocabulary;
    return lexicalBm25(this.documents, expandLexicalTerms(this.query, matching), frequencies, documentCount, averageLength, this.limit);
  }
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
  /** The second part of a point's `lexical_order`; it keeps growing across calls, so writes at one version (a migration's) stay in write order. */
  private lexicalPosition = 0;
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
    const touched: string[] = [];
    try {
      return await this.applyOps(rawOps, rawVersion, touched);
    } catch (error) {
      this.prefixes?.abandon(touched);
      throw error;
    }
  }

  /** apply's work; `touched` receives the points it registered with a running vocabulary fill before it sends anything. */
  private async applyOps(rawOps: unknown[], rawVersion: unknown, touched: string[]): Promise<ApplyResult> {
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
    // Decided once: a delta needs the read before the batch and the read after it.
    const corpusIds = this.prefixes?.counting ? [...writtenFirst] : [];
    const epoch = this.collectionEpoch;
    for (const id of corpusIds) lookup.add(id);
    touched.push(...corpusIds.map(pointId));
    this.prefixes?.touch(touched);
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
    for (const op of ops) {
      const id = pointId(op.id);
      switch (op.k) {
        case "doc": {
          const docTerms = terms.get(op)!;
          const bm25 = termsSparse(docTerms, avgdl);
          const payload = docPayload(op, docTerms, avgdl, version, [version, this.lexicalPosition++]);
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
      const live = (p: StoredPayload | undefined) => (p && !p.deleted ? p.document : undefined);
      for (const id of corpusIds) {
        if (epoch !== this.collectionEpoch || !this.prefixes) continue;
        const current = now.get(id);
        this.prefixes.changed(pointId(id), live(stored.get(id)), live(current), current?.v === version);
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

  /**
   * Bulk load for the disk migration: each document and its stored vector as
   * one point, in one conditional upsert. Writing the document and the vector
   * together is what the rev fence otherwise guarantees: the vector belongs to
   * this content. A point with a newer version than `version` (a live write or
   * delete) is left as it is and reported in `fenced`. apply() spends one
   * filtered payload write per document, about 20 documents a second at 1024
   * dims; this is one operation per batch.
   *
   * `avgdl` is the mean term count of everything the caller will load. Every
   * document is weighted with it and no reweighting pass starts, so a bulk
   * load never rewrites the weights it just wrote (a full pass rewrites every
   * point, one payload write each).
   */
  async load(items: Array<{ doc: DocOp; f32b64?: string }>, version: OpVersion, avgdl?: number): Promise<ApplyResult> {
    const failed: ApplyResult["failed"] = [];
    const valid: Array<{ doc: DocOp; terms: string[]; dense?: number[] }> = [];
    for (const { doc, f32b64 } of items) {
      const error = opError(doc) ?? (doc.k === "doc" ? null : "load takes doc ops");
      if (error) {
        failed.push({ id: String(doc?.id ?? ""), error });
        continue;
      }
      let terms: string[];
      try {
        terms = extractTerms(doc.fields);
      } catch (cause) {
        failed.push({ id: doc.id, error: `invalid doc fields: ${cause instanceof Error ? cause.message : String(cause)}` });
        continue;
      }
      const dense = f32b64 === undefined ? undefined : Array.from(base64ToFloat32(f32b64));
      if (dense && dense.length !== this.qdrant.config.dimensions) {
        failed.push({ id: doc.id, error: `vector length ${dense.length} does not match dimensions ${this.qdrant.config.dimensions}` });
        continue;
      }
      valid.push({ doc, terms, dense });
    }
    if (valid.length === 0) return { applied: 0, fenced: [], failed };
    await this.ready();
    const preset = typeof avgdl === "number" && Number.isFinite(avgdl) && avgdl > 0 ? avgdl : null;
    if (preset !== null) this.avgdl = preset;
    const weightBy = preset ?? (await this.writeAvgdl(valid.map((v) => v.terms)));
    const points = valid.map(({ doc, terms, dense }) => ({
      id: pointId(doc.id),
      vector: { bm25: termsSparse(terms, weightBy), ...(dense ? { dense } : {}) },
      payload: { ...docPayload(doc, terms, weightBy, version, [version, this.lexicalPosition++]), dense: dense !== undefined },
    }));
    try {
      await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, {
        operations: [{ upsert: { points, update_filter: notNewerThan(version) } }],
      });
    } finally {
      this.vocabulary = null;
      // load does not count its documents into the prefix vocabulary, so the next search refills it.
      this.prefixes?.clear();
    }
    if (preset === null) this.corpusDidChange();
    const now = await this.storedPayloads(valid.map((v) => v.doc.id));
    const fenced = valid.filter((v) => now.get(v.doc.id)?.v !== version).map((v) => v.doc.id);
    return { applied: valid.length - fenced.length, fenced, failed };
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

  /** Dense vectors of live documents among ids, read from their points. */
  async readVectors(rawIds: unknown): Promise<ReadVectorsResult["vectors"]> {
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    if (ids.length > MAX_LIMIT) throw new Error(`search::read-vectors reads at most ${MAX_LIMIT} ids per call, got ${ids.length}`);
    if (ids.length === 0) return [];
    await this.ready();
    const points = await this.qdrant.call<DenseRecordPoint[]>("POST", `${this.qdrant.path}/points`, {
      ids: ids.map(pointId),
      with_payload: ["doc_id", "deleted"],
      with_vector: ["dense"],
    });
    return points.flatMap(({ payload: p, vector }) =>
      p?.doc_id && !p.deleted && Array.isArray(vector?.dense) ? [{ id: p.doc_id, f32b64: float32ToBase64(Float32Array.from(vector.dense)) }] : [],
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
    const shallow = Number.isFinite(factor) ? Math.min(depth, count + KEYWORD_SHALLOW_SLACK) : depth;
    const res = await this.qdrant.call<{ points: ScoredPoint[] }>("POST", this.qdrant.path + "/points/query", {
      query: sparse, using: "bm25", limit: rescore ? shallow : count, filter,
      with_payload: rescore ? [...HIT_PAYLOAD, "terms", "dl", "lexical_order"] : HIT_PAYLOAD,
    });
    if (!rescore || !prefixes?.isReady) return toHits(res.points);
    const candidates = new KeywordCandidates(terms, prefixes, count);
    candidates.add(res.points);
    if (shallow < depth && res.points.length === shallow && res.points.at(-1)!.score * factor >= candidates.threshold) {
      const useVectorBound = sparse.indices.length > KEYWORD_VECTOR_BOUND_TERMS;
      const deep = await this.qdrant.call<{ points: ScoredPoint[] }>("POST", this.qdrant.path + "/points/query", {
        query: sparse, using: "bm25", limit: depth, filter,
        ...(candidates.threshold > 0 ? { score_threshold: candidates.threshold / factor } : {}),
        with_payload: false,
        with_vector: useVectorBound ? ["bm25"] : false,
      });
      const bound = useVectorBound ? prefixes.documentScoreUpperBound(terms) : undefined;
      await this.readPayloads(candidates, deep.points.filter(({ id }) => !candidates.read.has(id))
        .map((point) => ({ id: point.id, bound: Math.min(point.score * factor, point.vector?.bm25 && bound ? bound(point.vector.bm25) : Infinity) }))
        .sort((a, b) => b.bound - a.bound));
      if (deep.points.length === depth && deep.points.at(-1)!.score * factor >= candidates.threshold) {
        await this.readPastDepth(candidates, terms, filter, new Set(deep.points.map(({ id }) => id)));
      }
    }
    return candidates.ranked();
  }

  /** Reads payloads in bound order while a bound reaches the k-th score, in chunks that double so a long read takes few round trips. */
  private async readPayloads(candidates: KeywordCandidates, queue: ReadonlyArray<{ id: string; bound: number }>): Promise<void> {
    for (let offset = 0, size = KEYWORD_PAYLOAD_CHUNK; offset < queue.length; size *= 2) {
      const threshold = candidates.threshold;
      const chunk: string[] = [];
      while (offset < queue.length && chunk.length < size && queue[offset]!.bound >= threshold) chunk.push(queue[offset++]!.id);
      if (chunk.length === 0) return;
      candidates.add(await this.qdrant.call<RecordPoint[]>("POST", this.qdrant.path + "/points", {
        ids: chunk, with_payload: [...HIT_PAYLOAD, "terms", "dl", "lexical_order"], with_vector: false,
      }));
    }
  }

  /**
   * A deep read that came back full bounds no document past its depth, so one single-term list per term of the complete
   * expansion bounds them instead (the threshold algorithm). Within a list Qdrant orders by the stored weight, and its
   * idf, read from a point's vector in the same batch, turns each score back into that weight. A list that returns fewer
   * points than asked is exhausted. A list is live while its floor, with every other query term at its best listed
   * weight, could still reach the k-th score: a document that reaches it does so through a listed weight or a live
   * floor for every query term. A list not read yet has its cap, TERM_WEIGHT_CAP, as floor and best weight, so a list
   * whose cap cannot reach the k-th score is never read. Live lists deepen until no unread document can reach it.
   */
  // ponytail: a two-letter prefix expands to about 1,700 terms, and at 200k docs the one round over their lists and probes costs
  // about 60 ms (5 of 300 prefix queries take this path). Caps prune none of those lists, since one rare completion's cap passes the
  // k-th score; going under that needs an index that lists a prefix's documents by their best completion, not one list per term.
  private async readPastDepth(candidates: KeywordCandidates, terms: readonly WeightedTerm[], filter: unknown, deepRead: ReadonlySet<string>): Promise<void> {
    const prefixes = this.prefixes;
    const bounds = prefixes?.expansionBounds(terms);
    if (!bounds) return;
    const { drift } = bounds;
    const threshold = candidates.threshold;
    const first = KEYWORD_LIST_GROWTH * (candidates.limit + KEYWORD_SHALLOW_SLACK);
    const lists = new Map<string, TermList>();
    bounds.terms.forEach((expansion, query) => {
      for (const { term, coefficient } of expansion) {
        if (!(coefficient > 0)) continue;
        // A list the vocabulary says outlasts the first depth starts one step deeper, which saves a round.
        const limit = (prefixes!.frequencies.get(term) ?? 0) > first ? first * KEYWORD_LIST_GROWTH : first;
        const list = lists.get(term) ?? lists.set(term, { id: termId(term), limit, uses: [], weights: [], floor: TERM_WEIGHT_CAP }).get(term)!;
        list.uses.push({ query, coefficient });
      }
    });
    const single = (id: number, limit: number, vector: boolean) => ({
      query: { indices: [id], values: [1] }, using: "bm25", limit, filter, with_payload: false, with_vector: vector ? ["bm25"] : false,
    });
    for (;;) {
      const best = bounds.terms.map(() => 0);
      for (const list of lists.values()) {
        const top = Math.max(list.weights[0]?.[1] ?? 0, list.floor);
        for (const { query, coefficient } of list.uses) best[query] = Math.max(best[query]!, coefficient * top);
      }
      const need = best.map((_, query) => threshold / drift - best.reduce((sum, value, other) => (other === query ? sum : sum + value), 0));
      const floors = bounds.terms.map(() => 0);
      const open: TermList[] = [];
      for (const list of lists.values()) {
        for (const { query, coefficient } of list.uses) {
          if (!(list.floor > 0 && coefficient * list.floor >= need[query]!)) continue;
          floors[query] = Math.max(floors[query]!, coefficient * list.floor);
          if (open.at(-1) !== list) open.push(list);
        }
      }
      if (open.length > 0 && floors.reduce((sum, floor) => sum + floor, 0) * drift >= threshold) {
        // A list and the probe its idf comes from share one request; the requests run concurrently, which Qdrant serves about twice as fast.
        const size = Math.max(KEYWORD_LISTS_PER_REQUEST, Math.ceil(open.length / KEYWORD_LIST_REQUESTS));
        await Promise.all(Array.from({ length: Math.ceil(open.length / size) }, async (_, part) => {
          const batch = open.slice(part * size, (part + 1) * size);
          const results = await this.qdrant.call<Array<{ points: ScoredPoint[] }>>("POST", this.qdrant.path + "/points/query/batch", {
            searches: batch.flatMap((list) => [single(list.id, list.limit, false), single(list.id, 1, true)]),
          });
          batch.forEach((list, i) => {
            const points = results[2 * i]!.points;
            const top = results[2 * i + 1]!.points[0];
            const idf = top ? top.score / weightAt(top.vector?.bm25, list.id) : NaN;
            // A missing or unusable idf leaves the list at its cap, so it deepens until exhausted and its points are all read.
            const weight = (score: number) => Math.min(TERM_WEIGHT_CAP, idf > 0 && Number.isFinite(idf) ? score / idf : Infinity);
            list.weights = points.map((point) => [point.id, weight(point.score)]);
            list.floor = points.length < list.limit ? 0 : weight(points.at(-1)!.score);
            list.limit *= KEYWORD_LIST_GROWTH;
          });
        }));
        continue;
      }
      const contributions = new Map<string, number[]>();
      for (const list of lists.values()) {
        for (const { query, coefficient } of list.uses) {
          for (const [id, weight] of list.weights) {
            // A contribution at or below the term's floor leaves a document's bound where the floor puts it.
            if (coefficient * weight < need[query]! || coefficient * weight <= floors[query]!) break;
            if (deepRead.has(id) || candidates.read.has(id)) continue;
            const document = contributions.get(id) ?? contributions.set(id, bounds.terms.map(() => 0)).get(id)!;
            document[query] = Math.max(document[query]!, coefficient * weight);
          }
        }
      }
      const bound = (document: readonly number[]) => document.reduce((sum, value, query) => sum + Math.max(value, floors[query]!), 0) * drift;
      const queue = [...contributions].map(([id, document]) => ({ id, bound: bound(document) })).filter((candidate) => candidate.bound >= threshold);
      await this.readPayloads(candidates, queue.sort((a, b) => b.bound - a.bound));
      return;
    }
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

  /** One page of every live doc, as id and revision. */
  async scanEntries(cursor: unknown, limit: unknown): Promise<ScanEntriesResult> {
    const page = await this.scrollStubs({ must_not: [TOMBSTONE] }, cursor, limit);
    return { ...page, items: page.items.map(({ id, rev }) => ({ id, rev })) };
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

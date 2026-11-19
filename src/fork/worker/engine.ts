import { base64ToFloat32 } from "../../state/vector-index.js";
import { isSearchLayer, isSearchResultLayer, type SearchLayer, type SearchResultLayer } from "../../state/search-layer.js";
import { extractTerms } from "../../state/term-extraction.js";
import { logger } from "../../logger.js";
import {
  nextOpVersion,
  seedOpVersion,
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
import { pointId, type Qdrant } from "./qdrant.js";

interface ScoredPoint { id: string; score: number; payload?: { doc_id?: string; session_id?: string } }
interface RecordPoint {
  id: string;
  payload?: { doc_id?: string; session_id?: string; layer?: string; rev?: string; deleted?: boolean; terms?: unknown; v?: unknown };
}

const HIT_PAYLOAD = ["doc_id", "session_id"];
const MAX_LIMIT = 1000;
const LAYERS: SearchResultLayer[] = ["memory", "observation", "lesson", "insight"];

// Stored BM25 weights are rewritten once the corpus mean drifts this far from
// the mean they were computed with; BM25 rankings barely move inside it.
const AVGDL_DRIFT = 0.1;
const REWEIGHT_PAGE = 256;
const DL_FACET_LIMIT = 100_000;

/**
 * Every point carries `v`, the version of the last invocation that changed
 * it, and a delete leaves a tombstone (`deleted: true`, no vectors). An op
 * applies only to a point whose `v` is not newer than its own, so a late
 * duplicate of an older invocation cannot overwrite a newer one or undo a
 * delete. Points written before versions existed have no `v` and count as older.
 */
const notNewerThan = (version: OpVersion) => ({ should: [{ key: "v", range: { lte: version } }, { is_empty: { key: "v" } }] });
const TOMBSTONE = { key: "deleted", match: { value: true } };
const LIVE_DOCS = { must: [{ key: "layer", match: { any: LAYERS } }] };

function validVersion(version: unknown): OpVersion | null {
  return typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? version : null;
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

function clampLimit(limit: unknown): number {
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
  /** The mean document length new BM25 weights are computed with; null until read from the collection. */
  private avgdl: number | null = null;
  private corpusChanged = false;
  private reweighting: Promise<void> | null = null;
  /** Bumped when clear("all") drops the collection; a reweighting pass from before it stops. */
  private collectionEpoch = 0;
  private versionFloor: Promise<unknown> | null = null;

  constructor(private readonly qdrant: Qdrant, private readonly fallbackAvgdl: number) {}

  /** The highest version stored, tombstones included; this process's own stamps start above it. */
  async maxVersion(): Promise<OpVersion> {
    await this.ready();
    const res = await this.qdrant.call<{ points: Array<{ payload?: { v?: unknown } }> }>("POST", `${this.qdrant.path}/points/scroll`, {
      filter: { must: [{ key: "v", range: { gte: 1 } }] },
      order_by: { key: "v", direction: "desc" },
      limit: 1,
      with_payload: ["v"],
      with_vector: false,
    });
    const version = validVersion(res.points?.[0]?.payload?.v) ?? 0;
    seedOpVersion(version);
    return version;
  }

  /** A caller's version, or one stamped here above every version stored. */
  private async versionFor(rawVersion: unknown): Promise<OpVersion> {
    const version = validVersion(rawVersion);
    if (version !== null) {
      seedOpVersion(version);
      return version;
    }
    await (this.versionFloor ??= this.maxVersion().catch((error) => {
      this.versionFloor = null;
      throw error;
    }));
    return nextOpVersion();
  }

  /** Resolves once no reweighting pass is running. */
  async settled(): Promise<void> {
    while (this.reweighting) await this.reweighting;
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
    const version = await this.versionFor(rawVersion);
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
    await this.ready();
    const stored = await this.storedPayloads([...lookup]);
    const rev = new Map<string, ContentRev | null>();
    const revOf = (id: string) => (rev.has(id) ? rev.get(id)! : stored.get(id)?.rev ?? null);
    const avgdl = terms.size > 0 ? await this.writeAvgdl([...terms.values()]) : this.fallbackAvgdl;

    // Ops are grouped by kind into a few Qdrant operations; Qdrant charges per
    // operation, not per point. Every id's document change still precedes its
    // vector change, and every group is conditional per point.
    const claimedNow = { key: "v", match: { value: version } };
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
          const payload = { doc_id: op.id, session_id: op.sessionId, layer: op.layer, ts: op.ts, rev: op.rev, v: version, dl: docTerms.length, ad: avgdl, terms: docTerms };
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
    if (operations.length > 0) await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, { operations });
    if (terms.size > 0 || ops.some((op) => op.k === "del")) this.corpusDidChange();
    // A vector change applied only if its claim held: the point is live and carries this version.
    // A vector delete on a tombstone or an absent point leaves no vector either way.
    if (written.length > 0 || vecDeletes.length > 0) {
      const now = await this.storedPayloads([...new Set([...written.map((w) => w.id), ...vecDeletes])]);
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

  private async storedPayloads(docIds: string[]): Promise<Map<string, { rev?: ContentRev; v?: unknown; deleted?: boolean }>> {
    const payloads = new Map<string, { rev?: ContentRev; v?: unknown; deleted?: boolean }>();
    if (docIds.length === 0) return payloads;
    const points = await this.qdrant.call<RecordPoint[]>("POST", `${this.qdrant.path}/points`, {
      ids: docIds.map(pointId),
      with_payload: ["doc_id", "rev", "v", "deleted"],
      with_vector: false,
    });
    for (const { payload: p } of points) {
      if (p?.doc_id) payloads.set(p.doc_id, { rev: typeof p.rev === "string" ? (p.rev as ContentRev) : undefined, v: p.v, deleted: p.deleted === true });
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
        const { terms, rev } = payload ?? {};
        if (!Array.isArray(terms) || !terms.every((term) => typeof term === "string") || typeof rev !== "string") return [];
        // Keyed on rev, not v: the stored terms are the content of that rev, whichever op wrote it.
        const same = [{ key: "rev", match: { value: rev } }];
        return [
          { update_vectors: { points: [{ id, vector: { bm25: termsSparse(terms as string[], avgdl) } }], update_filter: { must: same, must_not: [TOMBSTONE] } } },
          { set_payload: { payload: { ad: avgdl }, filter: { must: [{ has_id: [id] }, ...same], must_not: [TOMBSTONE] } } },
        ];
      });
      if (operations.length > 0) await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, { operations });
      offset = page.next_page_offset ?? undefined;
    } while (offset && epoch === this.collectionEpoch);
  }

  async keyword(query: unknown, limit: unknown, layer: unknown): Promise<Hit[]> {
    if (typeof query !== "string") return [];
    const sparse = querySparse(query);
    if (sparse.indices.length === 0) return [];
    await this.ready();
    if (this.avgdl === null) this.corpusDidChange();
    const res = await this.qdrant.call<{ points: ScoredPoint[] }>("POST", `${this.qdrant.path}/points/query`, {
      query: sparse,
      using: "bm25",
      limit: clampLimit(limit),
      filter: layerFilter(isSearchLayer(layer) ? layer : "all"),
      with_payload: HIT_PAYLOAD,
    });
    return toHits(res.points);
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
    const byLayer = (value: SearchResultLayer) => ({ must: [{ key: "layer", match: { value } }] });
    const [docs, vectors, memories, lessons, missingVectors] = await Promise.all([
      this.qdrant.count(LIVE_DOCS),
      this.qdrant.count({ must: [{ key: "dense", match: { value: true } }], must_not: [TOMBSTONE] }),
      this.qdrant.count(byLayer("memory")),
      this.qdrant.count(byLayer("lesson")),
      this.qdrant.count(MISSING_VECTOR_FILTER),
    ]);
    return { docs, vectors, memories, lessons, missingVectors };
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
    if (scope === "all") {
      await this.ready();
      await this.qdrant.drop();
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

import { base64ToFloat32 } from "../../state/vector-index.js";
import { isSearchLayer, isSearchResultLayer, type SearchLayer, type SearchResultLayer } from "../../state/search-layer.js";
import type {
  ApplyResult,
  ClearScope,
  ContentRev,
  HealthResult,
  Hit,
  Op,
  ScanMissingResult,
  StatsResult,
} from "../search/protocol.js";
import { docSparse, querySparse } from "./bm25-sparse.js";
import { pointId, type Qdrant } from "./qdrant.js";

interface ScoredPoint { id: string; score: number; payload?: { doc_id?: string; session_id?: string } }
interface RecordPoint { id: string; payload?: { doc_id?: string; session_id?: string; layer?: string; rev?: string } }

const HIT_PAYLOAD = ["doc_id", "session_id"];
const MAX_LIMIT = 1000;

function layerFilter(layer: SearchLayer): unknown {
  return layer === "all" ? undefined : { must: [{ key: "layer", match: { value: layer } }] };
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
  constructor(private readonly qdrant: Qdrant, private readonly avgdl: number) {}

  /**
   * Applies ops in order in one Qdrant batch. A vector is stored only when
   * the point exists and its rev equals the rev the vector was embedded
   * from, so an embedding that finishes after its record changed or was
   * deleted is dropped (reported in `fenced`).
   */
  async apply(rawOps: unknown[]): Promise<ApplyResult> {
    const failed: ApplyResult["failed"] = [];
    const ops: Op[] = [];
    for (const op of rawOps) {
      const error = opError(op);
      if (error) failed.push({ id: String((op as { id?: unknown })?.id ?? ""), error });
      else ops.push(op as Op);
    }

    const writtenFirst = new Set<string>();
    const lookup = new Set<string>();
    for (const op of ops) {
      if (op.k === "doc" || op.k === "del") writtenFirst.add(op.id);
      else if (!writtenFirst.has(op.id)) lookup.add(op.id);
    }
    const stored = await this.storedRevs([...lookup]);
    const rev = new Map<string, ContentRev | null>();
    const revOf = (id: string) => (rev.has(id) ? rev.get(id)! : stored.get(id) ?? null);

    const operations: unknown[] = [];
    const fenced: string[] = [];
    let applied = 0;
    for (const op of ops) {
      const id = pointId(op.id);
      switch (op.k) {
        case "doc": {
          const bm25 = docSparse(op.fields, this.avgdl);
          const payload = { session_id: op.sessionId, layer: op.layer, ts: op.ts, rev: op.rev };
          operations.push(
            { upsert: { points: [{ id, vector: { bm25 }, payload: { doc_id: op.id, ...payload, dense: false } }], update_mode: "insert_only" } },
            { update_vectors: { points: [{ id, vector: { bm25 } }] } },
            { set_payload: { payload, points: [id] } },
          );
          rev.set(op.id, op.rev);
          break;
        }
        case "del":
          operations.push({ delete: { points: [id] } });
          rev.set(op.id, null);
          break;
        case "vec":
          if (revOf(op.id) !== op.rev) {
            fenced.push(op.id);
            continue;
          }
          operations.push(
            { update_vectors: { points: [{ id, vector: { dense: Array.from(base64ToFloat32(op.f32b64)) } }] } },
            { set_payload: { payload: { dense: true }, points: [id] } },
          );
          break;
        case "vec-del":
          if (revOf(op.id) === null) break;
          operations.push(
            { delete_vectors: { points: [id], vector: ["dense"] } },
            { set_payload: { payload: { dense: false }, points: [id] } },
          );
          break;
      }
      applied++;
    }
    if (operations.length > 0) await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, { operations });
    return { applied, fenced, failed };
  }

  private async storedRevs(docIds: string[]): Promise<Map<string, ContentRev>> {
    const revs = new Map<string, ContentRev>();
    if (docIds.length === 0) return revs;
    const points = await this.qdrant.call<RecordPoint[]>("POST", `${this.qdrant.path}/points`, {
      ids: docIds.map(pointId),
      with_payload: ["doc_id", "rev"],
      with_vector: false,
    });
    for (const p of points) {
      if (p.payload?.doc_id && typeof p.payload.rev === "string") revs.set(p.payload.doc_id, p.payload.rev as ContentRev);
    }
    return revs;
  }

  async keyword(query: unknown, limit: unknown, layer: unknown): Promise<Hit[]> {
    if (typeof query !== "string") return [];
    const sparse = querySparse(query);
    if (sparse.indices.length === 0) return [];
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
    const byLayer = (value: SearchResultLayer) => ({ must: [{ key: "layer", match: { value } }] });
    const [docs, vectors, memories, lessons, missingVectors] = await Promise.all([
      this.qdrant.count(),
      this.qdrant.count({ must: [{ key: "dense", match: { value: true } }] }),
      this.qdrant.count(byLayer("memory")),
      this.qdrant.count(byLayer("lesson")),
      this.qdrant.count(MISSING_VECTOR_FILTER),
    ]);
    return { docs, vectors, memories, lessons, missingVectors };
  }

  async sessionCounts(): Promise<Array<[string, number]>> {
    const res = await this.qdrant.call<{ hits: Array<{ value: string; count: number }> }>("POST", `${this.qdrant.path}/facet`, {
      key: "session_id",
      filter: { must: [{ key: "layer", match: { value: "observation" } }] },
      limit: 1_000_000,
      exact: true,
    });
    return res.hits.map((h) => [h.value, h.count]);
  }

  async scanMissingVectors(cursor: unknown, limit: unknown): Promise<ScanMissingResult> {
    const res = await this.qdrant.call<{ points: RecordPoint[]; next_page_offset?: string | null }>("POST", `${this.qdrant.path}/points/scroll`, {
      filter: MISSING_VECTOR_FILTER,
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

  async clear(scope: ClearScope): Promise<void> {
    if (scope === "all") {
      await this.qdrant.drop();
      await this.qdrant.create();
      return;
    }
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
      await this.qdrant.ensure();
      const info = await this.qdrant.call<{ status: string; config: { params: { vectors: { dense?: { size: number } } } } }>("GET", this.qdrant.path);
      const dimensions = info.config.params.vectors.dense?.size ?? 0;
      return { ok: info.status !== "red", collection, dimensions, status: info.status };
    } catch (error) {
      return { ok: false, collection, dimensions: 0, status: "unreachable", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

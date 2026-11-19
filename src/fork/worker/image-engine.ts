import { base64ToFloat32 } from "../../state/vector-index.js";
import type { ApplyResult, HealthResult, ImageHit, ImageQueryResult, OpVersion } from "../search/protocol.js";
import { clampLimit } from "./engine.js";
import { pointId, type Qdrant } from "./qdrant.js";
import { notNewerThan, TOMBSTONE, VersionClock } from "./versioned.js";

interface ImagePoint {
  id: string;
  score: number;
  payload?: { doc_id?: string; session_id?: string; observation_id?: string; updated_at?: string };
}

type ImageWrite =
  | { k: "img"; id: string; sessionId: string; observationId?: string; updatedAt: string; vector: number[] }
  | { k: "del"; id: string };

const HIT_PAYLOAD = ["doc_id", "session_id", "observation_id", "updated_at"];

/** Image points are written by `img` (the whole record) and `del` (a tombstone); every other op kind is reported per id. */
function parseOp(op: unknown, dimensions: number): ImageWrite | string {
  if (!op || typeof op !== "object") return "op is not an object";
  const o = op as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return "id must be a non-empty string";
  if (o.k === "del") return { k: "del", id: o.id };
  if (o.k !== "img") return `op kind ${String(o.k)} is not valid on the images collection`;
  if (typeof o.sessionId !== "string" || typeof o.f32b64 !== "string" || typeof o.updatedAt !== "string") return "img needs sessionId, f32b64 and updatedAt";
  if (o.observationId !== undefined && typeof o.observationId !== "string") return "img observationId must be a string";
  let vector: number[];
  try {
    vector = Array.from(base64ToFloat32(o.f32b64));
  } catch {
    return "img f32b64 is not a whole number of float32 values";
  }
  if (vector.length !== dimensions) return `vector length ${vector.length} does not match dimensions ${dimensions}`;
  if (!vector.every(Number.isFinite)) return "img vector holds a non-finite value";
  return { k: "img", id: o.id, sessionId: o.sessionId, observationId: o.observationId, updatedAt: o.updatedAt, vector };
}

/**
 * The images collection: one exact-search vector per image plus the payload
 * the result needs, so a query never reads the embeddings from the app's
 * store. Versions and tombstones work as in SearchEngine: a write applies
 * only while the point's `v` is not newer than its own, so a late older
 * invocation cannot overwrite a newer image or resurrect a deleted one.
 */
export class ImageEngine {
  private ensured: Promise<void> | null = null;
  private readonly clock: VersionClock;

  constructor(private readonly qdrant: Qdrant) {
    this.clock = new VersionClock(qdrant, () => this.ready());
  }

  maxVersion(): Promise<OpVersion> {
    return this.clock.maxVersion();
  }

  private ready(): Promise<void> {
    return (this.ensured ??= this.qdrant.ensure().catch((error) => {
      this.ensured = null;
      throw error;
    }));
  }

  async apply(rawOps: unknown[], rawVersion?: unknown): Promise<ApplyResult> {
    const version = await this.clock.versionFor(rawVersion);
    const failed: ApplyResult["failed"] = [];
    // The last op for an id wins, as it does in the outbox; one request never holds two writes to a point.
    const writes = new Map<string, ImageWrite>();
    for (const op of rawOps) {
      const parsed = parseOp(op, this.qdrant.config.dimensions);
      if (typeof parsed === "string") {
        failed.push({ id: String((op as { id?: unknown } | null)?.id ?? ""), error: parsed });
        continue;
      }
      writes.delete(parsed.id);
      writes.set(parsed.id, parsed);
    }

    const points: unknown[] = [];
    const tombstones: unknown[] = [];
    const tombstoneIds: string[] = [];
    for (const write of writes.values()) {
      const id = pointId(write.id);
      if (write.k === "img") {
        points.push({
          id,
          vector: { image: write.vector },
          payload: {
            doc_id: write.id,
            session_id: write.sessionId,
            ...(write.observationId !== undefined ? { observation_id: write.observationId } : {}),
            updated_at: write.updatedAt,
            v: version,
            deleted: false,
          },
        });
      } else {
        tombstones.push({ id, vector: {}, payload: { doc_id: write.id, deleted: true, v: version } });
        tombstoneIds.push(id);
      }
    }

    const operations: unknown[] = [];
    if (points.length > 0) operations.push({ upsert: { points, update_filter: notNewerThan(version) } });
    if (tombstones.length > 0) {
      operations.push(
        { upsert: { points: tombstones, update_filter: notNewerThan(version) } },
        // A tombstone this invocation wrote drops the image vector the upsert left in place.
        { delete_vectors: { filter: { must: [{ has_id: tombstoneIds }, { key: "v", match: { value: version } }, TOMBSTONE] }, vector: ["image"] } },
      );
    }
    if (operations.length > 0) {
      await this.ready();
      await this.qdrant.call("POST", `${this.qdrant.path}/points/batch?wait=true`, { operations });
    }
    return { applied: writes.size, fenced: [], failed };
  }

  /** Exact cosine top-K over live images, with the count of live images under the same filter. */
  async query(f32b64: unknown, limit: unknown, sessionId: unknown): Promise<ImageQueryResult> {
    if (typeof f32b64 !== "string") throw new Error("image query needs f32b64");
    const vector = Array.from(base64ToFloat32(f32b64));
    if (vector.length !== this.qdrant.config.dimensions) {
      throw new Error(`query vector length ${vector.length} does not match dimensions ${this.qdrant.config.dimensions}`);
    }
    await this.ready();
    const filter = {
      ...(typeof sessionId === "string" && sessionId.length > 0 ? { must: [{ key: "session_id", match: { value: sessionId } }] } : {}),
      must_not: [TOMBSTONE],
    };
    const [res, total] = await Promise.all([
      this.qdrant.call<{ points: ImagePoint[] }>("POST", `${this.qdrant.path}/points/query`, {
        query: vector,
        using: "image",
        limit: clampLimit(limit),
        filter,
        params: { exact: true },
        with_payload: HIT_PAYLOAD,
      }),
      this.qdrant.count(filter),
    ]);
    const hits = res.points.flatMap((p): ImageHit[] =>
      p.payload?.doc_id
        ? [{
            id: p.payload.doc_id,
            sessionId: p.payload.session_id ?? "",
            ...(p.payload.observation_id !== undefined ? { observationId: p.payload.observation_id } : {}),
            updatedAt: p.payload.updated_at ?? "",
            score: p.score,
          }]
        : [],
    );
    return { hits, total };
  }

  async clear(scope: unknown): Promise<void> {
    if (scope !== "all") throw new Error("clear scope must be all on the images collection");
    await this.ready();
    await this.qdrant.drop();
    this.ensured = null;
    await this.ready();
  }

  async health(): Promise<HealthResult> {
    const { collection } = this.qdrant.config;
    try {
      await this.ready();
      const info = await this.qdrant.call<{ status: string; config: { params: { vectors: { image?: { size: number } } } } }>("GET", this.qdrant.path);
      return { ok: info.status !== "red", collection, dimensions: info.config.params.vectors.image?.size ?? 0, status: info.status };
    } catch (error) {
      return { ok: false, collection, dimensions: 0, status: "unreachable", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

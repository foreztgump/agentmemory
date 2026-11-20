import { createHash } from "node:crypto";
import type { SearchLayer, SearchResultLayer } from "../../state/search-layer.js";
import type { TermSource } from "../../state/term-extraction.js";

export const SEARCH_FN = {
  apply: "search::apply",
  keyword: "search::keyword",
  vector: "search::vector",
  stats: "search::stats",
  sessionCounts: "search::session-counts",
  scanMissingVectors: "search::scan-missing-vectors",
  clear: "search::clear",
  health: "search::health",
  lookup: "search::lookup",
  maxVersion: "search::max-version",
  imageQuery: "search::image-query",
} as const;

/** One list drives the collection names, the worker's routing and the client binding. */
export const COLLECTION_SUFFIX = { docs: "", lessons: "_lessons", images: "_images" } as const;
export type CollectionId = keyof typeof COLLECTION_SUFFIX;

export const COLLECTION_IDS = Object.keys(COLLECTION_SUFFIX) as CollectionId[];

export function isCollectionId(value: unknown): value is CollectionId {
  return typeof value === "string" && Object.hasOwn(COLLECTION_SUFFIX, value);
}

export function collectionName(base: string, id: CollectionId): string {
  return `${base}${COLLECTION_SUFFIX[id]}`;
}

/** Every request may name its collection; absent means docs, so the docs wire format carries no field. */
export interface CollectionScoped { collection?: CollectionId }

/** Content hash of a document's indexed text; the fence a vector must match to be stored. */
export type ContentRev = string & { readonly __brand: "ContentRev" };

export function contentRev(fields: TermSource): ContentRev {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16) as ContentRev;
}

export type DocOp = { k: "doc"; id: string; sessionId: string; layer: SearchResultLayer; ts: number; rev: ContentRev; fields: TermSource };
export type DelOp = { k: "del"; id: string };
export type VecOp = { k: "vec"; id: string; rev: ContentRev; f32b64: string };
export type VecDelOp = { k: "vec-del"; id: string };
/** An image embedding with its metadata; valid only on the images collection. */
export type ImgOp = { k: "img"; id: string; sessionId: string; f32b64: string; observationId?: string; updatedAt: string };
export type Op = DocOp | DelOp | VecOp | VecDelOp | ImgOp;

export type ClearScope = "all" | "vectors";

/**
 * Orders apply invocations. The worker drops an op whose version is older
 * than the last one it applied to that id, so an invocation that timed out
 * and completes after its retry cannot overwrite the retry or undo a delete.
 * One writer process per store: versions order that writer's invocations,
 * and a second writer's clock would interleave with them. Before its first
 * write after a start, the writer seeds its clock above the highest stored
 * version (search::max-version), so a clock behind the last run's still wins.
 */
export type OpVersion = number;

let lastVersion = 0;

/** Microseconds since the epoch, bumped to stay strictly increasing within this process. */
export function nextOpVersion(): OpVersion {
  lastVersion = Math.max(lastVersion + 1, Date.now() * 1000);
  return lastVersion;
}

export function seedOpVersion(version: OpVersion): void {
  if (Number.isSafeInteger(version) && version > lastVersion) lastVersion = version;
}

export interface MaxVersionResult { version: OpVersion }

export interface ApplyRequest extends CollectionScoped { ops: Op[]; version?: OpVersion }
export interface ApplyResult {
  applied: number;
  /** Vector changes dropped because the record changed, was deleted, or holds a newer invocation's version. */
  fenced: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface Hit { id: string; sessionId: string; score: number }
export interface KeywordRequest extends CollectionScoped { query: string; limit: number; layer: SearchLayer }
export interface VectorRequest extends CollectionScoped { f32b64: string; limit: number; layer: SearchLayer }
export interface HitsResult { hits: Hit[] }

export interface ImageQueryRequest extends CollectionScoped { f32b64: string; limit: number; sessionId?: string }
export interface ImageHit { id: string; sessionId: string; observationId?: string; updatedAt: string; score: number }
/** `total` counts the live images under the same session filter. */
export interface ImageQueryResult { hits: ImageHit[]; total: number }

export interface StatsResult {
  docs: number;
  vectors: number;
  memories: number;
  lessons: number;
  /** Observations and memories without a dense vector. */
  missingVectors: number;
}

export interface SessionCountsResult { counts: Array<[string, number]> }

export interface ScanMissingRequest extends CollectionScoped { cursor?: string; limit: number }
export interface ScanMissingResult {
  items: Array<{ id: string; sessionId: string; layer: SearchResultLayer; rev: ContentRev }>;
  next?: string;
}

export interface LookupRequest extends CollectionScoped { ids: string[] }
export interface LookupResult { items: Array<{ id: string; sessionId: string; layer: SearchResultLayer; rev: ContentRev }> }

export interface ClearRequest extends CollectionScoped { scope: ClearScope }
export interface HealthResult { ok: boolean; collection: string; dimensions: number; status: string; error?: string }

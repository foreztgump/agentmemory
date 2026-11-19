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
} as const;

/** Content hash of a document's indexed text; the fence a vector must match to be stored. */
export type ContentRev = string & { readonly __brand: "ContentRev" };

export function contentRev(fields: TermSource): ContentRev {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16) as ContentRev;
}

export type DocOp = { k: "doc"; id: string; sessionId: string; layer: SearchResultLayer; ts: number; rev: ContentRev; fields: TermSource };
export type DelOp = { k: "del"; id: string };
export type VecOp = { k: "vec"; id: string; rev: ContentRev; f32b64: string };
export type VecDelOp = { k: "vec-del"; id: string };
export type Op = DocOp | DelOp | VecOp | VecDelOp;

export type ClearScope = "all" | "vectors";

/**
 * Orders apply invocations. The worker drops an op whose version is older
 * than the last one it applied to that id, so an invocation that timed out
 * and completes after its retry cannot overwrite the retry or undo a delete.
 */
export type OpVersion = number;

let lastVersion = 0;

/** Microseconds since the epoch, bumped to stay strictly increasing within this process. */
export function nextOpVersion(): OpVersion {
  lastVersion = Math.max(lastVersion + 1, Date.now() * 1000);
  return lastVersion;
}

export interface ApplyRequest { ops: Op[]; version?: OpVersion }
export interface ApplyResult {
  applied: number;
  /** Vectors dropped because the record changed or was deleted after embedding started. */
  fenced: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface Hit { id: string; sessionId: string; score: number }
export interface KeywordRequest { query: string; limit: number; layer: SearchLayer }
export interface VectorRequest { f32b64: string; limit: number; layer: SearchLayer }
export interface HitsResult { hits: Hit[] }

export interface StatsResult {
  docs: number;
  vectors: number;
  memories: number;
  lessons: number;
  /** Observations and memories without a dense vector. */
  missingVectors: number;
}

export interface SessionCountsResult { counts: Array<[string, number]> }

export interface ScanMissingRequest { cursor?: string; limit: number }
export interface ScanMissingResult {
  items: Array<{ id: string; sessionId: string; layer: SearchResultLayer; rev: ContentRev }>;
  next?: string;
}

export interface LookupRequest { ids: string[] }
export interface LookupResult { items: Array<{ id: string; sessionId: string; layer: SearchResultLayer; rev: ContentRev }> }

export interface ClearRequest { scope: ClearScope }
export interface HealthResult { ok: boolean; collection: string; dimensions: number; status: string; error?: string }

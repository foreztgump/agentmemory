import { vectorBucketScope } from "../../state/index-persistence.js";
import { KV } from "../../state/schema.js";

/**
 * The layout the memory-mode index persists its vectors in (upstream
 * src/state/index-persistence.ts), as the disk migration reads it from the
 * redis state store: each scope is a hash `state:<scope>`, field = key,
 * value = JSON. test/fork-vector-layout.test.ts drives upstream's own writer
 * and fails when this layout changes.
 *
 * - bucket hashes `mem:index:bm25:vec:NNNN`: `{ id, s: sessionId, e: base64 float32 }`
 * - the pending log `mem:index:vec-pending`, newer than the buckets and
 *   replayed in order of `q`: a vector `{ q, id, s, k, e }`, a delete
 *   `{ q, id, t: 1 }`, or a clear `{ q, c: 1 }`
 * - legacy single-key and sharded snapshots, which the migration refuses:
 *   one memory-mode boot of the current release converts them to buckets.
 */
export const STATE_PREFIX = "state:";
const BUCKET_ZERO = vectorBucketScope(0);
export const BUCKET_SCOPE_PREFIX = BUCKET_ZERO.replace(/0+$/, "");
export const PENDING_SCOPE = KV.vectorPendingLog;
export const LEGACY_VECTOR_KEYS = { scope: KV.bm25Index, keys: ["vectors", "vectors:manifest"], shardScopePrefix: `${KV.bm25Index}:vectors:` };

/** What TEE-1156's provenance run measured for every stored vector on both stacks (2026-11-18). */
export const STORED_VECTOR_MODEL = { model: "voyage-code-4", dimensions: 1024, dtype: "float32" } as const;

export function bucketOfScope(scope: string): number | null {
  if (!scope.startsWith(BUCKET_SCOPE_PREFIX)) return null;
  const digits = scope.slice(BUCKET_SCOPE_PREFIX.length);
  return /^\d+$/.test(digits) && vectorBucketScope(Number(digits)) === scope ? Number(digits) : null;
}

/** Raw float32 bytes, or null unless the text is canonical base64 of exactly `dimensions` finite floats. */
export function decodeExact(b64: unknown, dimensions: number): Buffer | null {
  if (typeof b64 !== "string") return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length !== dimensions * 4 || bytes.toString("base64") !== b64) return null;
  for (let i = 0; i < bytes.length; i += 4) if (!Number.isFinite(bytes.readFloatLE(i))) return null;
  return bytes;
}

export type BucketRow = { ok: true; id: string; sessionId: string; bytes: Buffer } | { ok: false; id: string; reason: string };

export function parseBucketRow(field: string, value: Buffer, dimensions: number): BucketRow {
  let row: { id?: unknown; s?: unknown; e?: unknown };
  try {
    row = JSON.parse(value.toString("utf8"));
  } catch {
    return { ok: false, id: field, reason: "not json" };
  }
  if (!row || typeof row !== "object" || row.id !== field || typeof row.s !== "string") return { ok: false, id: field, reason: "not a vector row" };
  const bytes = decodeExact(row.e, dimensions);
  return bytes ? { ok: true, id: field, sessionId: row.s, bytes } : { ok: false, id: field, reason: `not ${dimensions} float32` };
}

export type PendingRow =
  | { kind: "vec"; q: number; id: string; bytes: Buffer }
  | { kind: "del"; q: number; id: string }
  | { kind: "clear"; q: number }
  | { kind: "malformed"; id: string; reason: string };

export function parsePendingRow(field: string, value: Buffer, dimensions: number): PendingRow {
  let row: { q?: unknown; id?: unknown; e?: unknown; t?: unknown; c?: unknown };
  try {
    row = JSON.parse(value.toString("utf8"));
  } catch {
    return { kind: "malformed", id: field, reason: "not json" };
  }
  if (!row || typeof row !== "object" || typeof row.q !== "number" || !Number.isFinite(row.q)) return { kind: "malformed", id: field, reason: "no sequence" };
  const q = row.q;
  if (row.c === 1) return { kind: "clear", q };
  if (typeof row.id !== "string" || row.id.length === 0) return { kind: "malformed", id: field, reason: "no id" };
  if (row.t === 1) return { kind: "del", q, id: row.id };
  const bytes = decodeExact(row.e, dimensions);
  return bytes ? { kind: "vec", q, id: row.id, bytes } : { kind: "malformed", id: row.id, reason: `not ${dimensions} float32` };
}

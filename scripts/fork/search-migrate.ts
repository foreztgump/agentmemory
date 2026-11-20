// Fills the disk search index (the am-search Qdrant collection) from a stack's
// existing data, with no embedding calls: keyword documents from the records,
// and the vectors the memory-mode index persisted, decoded and loaded as they are.
//
//   MIGRATE_STORE_URL=redis://:pw@kvrocks:6666 AM_QDRANT_URL=http://qdrant:6333 AM_QDRANT_API_KEY=... \
//     node --import tsx scripts/fork/search-migrate.ts fill|verify|status [--page 200] [--rate 64] [--allow-nonempty]
//
// fill    Reads the store over RESP, never a whole hash at once (HSCAN pages).
//         1. Plans the vectors: every bucket hash, then the pending log in order
//            of its sequence, collapsed to one vector per document (ids and a
//            digest only are held). A row that is not 1024 float32 is refused
//            and counted. Legacy snapshot layouts are refused.
//         2. Writes one unit at a time (the memories, then each session): the
//            keyword document of every indexable record, built by docOfRecord
//            and docOp as the app builds it, with the document's stored vector
//            in the same point (SearchEngine.load). Every write carries version 1, so a
//            re-run rewrites its own points and any live write always wins.
//         3. The lessons unit: every lesson in `mem:lessons` that is not deleted,
//            as the keyword document the app writes (lessonToObservation, docOp),
//            through the lessons collection's apply at version 1.
//         4. The images unit: every row of `mem:image-embeddings` as an `img` op
//            through the images collection's apply at version 1. A vector that is
//            not AM_SEARCH_IMAGE_DIMENSIONS (512) finite numbers is refused and counted.
//         The resume state is the hash `fork:search-migrate` in the store
//         (outside `state:*`, which the app reads): the version and one field
//         per finished unit. A killed run re-does only its unfinished unit.
// verify  Recomputes the plan and the expected documents from the store and
//         compares: documents per layer and per session, vectors, a sample of
//         vectors (normalised and rounded to float16, as Qdrant stores them)
//         and of keyword revs, and the embedding calls made (must be 0). Lessons
//         and images: counts, and every row's rev or vector and metadata, with a
//         checksum of each side.
// status  The marker: version, units done, embedding calls.
//
// No embedding provider is constructed: nothing here imports one, a test pins
// that, and every fetch that is not to Qdrant is refused and counted.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { docOfRecord, type RecordKind } from "../../src/fork/search/doc-of-record.js";
import {
  BUCKET_SCOPE_PREFIX,
  bucketOfScope,
  LEGACY_VECTOR_KEYS,
  parseBucketRow,
  parsePendingRow,
  PENDING_SCOPE,
  STATE_PREFIX,
  STORED_VECTOR_MODEL,
} from "../../src/fork/search/persisted-vectors.js";
import { docOp, type DocOp, type ImgOp, type OpVersion, type VecOp } from "../../src/fork/search/protocol.js";
import { DEFAULT_AVGDL, loadSearchWorkerSettings } from "../../src/fork/search/settings.js";
import { SearchEngine } from "../../src/fork/worker/engine.js";
import { ImageEngine } from "../../src/fork/worker/image-engine.js";
import { pointId, Qdrant } from "../../src/fork/worker/qdrant.js";
import { validVersion } from "../../src/fork/worker/versioned.js";
import { vectorBucketScope } from "../../src/state/index-persistence.js";
import { lessonToObservation } from "../../src/state/memory-utils.js";
import { KV } from "../../src/state/schema.js";
import { extractTerms } from "../../src/state/term-extraction.js";
import { base64ToFloat32, float32ToBase64 } from "../../src/state/vector-index.js";
import type { Lesson } from "../../src/types.js";
import { connectRedis, redactUrl, type Redis, type Reply } from "./lib/resp.js";

export const MARKER_KEY = "fork:search-migrate";
const META_FIELD = "meta";
const CALLS_FIELD = "embedding-calls";
const UNIT_PREFIX = "unit:";
const MEMORIES_UNIT = "memories";
const LESSONS_UNIT = "lessons";
const IMAGES_UNIT = "images";
const PENDING_CLEAR_FIELD = "~clear";
/**
 * Every migrated write carries this version, the lowest there is: a re-run
 * rewrites only its own points, and any live write (stamped from the clock,
 * above every stored version) outranks it, so a migration can never overwrite
 * or resurrect what the app wrote after it.
 */
export const MIGRATION_VERSION: OpVersion = 1;

export class MigrateError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

/** The three collections the migration writes, each through its own engine. */
export interface Targets {
  docs: { engine: SearchEngine; qdrant: Qdrant };
  lessons: { engine: SearchEngine; qdrant: Qdrant };
  images: { engine: ImageEngine; qdrant: Qdrant };
}

const str = (reply: Reply): string => (Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply));

/** Counts every fetch that is not to Qdrant and refuses it, so an embedding call cannot happen unseen. */
export class FetchGuard {
  refused = 0;
  private readonly original = globalThis.fetch;

  constructor(private readonly allowedOrigin: string) {}

  install(): this {
    const original = this.original;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      let origin: string | null = null;
      try {
        origin = new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin;
      } catch {
        // counted and refused below
      }
      if (origin === this.allowedOrigin) return original(input, init);
      this.refused++;
      return Promise.reject(new MigrateError(`refused a call to ${origin ?? "an unparsable URL"}: the migration makes no calls but to Qdrant`, 4));
    }) as typeof fetch;
    return this;
  }

  uninstall(): void {
    globalThis.fetch = this.original;
  }
}

export async function* hashPages(store: Redis, key: string, page: number): AsyncGenerator<Array<[string, Buffer]>> {
  let cursor = "0";
  do {
    const [next, flat] = (await store.call("HSCAN", key, cursor, "COUNT", String(page))) as [Buffer, Buffer[]];
    cursor = str(next);
    const pairs: Array<[string, Buffer]> = [];
    for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i]!.toString("utf8"), flat[i + 1]!]);
    if (pairs.length > 0) yield pairs;
  } while (cursor !== "0");
}

async function scanKeys(store: Redis, pattern: string, page: number): Promise<string[]> {
  const keys = new Set<string>();
  let cursor = "0";
  do {
    const [next, batch] = (await store.call("SCAN", cursor, "MATCH", pattern, "COUNT", String(page))) as [Buffer, Buffer[]];
    cursor = str(next);
    for (const key of batch) keys.add(key.toString("utf8"));
  } while (cursor !== "0");
  return [...keys];
}

// ---------------------------------------------------------------- the vector plan

/**
 * Buddy's store holds 6,634 documents with two bucket rows of the same text
 * embedded twice (cosine 0.9938 to 1, median 0.99998); embeddings of different
 * text sit far below this.
 */
export const NEAR_DUPLICATE_COSINE = 0.99;

function cosine(a: Buffer, b: Buffer): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 4) {
    const x = a.readFloatLE(i);
    const y = b.readFloatLE(i);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / Math.sqrt(na * nb);
}

export const bucketKey = (bucket: number) => STATE_PREFIX + vectorBucketScope(bucket);

/** Where a document's winning vector row lives: a bucket number, or the pending log. */
type Source = number | "pending";
const digestOf = (bytes: Buffer) => createHash("sha1").update(bytes).digest("base64").slice(0, 16);

export interface PlanReport {
  bucketScopes: number;
  bucketRows: number;
  pendingRows: number;
  /** Rows refused because they do not decode to 1024 float32 (or are not vector rows at all). */
  malformed: number;
  /** Rows of a document seen in an earlier bucket with the same bytes. */
  duplicateRows: number;
  /**
   * Documents with two bucket rows that are the same text embedded twice
   * (cosine at least NEAR_DUPLICATE_COSINE); the row in the higher bucket,
   * the later write, is loaded.
   */
  nearDuplicates: number;
  nearDuplicateMinCosine: number | null;
  /** Documents whose bucket rows disagree beyond that; none of their rows is loaded. */
  conflicting: number;
  /** Pending-log entries that replaced or removed a bucket row, and clears. */
  pendingVectors: number;
  pendingDeletes: number;
  pendingClears: number;
  /** One vector per document: what the migration loads. */
  docs: number;
}

export interface VectorPlan {
  report: PlanReport;
  winners: Map<string, { source: Source; digest: string }>;
}

/**
 * Every persisted vector row, collapsed to one per document the way the
 * memory-mode boot would see them: the buckets, then the pending log in order
 * of its sequence (a vector replaces, a delete removes, a clear drops all
 * before it). Two bucket rows of one document with different bytes are
 * compared: a re-embedding of the same text loads the later row; anything
 * further apart is a conflict nothing can settle without re-embedding, so that
 * document gets no vector and is counted. Holds ids and a short digest only.
 */
export async function planVectors(store: Redis, dimensions: number, page: number): Promise<VectorPlan> {
  const legacy = await store.pipeline(LEGACY_VECTOR_KEYS.keys.map((key) => ["HEXISTS", STATE_PREFIX + LEGACY_VECTOR_KEYS.scope, key]));
  const shards = await scanKeys(store, `${STATE_PREFIX}${LEGACY_VECTOR_KEYS.shardScopePrefix}*`, 1000);
  if (legacy.some((exists) => exists === 1) || shards.length > 0) {
    throw new MigrateError("the store holds a legacy vector snapshot; start this release once in memory mode to convert it to buckets, then migrate", 3);
  }
  const report: PlanReport = {
    bucketScopes: 0, bucketRows: 0, pendingRows: 0, malformed: 0, duplicateRows: 0, nearDuplicates: 0, nearDuplicateMinCosine: null, conflicting: 0,
    pendingVectors: 0, pendingDeletes: 0, pendingClears: 0, docs: 0,
  };
  const winners = new Map<string, { source: Source; digest: string }>();
  const conflicted = new Set<string>();
  const buckets = (await scanKeys(store, `${STATE_PREFIX}${BUCKET_SCOPE_PREFIX}*`, 1000))
    .map((key) => ({ key, bucket: bucketOfScope(key.slice(STATE_PREFIX.length)) }))
    .filter((b): b is { key: string; bucket: number } => b.bucket !== null)
    .sort((a, b) => a.bucket - b.bucket);
  report.bucketScopes = buckets.length;
  for (const { key, bucket } of buckets) {
    for await (const pairs of hashPages(store, key, page)) {
      for (const [field, value] of pairs) {
        report.bucketRows++;
        const row = parseBucketRow(field, value, dimensions);
        if (!row.ok) {
          report.malformed++;
          continue;
        }
        const digest = digestOf(row.bytes);
        const seen = winners.get(row.id);
        if (!seen) winners.set(row.id, { source: bucket, digest });
        else if (seen.digest === digest) report.duplicateRows++;
        else if (!conflicted.has(row.id)) {
          const earlier = await store.call("HGET", bucketKey(seen.source as number), row.id);
          const earlierRow = Buffer.isBuffer(earlier) ? parseBucketRow(row.id, earlier, dimensions) : null;
          const similarity = earlierRow?.ok ? cosine(earlierRow.bytes, row.bytes) : -1;
          if (similarity >= NEAR_DUPLICATE_COSINE) {
            winners.set(row.id, { source: bucket, digest });
            report.nearDuplicates++;
            report.nearDuplicateMinCosine = Math.min(report.nearDuplicateMinCosine ?? 1, Number(similarity.toFixed(6)));
          } else conflicted.add(row.id);
        }
      }
    }
  }

  const pending: Array<{ q: number; kind: "vec" | "del" | "clear"; id?: string; digest?: string }> = [];
  const refused = new Set<string>();
  for await (const pairs of hashPages(store, STATE_PREFIX + PENDING_SCOPE, page)) {
    for (const [field, value] of pairs) {
      report.pendingRows++;
      const row = parsePendingRow(field, value, dimensions);
      if (row.kind === "malformed") {
        report.malformed++;
        // A newer vector that cannot be read: the older bucket row may no longer match the record, so load none.
        if (field !== PENDING_CLEAR_FIELD) refused.add(field);
      }
      else if (row.kind === "vec") pending.push({ q: row.q, kind: "vec", id: row.id, digest: digestOf(row.bytes) });
      else if (row.kind === "del") pending.push({ q: row.q, kind: "del", id: row.id });
      else pending.push({ q: row.q, kind: "clear" });
    }
  }
  for (const entry of pending.sort((a, b) => a.q - b.q)) {
    if (entry.kind === "clear") {
      winners.clear();
      conflicted.clear();
      report.pendingClears++;
    } else if (entry.kind === "del") {
      winners.delete(entry.id!);
      conflicted.delete(entry.id!);
      report.pendingDeletes++;
    } else {
      winners.set(entry.id!, { source: "pending", digest: entry.digest! });
      conflicted.delete(entry.id!);
      report.pendingVectors++;
    }
  }
  for (const id of [...conflicted, ...refused]) winners.delete(id);
  report.conflicting = conflicted.size;
  report.docs = winners.size;
  return { report, winners };
}

/** The winning rows' bytes for ids, read with one HMGET per source; a row that changed since the plan is an error. */
export async function readVectors(store: Redis, plan: VectorPlan, ids: string[], dimensions: number): Promise<Map<string, Buffer>> {
  const bySource = new Map<Source, string[]>();
  for (const id of ids) {
    const w = plan.winners.get(id);
    if (w) bySource.set(w.source, [...(bySource.get(w.source) ?? []), id]);
  }
  const sources = [...bySource];
  const replies = await store.pipeline(sources.map(([source, fieldIds]) => [
    "HMGET",
    source === "pending" ? STATE_PREFIX + PENDING_SCOPE : bucketKey(source),
    ...fieldIds,
  ]));
  const out = new Map<string, Buffer>();
  sources.forEach(([source, fieldIds], s) => {
    const values = replies[s] as Array<Buffer | null>;
    fieldIds.forEach((id, i) => {
      const value = values[i];
      let bytes: Buffer | null = null;
      if (value !== null) {
        const row = source === "pending" ? parsePendingRow(id, value, dimensions) : parseBucketRow(id, value, dimensions);
        if ("bytes" in row) bytes = row.bytes;
      }
      if (!bytes || digestOf(bytes) !== plan.winners.get(id)!.digest) {
        throw new MigrateError(`the stored vector of ${id} changed during the migration; stop the app and run again`, 3);
      }
      out.set(id, bytes);
    });
  });
  return out;
}

// ---------------------------------------------------------------- units

interface Unit { name: string; key: string; kind: RecordKind }

async function listUnits(store: Redis, page: number): Promise<Unit[]> {
  const units: Unit[] = [{ name: MEMORIES_UNIT, key: STATE_PREFIX + KV.memories, kind: "memory" }];
  for await (const pairs of hashPages(store, STATE_PREFIX + KV.sessions, page)) {
    for (const [sessionId] of pairs) units.push({ name: `session:${sessionId}`, key: STATE_PREFIX + KV.observations(sessionId), kind: "observation" });
  }
  return units;
}

/** The indexable records of a unit, page by page, as the keyword documents the app would write. */
async function* unitDocs(store: Redis, unit: Unit, page: number, counts?: { unparsable: number }): AsyncGenerator<ReturnType<typeof docOp>[]> {
  for await (const pairs of hashPages(store, unit.key, page)) {
    const docs = [];
    for (const [, value] of pairs) {
      const row = parseJson(value);
      if (row === undefined) {
        if (counts) counts.unparsable++;
        continue;
      }
      const doc = docOfRecord(unit.kind, row);
      if (doc) docs.push(docOp(doc.obs, doc.layer));
    }
    if (docs.length > 0) yield docs;
  }
}

/**
 * fenced: documents left alone because a live write or delete is newer than
 * the migration; unparsable: records that are not JSON or lack the fields the
 * document needs; refused: image rows whose vector is not the image size.
 */
export interface UnitResult { docs: number; vectors: number; fenced: number; unparsable: number; refused: number }

const emptyResult = (): UnitResult => ({ docs: 0, vectors: 0, fenced: 0, unparsable: 0, refused: 0 });

function parseJson(value: Buffer): unknown {
  try {
    return JSON.parse(value.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The live lessons, page by page, as the keyword documents the app writes for them; deleted lessons are skipped. */
async function* lessonDocs(store: Redis, page: number, counts: Pick<UnitResult, "unparsable">): AsyncGenerator<DocOp[]> {
  for await (const pairs of hashPages(store, STATE_PREFIX + KV.lessons, page)) {
    const docs: DocOp[] = [];
    for (const [, value] of pairs) {
      const lesson = parseJson(value) as Partial<Lesson> | undefined;
      if (typeof lesson?.id !== "string" || typeof lesson.content !== "string") {
        counts.unparsable++;
        continue;
      }
      if (!lesson.deleted) docs.push(docOp(lessonToObservation(lesson as Lesson), "lesson"));
    }
    if (docs.length > 0) yield docs;
  }
}

/** The stored image embeddings, page by page, as the `img` ops the app writes; a vector that is not `dimensions` finite numbers is refused and counted. */
async function* imageOps(store: Redis, page: number, dimensions: number, counts: Pick<UnitResult, "unparsable" | "refused">): AsyncGenerator<ImgOp[]> {
  for await (const pairs of hashPages(store, STATE_PREFIX + KV.imageEmbeddings, page)) {
    const ops: ImgOp[] = [];
    for (const [imageRef, value] of pairs) {
      const row = parseJson(value) as { vector?: unknown; sessionId?: unknown; observationId?: unknown; updatedAt?: unknown } | undefined;
      if (!row || typeof row.updatedAt !== "string" || (row.sessionId !== undefined && typeof row.sessionId !== "string") ||
          (row.observationId !== undefined && typeof row.observationId !== "string")) {
        counts.unparsable++;
        continue;
      }
      const vector = row.vector;
      if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every((x) => typeof x === "number" && Number.isFinite(x))) {
        counts.refused++;
        continue;
      }
      ops.push({
        k: "img",
        id: imageRef,
        sessionId: row.sessionId ?? "",
        f32b64: float32ToBase64(Float32Array.from(vector as number[])),
        ...(row.observationId !== undefined ? { observationId: row.observationId } : {}),
        updatedAt: row.updatedAt,
      });
    }
    if (ops.length > 0) yield ops;
  }
}

/** Ids whose point does not carry `version`: a newer live write or delete kept it. */
async function notAt(qdrant: Qdrant, ids: string[], version: OpVersion): Promise<string[]> {
  const points = await qdrant.call<Array<{ payload?: { doc_id?: string; v?: unknown } }>>("POST", `${qdrant.path}/points`, {
    ids: ids.map(pointId), with_payload: ["doc_id", "v"], with_vector: false,
  });
  const held = new Set(points.flatMap(({ payload }) => (payload?.doc_id && payload.v === version ? [payload.doc_id] : [])));
  return ids.filter((id) => !held.has(id));
}

/**
 * A live write fences the migration's point out, and a reconcile pass writes
 * the document without its vector. Where the live point still holds the
 * document's rev and has no vector, the stored vector is copied onto it at
 * the point's own version, so any write after that still wins. Returns how
 * many landed.
 */
async function adoptVectors(target: Targets["docs"], docs: DocOp[], fenced: ReadonlySet<string>, vectors: Map<string, Buffer>): Promise<number> {
  const ids = docs.filter((d) => fenced.has(d.id) && vectors.has(d.id)).map((d) => d.id);
  if (ids.length === 0) return 0;
  const revs = new Map(docs.map((d) => [d.id, d.rev]));
  const points = await target.qdrant.call<Array<{ payload?: { doc_id?: string; v?: unknown; rev?: string; dense?: boolean; deleted?: boolean } }>>(
    "POST", `${target.qdrant.path}/points`, { ids: ids.map(pointId), with_payload: ["doc_id", "v", "rev", "dense", "deleted"], with_vector: false },
  );
  const byVersion = new Map<OpVersion, VecOp[]>();
  for (const { payload } of points) {
    const version = validVersion(payload?.v);
    const id = payload?.doc_id;
    if (!id || version === null || payload.deleted || payload.dense || payload.rev !== revs.get(id)) continue;
    byVersion.set(version, [...(byVersion.get(version) ?? []), { k: "vec", id, rev: revs.get(id)!, f32b64: vectors.get(id)!.toString("base64") }]);
  }
  let adopted = 0;
  for (const [version, ops] of byVersion) {
    const applied = await target.engine.apply(ops, version);
    if (applied.failed.length > 0) throw new MigrateError(`vector copy failed for ${applied.failed.length} documents, first ${JSON.stringify(applied.failed[0])}`, 3);
    adopted += applied.applied;
  }
  return adopted;
}

async function fillLessons(store: Redis, target: Targets["lessons"], version: OpVersion, page: number): Promise<UnitResult> {
  const result = emptyResult();
  for await (const docs of lessonDocs(store, page, result)) {
    const applied = await target.engine.apply(docs, version);
    if (applied.failed.length > 0) throw new MigrateError(`lessons apply failed for ${applied.failed.length} lessons, first ${JSON.stringify(applied.failed[0])}`, 3);
    const fenced = await notAt(target.qdrant, docs.map((d) => d.id), version);
    result.docs += docs.length;
    result.fenced += fenced.length;
  }
  return result;
}

async function fillImages(store: Redis, target: Targets["images"], version: OpVersion, page: number): Promise<UnitResult> {
  const result = emptyResult();
  for await (const ops of imageOps(store, page, target.qdrant.config.dimensions, result)) {
    const applied = await target.engine.apply(ops, version);
    if (applied.failed.length > 0) throw new MigrateError(`images apply failed for ${applied.failed.length} images, first ${JSON.stringify(applied.failed[0])}`, 3);
    result.vectors += applied.applied;
    result.fenced += applied.fenced.length;
  }
  return result;
}

// ---------------------------------------------------------------- fill

export interface FillOptions {
  page: number;
  dimensions: number;
  allowNonempty: boolean;
  log: (line: string) => void;
}

export interface FillResult {
  version: OpVersion;
  plan: PlanReport;
  units: number;
  skipped: number;
  written: UnitResult;
}

interface Meta { version: OpVersion; startedAt: string; avgdl: number | null }

async function readMeta(store: Redis): Promise<Meta | null> {
  const raw = await store.call("HGET", MARKER_KEY, META_FIELD);
  if (raw === null) return null;
  try {
    const meta = JSON.parse(str(raw)) as { version?: unknown; startedAt?: unknown; avgdl?: unknown };
    if (typeof meta.version === "number" && meta.version === MIGRATION_VERSION && (meta.avgdl === null || typeof meta.avgdl === "number")) {
      return meta as Meta;
    }
  } catch {
    // reported below
  }
  throw new MigrateError(`${MARKER_KEY} ${META_FIELD} is corrupt or from a release with another migration version; remove ${MARKER_KEY} and the collections to start over`, 3);
}

async function addEmbeddingCalls(store: Redis, calls: number): Promise<void> {
  const previous = Number(str((await store.call("HGET", MARKER_KEY, CALLS_FIELD)) ?? Buffer.from("0")));
  await store.call("HSET", MARKER_KEY, CALLS_FIELD, String(previous + calls));
}

export async function fill(store: Redis, targets: Targets, options: FillOptions): Promise<FillResult> {
  const { engine, qdrant } = targets.docs;
  let meta = await readMeta(store);
  if (!meta) {
    const live = (await engine.stats()).docs;
    if (live > 0 && !options.allowNonempty) {
      throw new MigrateError(`the collection already holds ${live} documents and no migration started here; pass --allow-nonempty to migrate into it`, 3);
    }
    meta = { version: MIGRATION_VERSION, startedAt: new Date().toISOString(), avgdl: await corpusMeanLength(store, options.page) };
    options.log(`mean document length ${meta.avgdl}`);
    await store.call("HSET", MARKER_KEY, META_FIELD, JSON.stringify({ ...meta, model: STORED_VECTOR_MODEL, collection: qdrant.config.collection }));
  }
  const plan = await planVectors(store, options.dimensions, options.page);
  options.log(`plan ${JSON.stringify(plan.report)}`);
  await store.call("HSET", MARKER_KEY, "plan", JSON.stringify(plan.report));

  const units = await listUnits(store, options.page);
  const done = new Set<string>();
  const states = await Promise.all(chunk(units, 256).map((part) => store.pipeline([["HMGET", MARKER_KEY, ...part.map((u) => UNIT_PREFIX + u.name)]])));
  states.forEach(([values], c) => (values as Array<Buffer | null>).forEach((v, i) => v !== null && done.add(units[c * 256 + i]!.name)));

  const written = emptyResult();
  const add = (result: UnitResult) => {
    for (const key of Object.keys(written) as Array<keyof UnitResult>) written[key] += result[key];
  };
  let finished = 0;
  for (const unit of units) {
    if (done.has(unit.name)) continue;
    const result = emptyResult();
    for await (const docs of unitDocs(store, unit, options.page, result)) {
      const vectors = await readVectors(store, plan, docs.map((d) => d.id), options.dimensions);
      const loaded = await engine.load(docs.map((doc) => ({ doc, f32b64: vectors.get(doc.id)?.toString("base64") })), meta.version, meta.avgdl ?? undefined);
      if (loaded.failed.length > 0) throw new MigrateError(`load failed for ${loaded.failed.length} documents, first ${JSON.stringify(loaded.failed[0])}`, 3);
      const kept = new Set(loaded.fenced);
      result.docs += docs.length;
      result.vectors += [...vectors.keys()].filter((id) => !kept.has(id)).length + await adoptVectors(targets.docs, docs, kept, vectors);
      result.fenced += kept.size;
    }
    await store.call("HSET", MARKER_KEY, UNIT_PREFIX + unit.name, JSON.stringify(result));
    add(result);
    if (++finished % 50 === 0) options.log(`${finished} units this run, ${written.docs} docs, ${written.vectors} vectors`);
  }
  let skipped = done.size;
  for (const [name, run] of [
    [LESSONS_UNIT, () => fillLessons(store, targets.lessons, meta.version, options.page)],
    [IMAGES_UNIT, () => fillImages(store, targets.images, meta.version, options.page)],
  ] as const) {
    if ((await store.call("HEXISTS", MARKER_KEY, UNIT_PREFIX + name)) === 1) {
      skipped++;
      continue;
    }
    const result = await run();
    await store.call("HSET", MARKER_KEY, UNIT_PREFIX + name, JSON.stringify(result));
    options.log(`${name} ${JSON.stringify(result)}`);
    add(result);
  }
  return { version: meta.version, plan: plan.report, units: units.length + 2, skipped, written };
}

/**
 * The mean term count of every document the fill will write, so each is
 * weighted with the corpus's own BM25 mean from the first write, and the
 * worker finds nothing to reweight. Taken once and kept in the marker, so a
 * resumed run weights with the same mean.
 */
async function corpusMeanLength(store: Redis, page: number): Promise<number | null> {
  let docs = 0;
  let terms = 0;
  for (const unit of await listUnits(store, page)) {
    for await (const batch of unitDocs(store, unit, page)) {
      for (const doc of batch) {
        docs++;
        terms += extractTerms(doc.fields).length;
      }
    }
  }
  return docs > 0 && terms > 0 ? terms / docs : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- verify

/** Round to the nearest IEEE half (ties to even), as Qdrant stores a float16 vector. */
export function f16round(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (a >= 65520) return sign * Infinity;
  const exp = Math.max(Math.floor(Math.log2(a)), -14);
  const ulp = 2 ** (exp - 10);
  const q = a / ulp;
  const floor = Math.floor(q);
  const rest = q - floor;
  const n = rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
  return sign * n * ulp;
}

/** What Qdrant should hold for a stored vector under Cosine distance and float16: the unit vector, rounded. */
export function expectedStored(bytes: Buffer): number[] {
  const v = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return Array.from(v, (x) => f16round(Math.fround(x / norm)));
}

/** The units of the last place two half-precision values differ by; 0 means bit-equal. */
function halfSteps(a: number, b: number): number {
  if (a === b) return 0;
  const exp = Math.max(Math.floor(Math.log2(Math.max(Math.abs(a), Math.abs(b)))), -14);
  return Math.abs(a - b) / 2 ** (exp - 10);
}

export const isSampled = (id: string, rate: number) => createHash("sha1").update(id).digest().readUInt32BE(0) % rate === 0;

export interface VerifyResult {
  ok: boolean;
  lines: string[];
}

export async function verify(store: Redis, targets: Targets, options: { page: number; dimensions: number; rate: number; guard: FetchGuard }): Promise<VerifyResult> {
  const { engine, qdrant } = targets.docs;
  const lines: string[] = [];
  const problems: string[] = [];
  const meta = await readMeta(store);
  if (!meta) throw new MigrateError(`no migration has started here (${MARKER_KEY} is missing)`, 3);
  const plan = await planVectors(store, options.dimensions, options.page);
  const units = await listUnits(store, options.page);

  const expected = { observation: 0, memory: 0, vectors: 0, orphanVectors: 0, docsWithoutVector: 0 };
  const perSession = new Map<string, number>();
  const sample: Array<{ id: string; rev: string; bytes?: Buffer }> = [];
  const matched = new Set<string>();
  let unfinished = 0;
  for (const name of [...units.map((u) => u.name), LESSONS_UNIT, IMAGES_UNIT]) {
    if ((await store.call("HEXISTS", MARKER_KEY, UNIT_PREFIX + name)) !== 1) unfinished++;
  }
  for (const unit of units) {
    for await (const docs of unitDocs(store, unit, options.page)) {
      const sampled = docs.filter((d) => isSampled(d.id, options.rate));
      const bytes = sampled.length > 0 ? await readVectors(store, plan, sampled.map((d) => d.id), options.dimensions) : new Map();
      for (const d of docs) {
        expected[d.layer === "memory" ? "memory" : "observation"]++;
        if (d.layer === "observation") perSession.set(d.sessionId, (perSession.get(d.sessionId) ?? 0) + 1);
        if (plan.winners.has(d.id)) {
          expected.vectors++;
          matched.add(d.id);
        } else expected.docsWithoutVector++;
      }
      for (const d of sampled) sample.push({ id: d.id, rev: d.rev, bytes: bytes.get(d.id) });
    }
  }
  expected.orphanVectors = plan.winners.size - matched.size;

  const live = { must_not: [{ key: "deleted", match: { value: true } }] };
  const layer = (value: string) => ({ ...live, must: [{ key: "layer", match: { value } }] });
  const [observations, memories, dense, stats, counts] = await Promise.all([
    qdrant.count(layer("observation")),
    qdrant.count(layer("memory")),
    qdrant.count({ ...live, must: [{ key: "dense", match: { value: true } }] }),
    engine.stats(),
    engine.sessionCounts(),
  ]);
  const actualPerSession = new Map(counts);
  let sessionMismatches = 0;
  for (const id of new Set([...perSession.keys(), ...actualPerSession.keys()])) {
    if ((perSession.get(id) ?? 0) !== (actualPerSession.get(id) ?? 0)) sessionMismatches++;
  }

  let vectorMismatches = 0;
  let revMismatches = 0;
  let offByOneHalfStep = 0;
  const source = createHash("sha256");
  const target = createHash("sha256");
  for (const part of chunk(sample.sort((a, b) => (a.id < b.id ? -1 : 1)), 64)) {
    const points = await qdrant.call<Array<{ id: string; payload?: { doc_id?: string; rev?: string; dense?: boolean }; vector?: { dense?: number[] } }>>(
      "POST", `${qdrant.path}/points`, { ids: part.map((s) => pointId(s.id)), with_payload: ["doc_id", "rev", "dense"], with_vector: ["dense"] },
    );
    const byId = new Map(points.map((p) => [p.payload?.doc_id ?? "", p]));
    for (const s of part) {
      const point = byId.get(s.id);
      if (point?.payload?.rev !== s.rev) revMismatches++;
      // Qdrant returns its float16 values as short decimals; snap them back to the grid.
      const stored = point?.vector?.dense?.map(f16round);
      if (!s.bytes) {
        if (stored) vectorMismatches++;
        continue;
      }
      const want = expectedStored(s.bytes);
      source.update(s.id).update(Buffer.from(Float32Array.from(want).buffer));
      if (!stored || stored.length !== want.length) {
        vectorMismatches++;
        continue;
      }
      target.update(s.id).update(Buffer.from(Float32Array.from(stored).buffer));
      let worst = 0;
      for (let i = 0; i < want.length; i++) worst = Math.max(worst, halfSteps(want[i]!, stored[i]!));
      if (worst > 1) vectorMismatches++;
      else if (worst === 1) offByOneHalfStep++;
    }
  }
  const lessons = await verifyLessons(store, targets.lessons, options.page);
  const images = await verifyImages(store, targets.images, options.page);
  const calls = Number(str((await store.call("HGET", MARKER_KEY, CALLS_FIELD)) ?? Buffer.from("0"))) + options.guard.refused;
  const vectorSample = sample.filter((s) => s.bytes).length;
  const sourceDigest = source.digest("hex").slice(0, 16);
  const targetDigest = target.digest("hex").slice(0, 16);

  const check = (name: string, ok: boolean, detail: string) => {
    lines.push(`${ok ? "OK  " : "FAIL"} ${name}: ${detail}`);
    if (!ok) problems.push(name);
  };
  lines.push(`plan ${JSON.stringify(plan.report)}`);
  lines.push(`model ${JSON.stringify(STORED_VECTOR_MODEL)}; version ${meta.version} (started ${meta.startedAt})`);
  check("units", unfinished === 0, `${units.length + 2 - unfinished}/${units.length + 2} finished`);
  check("observations", observations === expected.observation, `store ${expected.observation} index ${observations}`);
  check("memories", memories === expected.memory, `store ${expected.memory} index ${memories}`);
  check("sessions", sessionMismatches === 0, `${perSession.size} sessions with documents, ${sessionMismatches} with a different count`);
  check("vectors", dense === expected.vectors, `stored-and-indexable ${expected.vectors} index ${dense}; ${expected.orphanVectors} stored vectors have no indexable record, ${expected.docsWithoutVector} documents have no stored vector (missingVectors ${stats.missingVectors})`);
  check("sampled keyword revs", revMismatches === 0, `${sample.length} sampled, ${revMismatches} differ`);
  check("sampled vectors", vectorMismatches === 0,
    `${vectorSample} sampled, ${vectorMismatches} differ, ${offByOneHalfStep} within one float16 step; checksum store ${sourceDigest} index ${targetDigest}`);
  check("lessons", lessons.store === lessons.index, `store ${lessons.store} index ${lessons.index}; ${lessons.unparsable} records unreadable`);
  check("lesson revs", lessons.differ === 0,
    `${lessons.checked} checked, ${lessons.differ} differ; checksum store ${lessons.storeDigest} index ${lessons.indexDigest}`);
  check("images", images.store === images.index, `store ${images.store} index ${images.index}; ${images.refused} refused (not ${targets.images.qdrant.config.dimensions} floats), ${images.unparsable} unreadable`);
  check("image vectors", images.differ === 0,
    `${images.checked} checked, ${images.differ} differ; checksum store ${images.storeDigest} index ${images.indexDigest}`);
  check("embedding calls", calls === 0, `${calls}`);
  return { ok: problems.length === 0, lines };
}

interface CollectionCheck {
  store: number;
  index: number;
  checked: number;
  differ: number;
  unparsable: number;
  refused: number;
  storeDigest: string;
  indexDigest: string;
}

const LIVE = { must_not: [{ key: "deleted", match: { value: true } }] };

async function liveCount(qdrant: Qdrant): Promise<number> {
  return (await qdrant.exists()) ? qdrant.count(LIVE) : 0;
}

type StoredPoint = { payload?: Record<string, unknown>; vector?: Record<string, number[]> };

/** The points of ids by doc id; absent ids and tombstones are missing. */
async function livePoints(qdrant: Qdrant, ids: string[], payload: string[], vector: string[] | false): Promise<Map<string, StoredPoint>> {
  if (ids.length === 0 || !(await qdrant.exists())) return new Map();
  const points = await qdrant.call<StoredPoint[]>("POST", `${qdrant.path}/points`, {
    ids: ids.map(pointId), with_payload: ["doc_id", "deleted", ...payload], with_vector: vector,
  });
  return new Map(points.filter((p) => p.payload?.deleted !== true).map((p) => [String(p.payload?.doc_id ?? ""), p]));
}

const digest = (hash: ReturnType<typeof createHash>) => hash.digest("hex").slice(0, 16);

/**
 * Every live lesson against its point: the count, and each lesson's rev,
 * page by page. Lessons number in the hundreds, so all are checked.
 */
async function verifyLessons(store: Redis, target: Targets["lessons"], page: number): Promise<CollectionCheck> {
  const result: CollectionCheck = { store: 0, index: 0, checked: 0, differ: 0, unparsable: 0, refused: 0, storeDigest: "", indexDigest: "" };
  const source = createHash("sha256");
  const indexed = createHash("sha256");
  for await (const docs of lessonDocs(store, page, result)) {
    const points = await livePoints(target.qdrant, docs.map((d) => d.id), ["rev", "layer"], false);
    for (const doc of docs) {
      const point = points.get(doc.id)?.payload;
      source.update(`${doc.id}\0${doc.rev}\0`);
      indexed.update(`${doc.id}\0${String(point?.rev)}\0`);
      if (point?.rev !== doc.rev || point?.layer !== "lesson") result.differ++;
    }
    result.store += docs.length;
    result.checked += docs.length;
  }
  result.index = await liveCount(target.qdrant);
  result.storeDigest = digest(source);
  result.indexDigest = digest(indexed);
  return result;
}

/** A float32 vector as Qdrant keeps it under Cosine distance: scaled to unit length. */
function unitVector(f32b64: string): Float32Array {
  const v = base64ToFloat32(f32b64);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? Float32Array.from(v) : Float32Array.from(v, (x) => x / norm);
}

/** Two float32 values one rounding apart: Qdrant normalises in float32, this side in double. */
const IMAGE_TOLERANCE = 1e-6;

/**
 * Every stored image against its point: the count, and each image's unit
 * vector (within IMAGE_TOLERANCE per component) and metadata. Checked page by
 * page, so no more than a page of vectors is held.
 */
async function verifyImages(store: Redis, target: Targets["images"], page: number): Promise<CollectionCheck> {
  const result: CollectionCheck = { store: 0, index: 0, checked: 0, differ: 0, unparsable: 0, refused: 0, storeDigest: "", indexDigest: "" };
  const source = createHash("sha256");
  const indexed = createHash("sha256");
  for await (const ops of imageOps(store, page, target.qdrant.config.dimensions, result)) {
    const points = await livePoints(target.qdrant, ops.map((o) => o.id), ["session_id", "observation_id", "updated_at"], ["image"]);
    for (const op of ops) {
      const point = points.get(op.id);
      const want = unitVector(op.f32b64);
      // Qdrant's float32 normalisation is not reproducible bit for bit, so a stored component within one rounding counts as the store's value.
      const stored = point?.vector?.image;
      const snapped = stored && stored.length === want.length ? Float32Array.from(stored, (x, i) => (Math.abs(x - want[i]!) <= IMAGE_TOLERANCE ? want[i]! : x)) : null;
      const fields = (sessionId: unknown, observationId: unknown, updatedAt: unknown) => `${op.id}\0${String(sessionId ?? "")}\0${String(observationId ?? "")}\0${String(updatedAt)}\0`;
      source.update(fields(op.sessionId, op.observationId, op.updatedAt)).update(Buffer.from(want.buffer));
      if (snapped) indexed.update(fields(point!.payload?.session_id, point!.payload?.observation_id, point!.payload?.updated_at)).update(Buffer.from(snapped.buffer));
      const same = snapped !== null && snapped.every((x, i) => x === want[i]) &&
        point!.payload?.session_id === op.sessionId && point!.payload?.observation_id === op.observationId && point!.payload?.updated_at === op.updatedAt;
      if (!same) result.differ++;
    }
    result.store += ops.length;
    result.checked += ops.length;
  }
  result.index = await liveCount(target.qdrant);
  result.storeDigest = digest(source);
  result.indexDigest = digest(indexed);
  return result;
}

// ---------------------------------------------------------------- CLI

async function status(store: Redis, page: number): Promise<string[]> {
  const meta = await store.call("HGET", MARKER_KEY, META_FIELD);
  const plan = await store.call("HGET", MARKER_KEY, "plan");
  const calls = await store.call("HGET", MARKER_KEY, CALLS_FIELD);
  const units = [...(await listUnits(store, page)).map((u) => u.name), LESSONS_UNIT, IMAGES_UNIT];
  let done = 0;
  for (const part of chunk(units, 256)) {
    const values = (await store.call("HMGET", MARKER_KEY, ...part.map((name) => UNIT_PREFIX + name))) as Array<Buffer | null>;
    done += values.filter((v) => v !== null).length;
  }
  return [
    `meta ${meta === null ? "none" : str(meta)}`,
    `plan ${plan === null ? "none" : str(plan)}`,
    `units done ${done} pending ${units.length - done}`,
    `embedding calls ${calls === null ? 0 : str(calls)}`,
  ];
}

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: "string", default: "200" },
      rate: { type: "string", default: "64" },
      "allow-nonempty": { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  const storeUrl = process.env.MIGRATE_STORE_URL;
  const page = Number(args.page);
  const rate = Number(args.rate);
  if (!["fill", "verify", "status"].includes(command ?? "") || !storeUrl || !process.env.AM_QDRANT_URL ||
      !Number.isInteger(page) || page < 1 || !Number.isInteger(rate) || rate < 1) {
    console.error("usage: MIGRATE_STORE_URL=redis://... AM_QDRANT_URL=http://... [AM_QDRANT_API_KEY=...] search-migrate.ts fill|verify|status [--page 200] [--rate 64] [--allow-nonempty]");
    return 2;
  }
  const log = (line: string) => console.error(`search-migrate: ${line}`);
  // The worker's own settings, so the migration writes exactly the collections, sizes and names the worker reads.
  const settings = loadSearchWorkerSettings(process.env);
  const { dimensions, qdrantUrl } = settings;
  const guard = new FetchGuard(new URL(qdrantUrl).origin).install();
  const qdrantOf = (id: "docs" | "lessons" | "images", size: number, layout?: "lessons" | "image") => new Qdrant({
    url: qdrantUrl,
    apiKey: settings.qdrantApiKey,
    collection: settings.collections[id],
    dimensions: size,
    oversampling: settings.oversampling,
    timeoutMs: 120_000,
    layout,
  });
  const docs = qdrantOf("docs", dimensions);
  const lessons = qdrantOf("lessons", dimensions, "lessons");
  const images = qdrantOf("images", settings.imageDimensions, "image");
  const targets: Targets = {
    docs: { qdrant: docs, engine: new SearchEngine(docs, DEFAULT_AVGDL) },
    lessons: { qdrant: lessons, engine: new SearchEngine(lessons, DEFAULT_AVGDL) },
    images: { qdrant: images, engine: new ImageEngine(images) },
  };
  log(`${command} ${redactUrl(storeUrl)} -> ${qdrantUrl}/collections/${settings.collection}{,_lessons,_images}`);
  const store = await connectRedis(storeUrl);
  const started = Date.now();
  try {
    if (command === "status") {
      for (const line of await status(store, page)) console.log(line);
      return 0;
    }
    if (command === "fill") {
      const r = await fill(store, targets, { page, dimensions, allowNonempty: args["allow-nonempty"], log });
      log(`fill wrote ${r.units - r.skipped} units (${r.skipped} already done): ${r.written.docs} docs, ${r.written.vectors} vectors, ${r.written.fenced} documents left as a newer live write had them, ${r.written.unparsable} records unreadable, ${r.written.refused} image vectors refused; ${((Date.now() - started) / 1000).toFixed(1)} s`);
      const settling = Date.now();
      await targets.docs.engine.settled();
      log(`keyword weights settled in ${((Date.now() - settling) / 1000).toFixed(1)} s`);
      return 0;
    }
    const result = await verify(store, targets, { page, dimensions, rate, guard });
    console.log(`VERIFY ${result.ok ? "OK" : "FAIL"}`);
    for (const line of result.lines) console.log(line);
    log(`verify took ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return result.ok ? 0 : 1;
  } finally {
    if (guard.refused > 0) await addEmbeddingCalls(store, guard.refused).catch(() => undefined);
    store.close();
    guard.uninstall();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`search-migrate: ${(error as Error).message}`);
    process.exit(error instanceof MigrateError ? error.exitCode : 2);
  });
}

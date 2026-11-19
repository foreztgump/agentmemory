// Copies an agentmemory store from Valkey to Kvrocks at the Redis key level, and
// verifies the copy. iii's redis state adapter keeps one hash per scope
// (`state:<scope>`, field = state key, value = JSON), so a byte-for-byte copy of
// every hash is a copy of every record, memory, lesson, session, graph item and
// persisted vector.
//
//   MIGRATE_SOURCE_URL=redis://valkey:6379 MIGRATE_TARGET_URL=redis://:<password>@kvrocks:6666 \
//     node --import tsx scripts/fork/kvrocks-migrate.ts copy|verify|status [--page 200] [--rate 32] [--full]
//
// copy    Pages every source hash with HSCAN and writes each page with HSET. It
//         never reads a whole hash (no HGETALL, HKEYS or HVALS). After each page
//         it records the next HSCAN cursor in the target's `fork:migrate` hash, so
//         a killed run resumes where it stopped. Re-writing a field with the same
//         bytes changes nothing, so a replayed page cannot duplicate anything. It
//         refuses a target that holds keys and no `fork:migrate` hash.
// verify  Compares the key sets, every hash's field count, and a deterministic
//         sample of values (fields whose hash falls in 1 of --rate buckets, every
//         field of a hash with at most 64 fields, or every field with --full).
//         Prints per-collection counts and sampled checksums; exits 1 on any
//         difference. Values are never printed.
// status  Prints how many hashes the copy has finished.
//
// The source must not change during the copy (capture paused, or a snapshot).
// A source restart invalidates HSCAN cursors, so unfinished hashes restart from
// cursor 0 when the source's run_id differs from the one recorded.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { connectRedis, redactUrl, type Arg, type Redis, type Reply } from "./lib/resp.js";

export const MARKER_KEY = "fork:migrate";
const META_FIELD = "meta";
const CURSOR_PREFIX = "cursor:";
const DONE = "done";
const SMALL_HASH_FIELDS = 64;

export class MigrateError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

export interface CopyOptions {
  page: number;
  batchBytes: number;
  log: (line: string) => void;
}

export interface VerifyOptions {
  page: number;
  rate: number;
  full: boolean;
}

const str = (reply: Reply): string => (Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply));
const bytes = (reply: Reply): Buffer => {
  if (!Buffer.isBuffer(reply)) throw new MigrateError(`expected a bulk string, got ${JSON.stringify(reply)}`, 2);
  return reply;
};

/** The collection family a key belongs to, with per-session, shard and bucket ids collapsed. */
export function family(key: string): string {
  const scope = key.startsWith("state:") ? key.slice(6) : key;
  const rules: Array<[RegExp, string]> = [
    [/^mem:obs:.+/, "mem:obs:<session>"],
    [/^mem:enriched:.+/, "mem:enriched:<session>"],
    [/^mem:latent:.+/, "mem:latent:<obs>"],
    [/^mem:team:[^:]+:(shared|profile)$/, "mem:team:<team>:$1"],
    [/^mem:team:[^:]+:users:.+/, "mem:team:<team>:users:<user>"],
    [/^mem:index:bm25:vec:\d+$/, "mem:index:bm25:vec:<bucket>"],
    [/^mem:idx:obs:\d+$/, "mem:idx:obs:<shard>"],
    [/^mem:capture:events:.+/, "mem:capture:events:<shard>"],
    [/^mem:audit:\d{4}-\d{2}$/, "mem:audit:<month>"],
    [/^mem:emb:.+/, "mem:emb:<obs>"],
  ];
  for (const [pattern, name] of rules) if (pattern.test(scope)) return scope.replace(pattern, name);
  return key.startsWith("state:") ? scope : key;
}

async function scanKeys(redis: Redis, page: number): Promise<string[]> {
  const keys = new Set<string>();
  let cursor = "0";
  do {
    const [next, batch] = (await redis.call("SCAN", cursor, "COUNT", String(page))) as [Buffer, Buffer[]];
    cursor = str(next);
    for (const key of batch) {
      const text = key.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(key)) throw new MigrateError(`key ${JSON.stringify(text)} is not valid UTF-8; the iii redis adapter writes text keys`, 2);
      keys.add(text);
    }
  } while (cursor !== "0");
  return [...keys].sort();
}

/** Every key in the source, checked to be a hash without a TTL (the iii redis adapter's layout). */
export async function listCollections(source: Redis, page: number): Promise<string[]> {
  const keys = await scanKeys(source, page * 5);
  for (let i = 0; i < keys.length; i += 256) {
    const slice = keys.slice(i, i + 256);
    const replies = await source.pipeline(slice.flatMap((k) => [["TYPE", k], ["PTTL", k]]));
    slice.forEach((key, j) => {
      const type = str(replies[2 * j]!);
      const ttl = replies[2 * j + 1] as number;
      if (type !== "hash") throw new MigrateError(`source key ${key} is a ${type}, not a hash; the iii redis adapter layout changed`, 2);
      if (ttl !== -1) throw new MigrateError(`source key ${key} has a TTL (${ttl} ms); the iii redis adapter sets none`, 2);
    });
  }
  return keys;
}

async function sourceRunId(source: Redis): Promise<string> {
  const info = str(await source.call("INFO", "server"));
  return /run_id:(\S+)/.exec(info)?.[1] ?? "unknown";
}

async function targetHasKeys(target: Redis): Promise<string[]> {
  let cursor = "0";
  do {
    const [next, batch] = (await target.call("SCAN", cursor, "COUNT", "100")) as [Buffer, Buffer[]];
    cursor = str(next);
    if (batch.length) return batch.slice(0, 10).map((k) => k.toString("utf8"));
  } while (cursor !== "0");
  return [];
}

/** Splits flat field/value pairs into HSET argument lists of at most batchBytes each (one oversized pair goes alone). */
export function batches(pairs: Buffer[], batchBytes: number): Buffer[][] {
  const out: Buffer[][] = [];
  let current: Buffer[] = [];
  let size = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const pairSize = pairs[i]!.length + pairs[i + 1]!.length;
    if (current.length && size + pairSize > batchBytes) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(pairs[i]!, pairs[i + 1]!);
    size += pairSize;
  }
  if (current.length) out.push(current);
  return out;
}

export async function copy(source: Redis, target: Redis, options: CopyOptions): Promise<{ collections: number; fields: number; skipped: number }> {
  const metaRaw = await target.call("HGET", MARKER_KEY, META_FIELD);
  const runId = await sourceRunId(source);
  let resetCursors = false;
  if (metaRaw === null) {
    const present = await targetHasKeys(target);
    if (present.length) throw new MigrateError(`target is not empty and has no ${MARKER_KEY} hash (keys: ${present.join(", ")}); use a fresh Kvrocks volume`, 3);
  } else {
    let meta: { sourceRunId: string };
    try {
      meta = JSON.parse(str(metaRaw)) as { sourceRunId: string };
    } catch {
      throw new MigrateError(`${MARKER_KEY} field ${META_FIELD} is not JSON; delete the target volume and copy again`, 3);
    }
    resetCursors = meta.sourceRunId !== runId;
    if (resetCursors) options.log(`source restarted since the last run (run_id changed); unfinished hashes restart from cursor 0`);
  }
  const keys = await listCollections(source, options.page);
  await target.call("HSET", MARKER_KEY, META_FIELD, JSON.stringify({ sourceRunId: runId, collections: keys.length, at: new Date().toISOString() }));

  const states = (await target.pipeline(keys.map((k) => ["HGET", MARKER_KEY, CURSOR_PREFIX + k]))).map((r) => (r === null ? null : str(r)));
  let fields = 0;
  let skipped = 0;
  let done = 0;
  for (const [i, key] of keys.entries()) {
    const state = states[i];
    if (state === DONE) {
      skipped++;
      continue;
    }
    let cursor = state && !resetCursors ? state : "0";
    do {
      const [next, pairs] = (await source.call("HSCAN", key, cursor, "COUNT", String(options.page))) as [Buffer, Buffer[]];
      cursor = str(next);
      const writes: Arg[][] = batches(pairs, options.batchBytes).map((batch) => ["HSET", key, ...batch]);
      if (writes.length) await target.pipeline(writes);
      fields += pairs.length / 2;
      await target.call("HSET", MARKER_KEY, CURSOR_PREFIX + key, cursor === "0" ? DONE : cursor);
    } while (cursor !== "0");
    if (++done % 250 === 0) options.log(`copied ${done + skipped}/${keys.length} hashes, ${fields} fields this run`);
  }
  return { collections: keys.length, fields, skipped };
}

export async function status(target: Redis, keys: string[]): Promise<{ done: number; started: number; pending: number }> {
  const states: Reply[] = [];
  for (let i = 0; i < keys.length; i += 256) {
    states.push(...(await target.pipeline(keys.slice(i, i + 256).map((k) => ["HGET", MARKER_KEY, CURSOR_PREFIX + k]))));
  }
  const done = states.filter((s) => s !== null && str(s) === DONE).length;
  const started = states.filter((s) => s !== null && str(s) !== DONE).length;
  return { done, started, pending: keys.length - done - started };
}

function tupleDigest(key: string, field: Buffer, value: Buffer | null): Buffer {
  const hash = createHash("sha256");
  for (const part of [Buffer.from(key), field, value]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part === null ? 0xffffffff : part.length);
    hash.update(length);
    if (part) hash.update(part);
  }
  return hash.digest();
}

/** Deterministic sample: the same fields are picked on every run, independent of scan order. */
export function isSampled(key: string, field: Buffer, rate: number): boolean {
  if (rate <= 1) return true;
  const h = createHash("sha256").update(key).update("\0").update(field).digest();
  return h.readUInt32BE(0) % rate === 0;
}

const xorInto = (acc: Buffer, digest: Buffer) => {
  for (let i = 0; i < acc.length; i++) acc[i]! ^= digest[i]!;
};

export interface FamilyResult {
  family: string;
  sourceKeys: number;
  targetKeys: number;
  sourceFields: number;
  targetFields: number;
  sampled: number;
  sourceChecksum: string;
  targetChecksum: string;
  ok: boolean;
}

export interface VerifyResult {
  ok: boolean;
  families: FamilyResult[];
  missingKeys: string[];
  extraKeys: string[];
  countMismatches: string[];
  valueMismatches: number;
  incomplete: number;
}

export async function verify(source: Redis, target: Redis, options: VerifyOptions): Promise<VerifyResult> {
  const sourceKeys = await listCollections(source, options.page);
  const targetKeys = (await scanKeys(target, options.page * 5)).filter((k) => k !== MARKER_KEY);
  const targetSet = new Set(targetKeys);
  const sourceSet = new Set(sourceKeys);
  const missingKeys = sourceKeys.filter((k) => !targetSet.has(k));
  const extraKeys = targetKeys.filter((k) => !sourceSet.has(k));
  const progress = await status(target, sourceKeys);

  const byFamily = new Map<string, { r: FamilyResult; src: Buffer; dst: Buffer }>();
  const entry = (key: string) => {
    const name = family(key);
    let e = byFamily.get(name);
    if (!e) {
      e = { r: { family: name, sourceKeys: 0, targetKeys: 0, sourceFields: 0, targetFields: 0, sampled: 0, sourceChecksum: "", targetChecksum: "", ok: true }, src: Buffer.alloc(32), dst: Buffer.alloc(32) };
      byFamily.set(name, e);
    }
    return e;
  };
  for (const key of extraKeys) {
    const e = entry(key);
    e.r.targetKeys++;
    e.r.targetFields += (await target.call("HLEN", key)) as number;
    e.r.ok = false;
  }

  const countMismatches: string[] = [];
  let valueMismatches = 0;
  for (const key of sourceKeys) {
    const e = entry(key);
    const [srcLen, dstLen] = [(await source.call("HLEN", key)) as number, (await target.call("HLEN", key)) as number];
    e.r.sourceKeys++;
    e.r.sourceFields += srcLen;
    if (targetSet.has(key)) {
      e.r.targetKeys++;
      e.r.targetFields += dstLen;
    }
    if (srcLen !== dstLen) {
      countMismatches.push(`${key}: source ${srcLen}, target ${dstLen}`);
      e.r.ok = false;
    }
    const rate = options.full || srcLen <= SMALL_HASH_FIELDS ? 1 : options.rate;
    let cursor = "0";
    do {
      const [next, pairs] = (await source.call("HSCAN", key, cursor, "COUNT", String(options.page))) as [Buffer, Buffer[]];
      cursor = str(next);
      const picked: Array<[Buffer, Buffer]> = [];
      for (let i = 0; i < pairs.length; i += 2) if (isSampled(key, pairs[i]!, rate)) picked.push([pairs[i]!, pairs[i + 1]!]);
      for (let i = 0; i < picked.length; i += 256) {
        const slice = picked.slice(i, i + 256);
        const values = (await target.call("HMGET", key, ...slice.map(([f]) => f))) as Array<Buffer | null>;
        slice.forEach(([field, value], j) => {
          const got = values[j] ?? null;
          xorInto(e.src, tupleDigest(key, field, value));
          xorInto(e.dst, tupleDigest(key, field, got));
          e.r.sampled++;
          if (got === null || !got.equals(value)) {
            valueMismatches++;
            e.r.ok = false;
          }
        });
      }
    } while (cursor !== "0");
  }

  const families = [...byFamily.values()].map(({ r, src, dst }) => {
    r.sourceChecksum = src.toString("hex").slice(0, 16);
    r.targetChecksum = dst.toString("hex").slice(0, 16);
    r.ok &&= r.sourceKeys === r.targetKeys && r.sourceFields === r.targetFields && r.sourceChecksum === r.targetChecksum;
    return r;
  }).sort((a, b) => a.family.localeCompare(b.family));
  const incomplete = progress.started + progress.pending;
  const ok = incomplete === 0 && !missingKeys.length && !extraKeys.length && !countMismatches.length && !valueMismatches && families.every((f) => f.ok);
  return { ok, families, missingKeys, extraKeys, countMismatches, valueMismatches, incomplete };
}

function printVerify(result: VerifyResult): void {
  const header = ["collection", "keys src/dst", "records src/dst", "sampled", "checksum src", "checksum dst", ""];
  const rows = result.families.map((f) => [
    f.family, `${f.sourceKeys}/${f.targetKeys}`, `${f.sourceFields}/${f.targetFields}`, String(f.sampled), f.sourceChecksum, f.targetChecksum, f.ok ? "OK" : "DIFF",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  for (const row of [header, ...rows]) console.log(row.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
  const t = result.families.reduce((a, f) => ({ keys: a.keys + f.sourceKeys, src: a.src + f.sourceFields, dst: a.dst + f.targetFields, sampled: a.sampled + f.sampled }), { keys: 0, src: 0, dst: 0, sampled: 0 });
  for (const k of result.missingKeys.slice(0, 20)) console.log(`missing at target: ${k}`);
  for (const k of result.extraKeys.slice(0, 20)) console.log(`only at target: ${k}`);
  for (const m of result.countMismatches.slice(0, 20)) console.log(`count differs: ${m}`);
  if (result.incomplete) console.log(`copy has not finished: ${result.incomplete} hashes are not marked done`);
  console.log(`VERIFY ${result.ok ? "OK" : "FAIL"} collections=${t.keys} records src=${t.src} dst=${t.dst} sampled=${t.sampled} value-mismatches=${result.valueMismatches} missing=${result.missingKeys.length} extra=${result.extraKeys.length} count-mismatches=${result.countMismatches.length}`);
}

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: "string", default: "200" },
      "batch-bytes": { type: "string", default: String(4 * 1024 * 1024) },
      rate: { type: "string", default: "32" },
      full: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  const sourceUrl = process.env.MIGRATE_SOURCE_URL;
  const targetUrl = process.env.MIGRATE_TARGET_URL;
  const page = Number(args.page);
  const batchBytes = Number(args["batch-bytes"]);
  const rate = Number(args.rate);
  if (!["copy", "verify", "status"].includes(command ?? "") || !sourceUrl || !targetUrl ||
      !Number.isInteger(page) || page < 1 || !Number.isInteger(batchBytes) || batchBytes < 1 || !Number.isInteger(rate) || rate < 1) {
    console.error("usage: MIGRATE_SOURCE_URL=redis://... MIGRATE_TARGET_URL=redis://... kvrocks-migrate.ts copy|verify|status [--page 200] [--batch-bytes N] [--rate 32] [--full]");
    return 2;
  }
  const log = (line: string) => console.error(`kvrocks-migrate: ${line}`);
  log(`${command} ${redactUrl(sourceUrl)} -> ${redactUrl(targetUrl)}`);
  const [source, target] = await Promise.all([connectRedis(sourceUrl), connectRedis(targetUrl)]);
  const started = Date.now();
  try {
    if (command === "copy") {
      const r = await copy(source, target, { page, batchBytes, log });
      log(`copy complete: ${r.collections} hashes (${r.skipped} already done), ${r.fields} fields written this run, ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return 0;
    }
    if (command === "status") {
      const s = await status(target, await listCollections(source, page));
      console.log(`done ${s.done} started ${s.started} pending ${s.pending}`);
      return s.started + s.pending ? 1 : 0;
    }
    const result = await verify(source, target, { page, rate, full: args.full });
    printVerify(result);
    log(`verify took ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return result.ok ? 0 : 1;
  } finally {
    source.close();
    target.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`kvrocks-migrate: ${(error as Error).message}`);
    process.exit(error instanceof MigrateError ? error.exitCode : 2);
  });
}

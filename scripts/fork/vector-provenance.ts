// Which embedding model produced the stored vectors. Stored rows carry no model
// id, so this re-embeds the source text of a sample with each candidate model
// and compares cosine similarity with the stored vector: the producing model
// scores about 1, the other clearly less.
//
// Reads a Redis/Valkey state store (the iii state worker's redis layout: one
// hash per scope, `state:<scope>`, field = key, value = JSON). Point it at a
// replica, never at production.
//
// Usage:
//   npx tsx scripts/fork/vector-provenance.ts --redis redis://:pass@127.0.0.1:6379 [--sample 60]
//   VOYAGE_API_KEY=... npx tsx scripts/fork/vector-provenance.ts --redis ... --send
// VOYAGE_BASE_URL overrides https://api.voyageai.com/v1 (for a local stub).
//
// Without --send (the default dry run) it prints the stored-vector statistics and
// what --send would send (texts, characters), and calls nothing outside Redis.

import { connect, type Socket } from "node:net";
import { parseArgs } from "node:util";
import { observationEmbedText } from "../../src/state/memory-utils.js";

const { values: args } = parseArgs({
  options: {
    redis: { type: "string", default: process.env.AGENTMEMORY_REDIS_URL ?? "redis://127.0.0.1:6379" },
    sample: { type: "string", default: "60" },
    send: { type: "boolean", default: false },
    models: { type: "string", default: "voyage-code-4@1024,voyage-code-3" },
  },
});

const requested = Number(args.sample);
if (!Number.isInteger(requested) || requested < 1) {
  console.error("--sample must be a positive integer");
  process.exit(2);
}

const VECTOR_SCOPE_PREFIX = "state:mem:index:bm25:vec:";
const EMBED_MAX_CHARS = 16_000;

type Reply = string | number | null | Reply[] | Error;

class Redis {
  private buffer = Buffer.alloc(0);
  private waiting: Array<(reply: Reply) => void> = [];
  private failure: Error | null = null;
  private constructor(private socket: Socket) {
    const fail = (error: Error) => {
      this.failure ??= error;
      for (const settle of this.waiting.splice(0)) settle(this.failure);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("redis connection closed")));
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const parsed = parse(this.buffer, 0);
        if (!parsed) break;
        this.buffer = this.buffer.subarray(parsed.end);
        this.waiting.shift()?.(parsed.value);
      }
    });
  }

  static async open(url: string): Promise<Redis> {
    const parsed = new URL(url);
    const socket = connect(Number(parsed.port || 6379), parsed.hostname);
    await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
    const client = new Redis(socket);
    if (parsed.password) {
      const auth = parsed.username
        ? ["AUTH", decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)]
        : ["AUTH", decodeURIComponent(parsed.password)];
      await client.call(...auth);
    }
    return client;
  }

  call(...parts: string[]): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    const payload = `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`;
    return new Promise((resolve, reject) => {
      this.waiting.push((reply) => (reply instanceof Error ? reject(reply) : resolve(reply)));
      this.socket.write(payload);
    });
  }

  close(): void {
    this.socket.end();
  }
}

function parse(buffer: Buffer, start: number): { value: Reply; end: number } | null {
  const lineEnd = buffer.indexOf("\r\n", start);
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buffer[start]!);
  const line = buffer.toString("utf8", start + 1, lineEnd);
  const next = lineEnd + 2;
  if (type === "+") return { value: line, end: next };
  if (type === "-") return { value: new Error(line), end: next };
  if (type === ":") return { value: Number(line), end: next };
  if (type === "$") {
    const length = Number(line);
    if (length < 0) return { value: null, end: next };
    if (buffer.length < next + length + 2) return null;
    return { value: buffer.toString("utf8", next, next + length), end: next + length + 2 };
  }
  if (type === "*") {
    const count = Number(line);
    if (count < 0) return { value: null, end: next };
    const items: Reply[] = [];
    let at = next;
    for (let i = 0; i < count; i++) {
      const item = parse(buffer, at);
      if (!item) return null;
      items.push(item.value);
      at = item.end;
    }
    return { value: items, end: at };
  }
  throw new Error(`unexpected RESP type ${type}`);
}

async function* scanKeys(redis: Redis, pattern: string): AsyncGenerator<string> {
  let cursor = "0";
  do {
    const [next, keys] = (await redis.call("SCAN", cursor, "MATCH", pattern, "COUNT", "1000")) as [string, string[]];
    cursor = next;
    yield* keys;
  } while (cursor !== "0");
}

async function* scanHash(redis: Redis, key: string): AsyncGenerator<[string, string]> {
  let cursor = "0";
  do {
    const [next, flat] = (await redis.call("HSCAN", key, cursor, "COUNT", "500")) as [string, string[]];
    cursor = next;
    for (let i = 0; i < flat.length; i += 2) yield [flat[i]!, flat[i + 1]!];
  } while (cursor !== "0");
}

function idTime(id: string): number | null {
  const parts = id.split("_");
  if (parts.length < 3) return null;
  const ms = parseInt(parts[parts.length - 2]!, 36);
  return ms >= Date.UTC(2020, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

function decode(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Number.NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
}

const day = (ms: number | null) => (ms === null ? "unknown" : new Date(ms).toISOString().slice(0, 10));

type Row = { id: string; session: string; scope: string; dims: number; at: number | null };

const redis = await Redis.open(args.redis!);
const rows: Row[] = [];
const dims = new Map<number, number>();
const kinds = new Map<string, number>();
const byMonth = new Map<string, number>();
let malformed = 0;
let bucketScopes = 0;
for await (const key of scanKeys(redis, `${VECTOR_SCOPE_PREFIX}*`)) {
  bucketScopes++;
  for await (const [, value] of scanHash(redis, key)) {
    let row: { id?: unknown; s?: unknown; e?: unknown };
    try {
      row = JSON.parse(value);
    } catch {
      malformed++;
      continue;
    }
    if (typeof row.id !== "string" || typeof row.s !== "string" || typeof row.e !== "string") {
      malformed++;
      continue;
    }
    const size = Math.floor((Buffer.from(row.e, "base64").byteLength) / 4);
    const at = idTime(row.id);
    rows.push({ id: row.id, session: row.s, scope: key, dims: size, at });
    dims.set(size, (dims.get(size) ?? 0) + 1);
    const kind = row.id.split("_")[0] ?? "?";
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const month = at === null ? "unknown" : day(at).slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  }
}

const meta = await redis.call("HGET", "state:mem:index:bm25", "vectors:meta");
const legacy = await redis.call("HEXISTS", "state:mem:index:bm25", "vectors");
const timed = rows.filter((row) => row.at !== null).sort((a, b) => a.at! - b.at!);

console.log(`stored vectors: ${rows.length} in ${bucketScopes} bucket scopes (${malformed} malformed rows)`);
console.log(`dtype: float32 (base64), dims: ${[...dims].map(([d, n]) => `${d}=${n}`).join(", ") || "none"}`);
console.log(`id kinds: ${[...kinds].map(([k, n]) => `${k}=${n}`).join(", ") || "none"}`);
console.log(`vectors:meta: ${typeof meta === "string" ? meta : "absent"}; legacy single-key vectors: ${legacy ? "present" : "absent"}`);
console.log(`created (from id time): first ${day(timed[0]?.at ?? null)}, last ${day(timed.at(-1)?.at ?? null)}, ${rows.length - timed.length} without a time`);
console.log(`per month: ${[...byMonth].sort().map(([m, n]) => `${m}=${n}`).join(", ")}`);

const WEEK_MS = 7 * 86_400_000;
const weeks = new Map<number, Row[]>();
for (const row of timed) {
  const week = Math.floor(row.at! / WEEK_MS);
  const rowsOfWeek = weeks.get(week);
  if (rowsOfWeek) rowsOfWeek.push(row);
  else weeks.set(week, [row]);
}
const perWeek = Math.max(1, Math.ceil(requested / Math.max(1, weeks.size)));
const picks = [...weeks.values()].flatMap((rowsOfWeek) => {
  const take = Math.min(perWeek, rowsOfWeek.length);
  return Array.from({ length: take }, (_, i) => rowsOfWeek[Math.floor((i * rowsOfWeek.length) / take)]!);
});
const sample = picks.length <= requested
  ? picks
  : Array.from({ length: requested }, (_, i) => picks[Math.floor((i * picks.length) / requested)]!);
const sampleSize = sample.length;
console.log(`per week (starting): ${[...weeks].map(([week, list]) => `${day(week * WEEK_MS)}=${list.length}`).join(", ")}`);

function parseRecord<T>(raw: Reply): T | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function sourceText(row: Row): Promise<string | null> {
  if (row.id.startsWith("mem_")) {
    const memory = parseRecord<{ title?: string; content?: string; concepts?: string[] }>(
      await redis.call("HGET", "state:mem:memories", row.id),
    );
    if (!memory) return null;
    return observationEmbedText({ title: memory.title ?? "", narrative: memory.content ?? "", concepts: memory.concepts ?? [] });
  }
  const obs = parseRecord<{ title?: string; narrative?: string; concepts?: string[] }>(
    await redis.call("HGET", `state:mem:obs:${row.session}`, row.id),
  );
  if (!obs) return null;
  return observationEmbedText({ title: obs.title ?? "", narrative: obs.narrative ?? "", concepts: obs.concepts ?? [] });
}

const texts: Array<{ row: Row; text: string }> = [];
for (const row of sample) {
  const text = await sourceText(row);
  if (text) texts.push({ row, text: text.slice(0, EMBED_MAX_CHARS) });
}
const chars = texts.reduce((sum, entry) => sum + entry.text.length, 0);
const models = args.models!.split(",").map((spec) => {
  const [model, dimension] = spec.split("@");
  return { label: spec, model: model!, dimension: dimension ? Number(dimension) : undefined };
});
console.log(
  `sample: ${sampleSize} vectors, up to ${perWeek} from each of ${weeks.size} weeks, ${texts.length} with source text ` +
    `(${sampleSize - texts.length} source records missing), ${chars} characters`,
);

if (!args.send) {
  console.log(
    `dry run: --send would make ${models.length} Voyage requests (${models.map((m) => m.label).join(", ")}), ` +
      `each with ${texts.length} texts and ${chars} characters. Nothing was sent.`,
  );
  redis.close();
  process.exit(0);
}

const key = process.env.VOYAGE_API_KEY;
if (!key) {
  console.error("VOYAGE_API_KEY is not set");
  process.exit(2);
}

async function embed(model: string, dimension: number | undefined, inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += 32) {
    const response = await fetch(`${(process.env.VOYAGE_BASE_URL ?? "https://api.voyageai.com/v1").replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        input: inputs.slice(i, i + 32), model, input_type: "document",
        ...(dimension ? { output_dimension: dimension } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${model}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    const expected = Math.min(32, inputs.length - i);
    if (body.data?.length !== expected) throw new Error(`${model}: got ${body.data?.length ?? 0} embeddings for ${expected} inputs`);
    out.push(...body.data.map((d) => d.embedding));
  }
  return out;
}

const stored: Float32Array[] = [];
for (const { row } of texts) {
  const vector = parseRecord<{ e?: string }>(await redis.call("HGET", row.scope, row.id));
  if (typeof vector?.e !== "string") throw new Error(`stored vector ${row.id} vanished or changed during the run`);
  stored.push(decode(vector.e));
}
redis.close();

const scores = new Map<string, number[]>();
for (const m of models) {
  const fresh = await embed(m.model, m.dimension, texts.map((t) => t.text));
  scores.set(m.label, fresh.map((vector, i) => cosine(stored[i]!, vector)));
}

const labels = models.map((m) => m.label);
const wins = new Map<string, number>();
console.log(["created", "id", ...labels, "closest"].join("\t"));
texts.forEach(({ row }, i) => {
  const values = labels.map((label) => scores.get(label)![i]!);
  const best = values.every(Number.isNaN) ? "none" : labels[values.indexOf(Math.max(...values.filter((v) => !Number.isNaN(v))))]!;
  wins.set(best, (wins.get(best) ?? 0) + 1);
  console.log([day(row.at), row.id, ...values.map((v) => v.toFixed(4)), best].join("\t"));
});
console.log(`closest model: ${[...wins].map(([label, n]) => `${label}=${n}`).join(", ")}`);
console.log("A vector made by a model scores about 1.0 against it; text edited after embedding lowers both scores.");

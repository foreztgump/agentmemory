import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { queryTerms } from "../../../src/state/term-extraction.js";

export const DIMS = 1024;
export const NOISE_SIGMA = 0.0151;
export const K1 = 1.2;
export const B = 0.75;
export type Layer = "observation" | "memory" | "lesson" | "image";

export function layerOfId(id: string): Layer {
  return id.startsWith("mem_") ? "memory" : "observation";
}

// Every call the spikes make is idempotent, so one retry covers a keep-alive
// socket the server closed while the client sat idle.
export async function qdrant<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await qdrantOnce<T>(method, path, body);
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code !== "UND_ERR_SOCKET") throw error;
    return qdrantOnce<T>(method, path, body);
  }
}

async function qdrantOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${process.env.QDRANT_URL ?? "http://127.0.0.1:6333"}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { result: T }).result;
}

export interface CollectionShape {
  segments: number;
  m: number;
  efConstruct: number;
  hnswMemory: "pinned" | "cached" | "cold";
  datatype: "float32" | "float16";
  encoding?: "one_bit" | "one_and_half_bits" | "two_bits";
  queryEncoding?: "default" | "binary" | "scalar4bits" | "scalar8bits";
}

export const DEFAULT_SHAPE: CollectionShape = { segments: 2, m: 16, efConstruct: 100, hnswMemory: "cached", datatype: "float16", queryEncoding: "scalar8bits" };

// The planned am-search point shape: named dense vector with cold originals and
// pinned 1-bit codes, BM25 as a sparse vector with the idf modifier and a cold
// index, and keyword/integer/bool payload indexes.
export async function createCollection(name: string, shape: CollectionShape = DEFAULT_SHAPE): Promise<void> {
  await qdrant("DELETE", `/collections/${name}`).catch(() => {});
  await qdrant("PUT", `/collections/${name}`, {
    vectors: { dense: { size: DIMS, distance: "Cosine", datatype: shape.datatype, memory: "cold" } },
    quantization_config: { binary: { memory: "pinned", encoding: shape.encoding ?? "one_bit", query_encoding: shape.queryEncoding ?? "default" } },
    sparse_vectors: { bm25: { modifier: "idf", index: { memory: "cold" } } },
    hnsw_config: { m: shape.m, ef_construct: shape.efConstruct, memory: shape.hnswMemory },
    optimizers_config: { default_segment_number: shape.segments },
  });
  for (const [field_name, field_schema] of [
    ["layer", "keyword"],
    ["session_id", "keyword"],
    ["ts", "integer"],
    ["dense", "bool"],
  ] as const) {
    await qdrant("PUT", `/collections/${name}/index?wait=true`, { field_name, field_schema });
  }
}

export async function waitGreen(name: string, timeoutMs = 3 * 3600_000): Promise<CollectionInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await qdrant<CollectionInfo>("GET", `/collections/${name}`);
    if (info.status === "green" && info.optimizer_status === "ok") return info;
    if (Date.now() > deadline) throw new Error(`collection ${name} still ${info.status} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export interface CollectionInfo {
  status: string;
  optimizer_status: unknown;
  points_count: number;
  indexed_vectors_count: number;
  segments_count: number;
  config: unknown;
}

const REPO = resolve(import.meta.dirname, "../../..");

// Vectors and anything derived from them are private: refuse a directory inside the repo.
export function assertOutsideRepo(dir: string): string {
  if (!existsSync(`${REPO}/package.json`)) throw new Error(`repo root guess ${REPO} has no package.json; fix REPO in lib.ts`);
  const abs = resolve(dir);
  if (abs === REPO || abs.startsWith(REPO + sep)) throw new Error(`${abs} is inside the repo: the vectors are private`);
  return abs;
}

export interface VectorSet {
  ids: string[];
  layers: Layer[];
  data: Float32Array;
  size: number;
}

export function readVectors(dir: string): VectorSet {
  const buf = readFileSync(`${dir}/vectors.f32`);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const meta = readFileSync(`${dir}/meta.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; layer: Layer });
  if (meta.length * DIMS !== data.length) throw new Error(`meta has ${meta.length} rows, vectors have ${data.length / DIMS}`);
  for (let i = 0; i < meta.length; i++) normalize(data.subarray(i * DIMS, (i + 1) * DIMS));
  return { ids: meta.map((m) => m.id), layers: meta.map((m) => m.layer), data, size: meta.length };
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  if (!(n > 0)) throw new Error("cannot normalize a zero vector");
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// A copy of a real vector with isotropic Gaussian noise of per-dimension sigma,
// renormalized. For unit vectors in 1024 dims, cosine to the source is about
// 1 / sqrt(1 + 1024 sigma^2).
export function noisyCopy(src: Float32Array, sigma: number, rand: () => number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - rand()));
    const t = 2 * Math.PI * rand();
    out[i] = src[i]! + sigma * r * Math.cos(t);
    if (i + 1 < src.length) out[i + 1] = src[i + 1]! + sigma * r * Math.sin(t);
  }
  return normalize(out);
}

export function wireVector(v: Float32Array): number[] {
  return Array.from(v, (x) => Math.round(x * 1e6) / 1e6);
}

export function termId(term: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(term, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export interface Sparse {
  indices: number[];
  values: number[];
}

// Document side of BM25 (the tf and length part); Qdrant's idf modifier
// supplies the IDF at query time.
export function docSparse(terms: string[], avgdl: number): Sparse {
  const tf = new Map<number, number>();
  for (const t of terms) {
    const id = termId(t);
    tf.set(id, (tf.get(id) ?? 0) + 1);
  }
  const norm = K1 * (1 - B + (B * terms.length) / avgdl);
  const indices = [...tf.keys()];
  return { indices, values: indices.map((id) => (tf.get(id)! * (K1 + 1)) / (tf.get(id)! + norm)) };
}

export function querySparse(text: string): Sparse {
  const merged = new Map<number, number>();
  for (const { term, weight } of queryTerms(text)) merged.set(termId(term), Math.max(merged.get(termId(term)) ?? 0, weight));
  return { indices: [...merged.keys()], values: [...merged.values()] };
}

export function uuidOf(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

import { createHash } from "node:crypto";

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collection: string;
  dimensions: number;
  oversampling: number;
  timeoutMs: number;
  layout?: "text" | "lessons" | "image";
}

const TEXT_INDEXES = [
  ["layer", "keyword"],
  ["session_id", "keyword"],
  ["ts", "integer"],
  ["dense", "bool"],
  ["dl", "integer"],
  ["ad", "float"],
  ["v", "integer"],
] as const;

// A fill from empty merges and indexes ever larger segments; each build holds memory in proportion to
// its segment, and one build per core pushed Qdrant past 1 GB at 130k documents. One build at a time on
// segments of at most 300,000 KB of vectors (Qdrant's unit; about 100k documents at 1024 dimensions)
// filled 500k documents under 1 GB (docs/fork/search-migration.md, "Qdrant memory during a fill").
const FILL_OPTIMIZERS = { max_optimization_threads: 1, max_segment_size: 300_000 } as const;

const IMAGE_INDEXES = [
  ["session_id", "keyword"],
  ["v", "integer"],
] as const;

export class QdrantError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class Qdrant {
  constructor(readonly config: QdrantConfig) {}

  get path(): string {
    return `/collections/${encodeURIComponent(this.config.collection)}`;
  }

  // Every call this worker makes is idempotent, so one retry covers a
  // keep-alive socket Qdrant closed while the client sat idle (5 s).
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.once<T>(method, path, body);
    } catch (error) {
      if (!isSocketReset(error)) throw error;
      return this.once<T>(method, path, body);
    }
  }

  private async once<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["api-key"] = this.config.apiKey;
    const res = await fetch(`${this.config.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new QdrantError(res.status, `${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return (JSON.parse(text) as { result: T }).result;
  }

  async exists(): Promise<boolean> {
    return (await this.call<{ exists: boolean }>("GET", `${this.path}/exists`)).exists;
  }

  /** The settings measured in docs/fork/spikes/qdrant.md ("Settings for the am-search worker"). */
  async create(): Promise<void> {
    if (this.config.layout === "image") {
      await this.call("PUT", this.path, {
        vectors: { image: { size: this.config.dimensions, distance: "Cosine", datatype: "float32" } },
        // Every image query is an exact scan, so no HNSW graph is built.
        hnsw_config: { m: 0 },
        on_disk_payload: true,
      });
      await this.createPayloadIndexes();
      return;
    }
    await this.call("PUT", this.path, {
      vectors: { dense: { size: this.config.dimensions, distance: "Cosine", datatype: "float16", memory: "cold" } },
      quantization_config: { binary: { memory: "pinned", encoding: "one_bit", query_encoding: "scalar8bits" } },
      sparse_vectors: { bm25: { modifier: "idf", index: { memory: "cold" } } },
      hnsw_config: { m: 16, ef_construct: 100, memory: "cached" },
      optimizers_config: { default_segment_number: 2, ...FILL_OPTIMIZERS },
      on_disk_payload: true,
    });
    await this.createPayloadIndexes();
  }

  private async createPayloadIndexes(): Promise<void> {
    for (const [field_name, field_schema] of this.config.layout === "image" ? IMAGE_INDEXES : TEXT_INDEXES) {
      await this.call("PUT", `${this.path}/index?wait=true`, { field_name, field_schema });
    }
    if (this.config.layout === "lessons") {
      await this.call("PUT", `${this.path}/index?wait=true`, { field_name: "terms", field_schema: "keyword" });
    }
  }

  async ensure(): Promise<void> {
    if (!(await this.exists())) {
      try {
        await this.create();
        return;
      } catch (error) {
        if (!(error instanceof QdrantError && error.status === 409)) throw error;
      }
    }
    if (this.config.layout !== "image") await this.applyFillOptimizers();
    await this.createPayloadIndexes();
  }

  /** A text collection created before FILL_OPTIMIZERS gets them too, so a reconcile into it is bounded the same way. */
  private async applyFillOptimizers(): Promise<void> {
    const info = await this.call<{ config: { optimizer_config: Record<string, unknown> } }>("GET", this.path);
    const current = info.config.optimizer_config;
    if (Object.entries(FILL_OPTIMIZERS).every(([key, value]) => current[key] === value)) return;
    await this.call("PATCH", this.path, { optimizers_config: FILL_OPTIMIZERS });
  }

  async drop(): Promise<void> {
    await this.call("DELETE", this.path).catch((error) => {
      if (!(error instanceof QdrantError && error.status === 404)) throw error;
    });
  }

  async count(filter?: unknown): Promise<number> {
    return (await this.call<{ count: number }>("POST", `${this.path}/points/count`, { exact: true, ...(filter ? { filter } : {}) })).count;
  }
}

function isSocketReset(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return code === "UND_ERR_SOCKET" || code === "ECONNRESET";
}

/** Qdrant ids must be UUIDs or integers; agentmemory ids are neither. RFC 4122 v5 in the URL namespace. */
const NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

export function pointId(docId: string): string {
  const hash = createHash("sha1").update(NAMESPACE).update(docId, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { createHash } from "node:crypto";

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collection: string;
  dimensions: number;
  oversampling: number;
  timeoutMs: number;
}

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
    await this.call("PUT", this.path, {
      vectors: { dense: { size: this.config.dimensions, distance: "Cosine", datatype: "float16", memory: "cold" } },
      quantization_config: { binary: { memory: "pinned", encoding: "one_bit", query_encoding: "scalar8bits" } },
      sparse_vectors: { bm25: { modifier: "idf", index: { memory: "cold" } } },
      hnsw_config: { m: 16, ef_construct: 100, memory: "cached" },
      optimizers_config: { default_segment_number: 2 },
      on_disk_payload: true,
    });
    await this.createPayloadIndexes();
  }

  private async createPayloadIndexes(): Promise<void> {
    for (const [field_name, field_schema] of [
      ["layer", "keyword"],
      ["session_id", "keyword"],
      ["ts", "integer"],
      ["dense", "bool"],
      ["dl", "integer"],
      ["ad", "float"],
    ] as const) {
      await this.call("PUT", `${this.path}/index?wait=true`, { field_name, field_schema });
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
    await this.createPayloadIndexes();
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

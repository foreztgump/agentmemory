import type { ImageEmbedding, ImageIndexPort, ImageSearchResult } from "../../state/search-ports.js";
import type { StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import { float32ToBase64 } from "../../state/vector-index.js";
import type { SearchWorkerClient } from "./client.js";
import type { SearchOutbox } from "./outbox.js";
import { READ_YOUR_WRITES_MS } from "./remote-index.js";

export async function liveImageHits(
  kv: StateKV,
  found: { results: ImageSearchResult[]; total: number },
): Promise<{ results: ImageSearchResult[]; total: number }> {
  if (found.results.length === 0) return found;
  const rows = await kv.getMany(KV.imageEmbeddings, found.results.map((hit) => hit.imageRef));
  const results = found.results.filter((_, i) => rows[i]);
  return { results, total: found.total - (found.results.length - results.length) };
}

/** Image embeddings in the worker's images collection; the app keeps no copy. */
export class RemoteImageIndex implements ImageIndexPort {
  constructor(
    private readonly client: SearchWorkerClient,
    private readonly outbox: SearchOutbox,
  ) {}

  put(e: ImageEmbedding): void {
    this.outbox.put({
      k: "img",
      id: e.imageRef,
      sessionId: e.sessionId ?? "",
      f32b64: float32ToBase64(Float32Array.from(e.vector)),
      observationId: e.observationId,
      updatedAt: e.updatedAt,
    });
  }

  remove(imageRef: string): void {
    this.outbox.put({ k: "del", id: imageRef });
  }

  async search(query: Float32Array, topK: number, sessionId?: string): Promise<{ results: ImageSearchResult[]; total: number }> {
    await this.outbox.drainFor(READ_YOUR_WRITES_MS);
    const { hits, total } = await this.client.imageQuery(float32ToBase64(query), topK, sessionId);
    return {
      results: hits.map((h) => ({
        imageRef: h.id,
        score: h.score,
        sessionId: h.sessionId || undefined,
        observationId: h.observationId,
        updatedAt: h.updatedAt,
      })),
      total,
    };
  }
}

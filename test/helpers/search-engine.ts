import type { SearchWorkerClient } from "../../src/fork/search/client.js";
import type { SearchEngine } from "../../src/fork/worker/engine.js";
import type { ImageEngine } from "../../src/fork/worker/image-engine.js";
import { Qdrant } from "../../src/fork/worker/qdrant.js";

export const DIMS = 16;
export const QDRANT_URL = process.env.QDRANT_URL;

/** The search::* protocol served in-process, so tests reach Qdrant without an iii engine. */
export function engineClient(engine: SearchEngine, oversampling = 6): SearchWorkerClient {
  return {
    apply: (ops, version) => engine.apply(ops, version),
    maxVersion: () => engine.maxVersion(),
    lookup: (ids) => engine.lookup(ids),
    keyword: (query, limit, layer) => engine.keyword(query, limit, layer),
    vector: (f32b64, limit, layer) => engine.vector(f32b64, limit, layer, oversampling),
    imageQuery: () => Promise.reject(new Error("search::image-query needs the images collection")),
    stats: () => engine.stats(),
    sessionCounts: () => engine.sessionCounts(),
    scanMissingVectors: (cursor, limit) => engine.scanMissingVectors(cursor, limit),
    clear: (scope) => engine.clear(scope),
    health: () => engine.health(),
  };
}

/** The protocol served by an images engine; the text-only calls are not served. */
export function imageEngineClient(engine: ImageEngine): SearchWorkerClient {
  const notServed = () => Promise.reject(new Error("not served by the images collection"));
  return {
    apply: (ops, version) => engine.apply(ops, version),
    maxVersion: () => engine.maxVersion(),
    lookup: notServed,
    keyword: notServed,
    vector: notServed,
    imageQuery: (f32b64, limit, sessionId) => engine.query(f32b64, limit, sessionId),
    stats: notServed,
    sessionCounts: notServed,
    scanMissingVectors: notServed,
    clear: (scope) => engine.clear(scope),
    health: () => engine.health(),
  };
}

export function qdrantFor(collection: string, dimensions = DIMS, layout?: "image"): Qdrant {
  return new Qdrant({ url: QDRANT_URL!, apiKey: process.env.QDRANT_API_KEY, collection, dimensions, oversampling: 6, timeoutMs: 30_000, layout });
}


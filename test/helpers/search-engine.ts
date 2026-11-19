import type { SearchWorkerClient } from "../../src/fork/search/client.js";
import type { SearchEngine } from "../../src/fork/worker/engine.js";
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
    stats: () => engine.stats(),
    sessionCounts: () => engine.sessionCounts(),
    scanMissingVectors: (cursor, limit) => engine.scanMissingVectors(cursor, limit),
    clear: (scope) => engine.clear(scope),
    health: () => engine.health(),
  };
}

export function qdrantFor(collection: string, dimensions = DIMS): Qdrant {
  return new Qdrant({ url: QDRANT_URL!, apiKey: process.env.QDRANT_API_KEY, collection, dimensions, oversampling: 6, timeoutMs: 30_000 });
}


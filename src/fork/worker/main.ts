import { registerWorker } from "iii-sdk";
import { SEARCH_FN, type ApplyRequest, type ClearRequest, type KeywordRequest, type ScanMissingRequest, type VectorRequest } from "../search/protocol.js";
import { loadSearchWorkerSettings } from "../search/settings.js";
import { SearchEngine } from "./engine.js";
import { Qdrant } from "./qdrant.js";

const env = process.env;
const settings = loadSearchWorkerSettings(env);
const qdrant = new Qdrant({
  url: settings.qdrantUrl,
  apiKey: settings.qdrantApiKey,
  collection: settings.collection,
  dimensions: settings.dimensions,
  oversampling: settings.oversampling,
  timeoutMs: 30_000,
});
const engine = new SearchEngine(qdrant, settings.avgdl);
const engineUrl = env.III_ENGINE_URL || env.III_URL || `ws://localhost:${env.III_ENGINE_PORT || "49134"}`;

const worker = registerWorker(engineUrl, { workerName: "am-search", invocationTimeoutMs: 60_000 });

const handlers: Record<(typeof SEARCH_FN)[keyof typeof SEARCH_FN], (data: never) => Promise<unknown>> = {
  [SEARCH_FN.apply]: async (data: Partial<ApplyRequest>) => engine.apply(Array.isArray(data?.ops) ? data.ops : []),
  [SEARCH_FN.keyword]: async (data: Partial<KeywordRequest>) => ({ hits: await engine.keyword(data?.query, data?.limit, data?.layer) }),
  [SEARCH_FN.vector]: async (data: Partial<VectorRequest>) =>
    ({ hits: await engine.vector(data?.f32b64, data?.limit, data?.layer, settings.oversampling) }),
  [SEARCH_FN.stats]: async () => engine.stats(),
  [SEARCH_FN.sessionCounts]: async () => ({ counts: await engine.sessionCounts() }),
  [SEARCH_FN.scanMissingVectors]: async (data: Partial<ScanMissingRequest>) => engine.scanMissingVectors(data?.cursor, data?.limit),
  [SEARCH_FN.clear]: async (data: Partial<ClearRequest>) => {
    await engine.clear(data?.scope === "vectors" ? "vectors" : "all");
    return { ok: true };
  },
  [SEARCH_FN.health]: async () => engine.health(),
};

for (const [id, handler] of Object.entries(handlers)) worker.registerFunction(id, handler as (data: unknown) => Promise<unknown>);

const health = await engine.health();
console.log(`[am-search] collection ${health.collection} ${health.status} (${health.dimensions} dims)${health.error ? `: ${health.error}` : ""}`);
if (health.ok && health.dimensions !== settings.dimensions) {
  console.error(`[am-search] collection ${health.collection} has ${health.dimensions} dims, AM_SEARCH_DIMENSIONS is ${settings.dimensions}; vector writes will fail`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void worker.shutdown().finally(() => process.exit(0));
  });
}

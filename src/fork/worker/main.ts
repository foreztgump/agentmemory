import { registerWorker } from "iii-sdk";
import { loadSearchWorkerSettings } from "../search/settings.js";
import { SearchEngine } from "./engine.js";
import { ImageEngine } from "./image-engine.js";
import { Qdrant } from "./qdrant.js";
import { createSearchHandlers } from "./router.js";

const env = process.env;
const settings = loadSearchWorkerSettings(env);
const qdrantFor = (collection: string, dimensions: number, layout?: "image") =>
  new Qdrant({
    url: settings.qdrantUrl,
    apiKey: settings.qdrantApiKey,
    collection,
    dimensions,
    oversampling: settings.oversampling,
    timeoutMs: 30_000,
    layout,
  });
const engine = new SearchEngine(qdrantFor(settings.collections.docs, settings.dimensions), settings.avgdl);
const engines = {
  docs: engine,
  lessons: new SearchEngine(qdrantFor(settings.collections.lessons, settings.dimensions), settings.avgdl),
  images: new ImageEngine(qdrantFor(settings.collections.images, settings.imageDimensions, "image")),
};
const engineUrl = env.III_ENGINE_URL || env.III_URL || `ws://localhost:${env.III_ENGINE_PORT || "49134"}`;

const worker = registerWorker(engineUrl, { workerName: "am-search", invocationTimeoutMs: 60_000 });

const handlers = createSearchHandlers(engines, settings.oversampling);

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

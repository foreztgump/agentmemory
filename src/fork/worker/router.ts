import {
  isCollectionId,
  SEARCH_FN,
  type ApplyRequest,
  type ClearRequest,
  type CollectionId,
  type CollectionScoped,
  type ImageQueryRequest,
  type KeywordRequest,
  type LookupRequest,
  type ReadVectorsRequest,
  type ScanDocsRequest,
  type ScanEntriesRequest,
  type ScanMissingRequest,
  type VectorRequest,
} from "../search/protocol.js";
import type { SearchEngine } from "./engine.js";
import type { ImageEngine } from "./image-engine.js";

export interface WorkerEngines {
  docs: SearchEngine;
  lessons: SearchEngine;
  images: ImageEngine;
}

export type SearchHandlers = Record<(typeof SEARCH_FN)[keyof typeof SEARCH_FN], (data: never) => Promise<unknown>>;

/** The collection a request names; absent means docs, anything else that is not a collection id is an error. */
function collectionOf(data: CollectionScoped | undefined): CollectionId {
  const named = data?.collection;
  if (named === undefined) return "docs";
  if (!isCollectionId(named)) throw new Error(`unknown collection ${JSON.stringify(named)}`);
  return named;
}

/** Maps every search::* function id to the engine of the collection the request names. */
export function createSearchHandlers(engines: WorkerEngines, oversampling: number): SearchHandlers {
  const engineFor = (data: CollectionScoped | undefined) => engines[collectionOf(data)];
  const text = (data: CollectionScoped | undefined, fn: string): SearchEngine => {
    const id = collectionOf(data);
    if (id === "images") throw new Error(`${fn} is not served by the images collection`);
    return engines[id];
  };
  const images = (data: CollectionScoped | undefined): ImageEngine => {
    const id = collectionOf(data);
    if (id !== "images") throw new Error(`${SEARCH_FN.imageQuery} needs the images collection, not ${id}`);
    return engines.images;
  };
  return {
    [SEARCH_FN.apply]: async (data: Partial<ApplyRequest>) => engineFor(data).apply(Array.isArray(data?.ops) ? data.ops : [], data?.version),
    [SEARCH_FN.lookup]: async (data: Partial<LookupRequest>) => ({ items: await text(data, SEARCH_FN.lookup).lookup(data?.ids) }),
    [SEARCH_FN.readVectors]: async (data: Partial<ReadVectorsRequest>) => ({ vectors: await text(data, SEARCH_FN.readVectors).readVectors(data?.ids) }),
    [SEARCH_FN.keyword]: async (data: Partial<KeywordRequest>) =>
      ({ hits: await text(data, SEARCH_FN.keyword).keyword(data?.query, data?.limit, data?.layer) }),
    [SEARCH_FN.vector]: async (data: Partial<VectorRequest>) =>
      ({ hits: await text(data, SEARCH_FN.vector).vector(data?.f32b64, data?.limit, data?.layer, oversampling) }),
    [SEARCH_FN.imageQuery]: async (data: Partial<ImageQueryRequest>) => images(data).query(data?.f32b64, data?.limit, data?.sessionId),
    [SEARCH_FN.stats]: async (data: CollectionScoped) => text(data, SEARCH_FN.stats).stats(),
    [SEARCH_FN.sessionCounts]: async (data: CollectionScoped) => ({ counts: await text(data, SEARCH_FN.sessionCounts).sessionCounts() }),
    [SEARCH_FN.scanMissingVectors]: async (data: Partial<ScanMissingRequest>) => text(data, SEARCH_FN.scanMissingVectors).scanMissingVectors(data?.cursor, data?.limit),
    [SEARCH_FN.scanDocs]: async (data: Partial<ScanDocsRequest>) => text(data, SEARCH_FN.scanDocs).scanDocs(data?.sessionId, data?.cursor, data?.limit),
    [SEARCH_FN.scanEntries]: async (data: Partial<ScanEntriesRequest>) => {
      const id = collectionOf(data);
      if (id === "docs") throw new Error(`${SEARCH_FN.scanEntries} is not served by the docs collection`);
      return engines[id].scanEntries(data?.cursor, data?.limit);
    },
    [SEARCH_FN.clear]: async (data: Partial<ClearRequest>) => {
      await engineFor(data).clear(data?.scope);
      return { ok: true };
    },
    [SEARCH_FN.health]: async (data: CollectionScoped) => engineFor(data).health(),
    [SEARCH_FN.maxVersion]: async (data: CollectionScoped) => ({ version: await engineFor(data).maxVersion() }),
  };
}

import type { IIIClient } from "iii-sdk";
import type { SearchLayer } from "../../state/search-layer.js";
import {
  SEARCH_FN,
  type ApplyResult,
  type ClearScope,
  type CollectionId,
  type CollectionScoped,
  type HealthResult,
  type Hit,
  type HitsResult,
  type ImageQueryResult,
  type LookupResult,
  type MaxVersionResult,
  type Op,
  type OpVersion,
  type ReadVectorsResult,
  type ScanDocsResult,
  type ScanEntriesResult,
  type ScanMissingResult,
  type SessionCountsResult,
  type StatsResult,
} from "./protocol.js";

/** The whole search::* protocol as the app worker sees it. */
export interface SearchWorkerClient {
  apply(ops: Op[], version?: OpVersion): Promise<ApplyResult>;
  /** The highest version stored. A client without it (a test double) leaves the clock unseeded. */
  maxVersion?(): Promise<OpVersion>;
  /** Live documents among ids; unknown and deleted ids are absent. */
  lookup(ids: string[]): Promise<LookupResult["items"]>;
  /** Stored dense vectors among ids; unknown, deleted and vectorless ids are absent. */
  readVectors(ids: string[]): Promise<ReadVectorsResult["vectors"]>;
  keyword(query: string, limit: number, layer: SearchLayer): Promise<Hit[]>;
  vector(f32b64: string, limit: number, layer: SearchLayer): Promise<Hit[]>;
  /** Only the images collection answers; text collections reject it. */
  imageQuery(f32b64: string, limit: number, sessionId?: string): Promise<ImageQueryResult>;
  stats(): Promise<StatsResult>;
  sessionCounts(): Promise<Array<[string, number]>>;
  scanMissingVectors(cursor: string | undefined, limit: number): Promise<ScanMissingResult>;
  /** Live observation docs of a session, or live memory docs when sessionId is undefined. */
  scanDocs(sessionId: string | undefined, cursor: string | undefined, limit: number): Promise<ScanDocsResult>;
  /** Every live entry of the bound collection; served by lessons and images, not docs. */
  scanEntries(cursor: string | undefined, limit: number): Promise<ScanEntriesResult>;
  clear(scope: ClearScope): Promise<void>;
  health(): Promise<HealthResult>;
}

const READ_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 3000;
const WRITE_TIMEOUT_MS = 60_000;

/** Binds every call to one collection. Docs sends no `collection` field, so its wire format never changed. */
export function iiiSearchClient(sdk: IIIClient, collection: CollectionId = "docs"): SearchWorkerClient {
  const binding: CollectionScoped = collection === "docs" ? {} : { collection };
  const call = <T>(function_id: string, payload: object, timeoutMs = READ_TIMEOUT_MS) =>
    sdk.trigger<unknown, T>({ function_id, payload: { ...payload, ...binding }, timeoutMs });
  return {
    apply: (ops, version) => call<ApplyResult>(SEARCH_FN.apply, { ops, version }, WRITE_TIMEOUT_MS),
    maxVersion: async () => (await call<MaxVersionResult>(SEARCH_FN.maxVersion, {})).version,
    lookup: async (ids) => (await call<LookupResult>(SEARCH_FN.lookup, { ids })).items,
    readVectors: async (ids) => (await call<ReadVectorsResult>(SEARCH_FN.readVectors, { ids })).vectors,
    keyword: async (query, limit, layer) => (await call<HitsResult>(SEARCH_FN.keyword, { query, limit, layer }, SEARCH_TIMEOUT_MS)).hits,
    vector: async (f32b64, limit, layer) => (await call<HitsResult>(SEARCH_FN.vector, { f32b64, limit, layer }, SEARCH_TIMEOUT_MS)).hits,
    imageQuery: (f32b64, limit, sessionId) => call<ImageQueryResult>(SEARCH_FN.imageQuery, { f32b64, limit, sessionId }, SEARCH_TIMEOUT_MS),
    stats: () => call<StatsResult>(SEARCH_FN.stats, {}),
    sessionCounts: async () => (await call<SessionCountsResult>(SEARCH_FN.sessionCounts, {})).counts,
    scanMissingVectors: (cursor, limit) => call<ScanMissingResult>(SEARCH_FN.scanMissingVectors, { cursor, limit }),
    scanDocs: (sessionId, cursor, limit) => call<ScanDocsResult>(SEARCH_FN.scanDocs, { sessionId, cursor, limit }),
    scanEntries: (cursor, limit) => call<ScanEntriesResult>(SEARCH_FN.scanEntries, { cursor, limit }),
    clear: async (scope) => {
      await call(SEARCH_FN.clear, { scope }, WRITE_TIMEOUT_MS);
    },
    health: () => call<HealthResult>(SEARCH_FN.health, {}),
  };
}

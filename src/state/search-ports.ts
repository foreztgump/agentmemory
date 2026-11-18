import type { CompressedObservation, EmbeddingProvider } from "../types.js";
import type { StateKV } from "./kv.js";
import type { SearchLayer, SearchLayerResolver, SearchResultLayer } from "./search-layer.js";
import type {
  IndexPersistenceStatus,
  PendingReplayResult,
  VectorLoadResult,
} from "./index-persistence.js";
import { IndexPersistence } from "./index-persistence.js";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import { getEnvVar } from "../config.js";

export type MaybePromise<T> = T | Promise<T>;

export interface ScoredId {
  obsId: string;
  sessionId: string;
  score: number;
}

export interface RevisionToken {
  isCurrent(): boolean;
  release(): void;
}

/** Opaque identity: the same token means no add or remove happened since it was read. */
export type VectorToken = object;

export interface KeywordIndexPort {
  /** Idempotent upsert by obs.id. A remote index enqueues; it never blocks the caller. */
  add(obs: CompressedObservation, layer?: SearchResultLayer): void;
  remove(id: string): void;
  clear(): MaybePromise<void>;
  search(query: string, limit?: number, layer?: SearchLayer): MaybePromise<ScoredId[]>;

  watchRevision(id: string): RevisionToken;
  invalidateRevision(id: string): void;

  layerOf(id: string): SearchResultLayer | undefined;
  sessionOf(id: string): string | undefined;
  /** false may mean unknown for a remote index; callers treat add() as an upsert. */
  has(id: string): boolean;
  readonly size: number;

  observationCountsBySession(): MaybePromise<Map<string, number>>;
  documentKindCounts(): MaybePromise<{ memories: number; lessons: number }>;
  countMissingDocuments(
    hasDocument: (id: string) => boolean,
    since?: string | null,
    activeIds?: ReadonlySet<string>,
  ): MaybePromise<number>;
}

export interface VectorStorePort {
  add(obsId: string, sessionId: string, embedding: Float32Array): void;
  remove(obsId: string): void;
  has(obsId: string): boolean;
  /** Identity only, never the embedding. */
  get(obsId: string): VectorToken | undefined;
  /** A remote store reads the layer from its own payload and ignores resolveLayer. */
  search(
    query: Float32Array,
    limit?: number,
    layer?: SearchLayer,
    resolveLayer?: SearchLayerResolver,
  ): MaybePromise<ScoredId[]>;
  readonly size: number;
  clear(): MaybePromise<void>;
}

export interface IndexPersistencePort {
  load(): Promise<VectorLoadResult | null>;
  prepareBackfill(loaded: VectorLoadResult | null, forceFull?: boolean): Promise<string | null | undefined>;
  replayPendingLog(expectedDimensions?: number): Promise<PendingReplayResult>;
  beginBackfill(): Promise<boolean>;
  completeBackfill(isCovered?: () => boolean): Promise<boolean>;
  isRecoveryPaused(): boolean;
  scheduleSave(): void;
  save(): Promise<void>;
  stop(): void;
  status(): IndexPersistenceStatus;
}

export interface SearchRuntimeDeps {
  kv: StateKV;
  embeddingProvider: EmbeddingProvider | null;
}

export interface SearchRuntime {
  readonly backend: string;
  keyword: KeywordIndexPort;
  vector: VectorStorePort | null;
  openPersistence(): IndexPersistencePort;
}

export type SearchRuntimeFactory = (deps: SearchRuntimeDeps) => MaybePromise<SearchRuntime>;

export const SEARCH_BACKEND_ENV = "AM_SEARCH_BACKEND";
const DEFAULT_BACKEND = "memory";

let memoryKeyword: SearchIndex | null = null;
function memoryKeywordIndex(): SearchIndex {
  if (!memoryKeyword) memoryKeyword = new SearchIndex();
  return memoryKeyword;
}

function createMemoryRuntime(deps: SearchRuntimeDeps): SearchRuntime {
  const vector = deps.embeddingProvider ? new VectorIndex() : null;
  return {
    backend: DEFAULT_BACKEND,
    keyword: memoryKeywordIndex(),
    vector,
    openPersistence: () => new IndexPersistence(deps.kv, vector, { requireRecoveryPlan: true }),
  };
}

const factories = new Map<string, SearchRuntimeFactory>([[DEFAULT_BACKEND, createMemoryRuntime]]);
let current: SearchRuntime | null = null;

export function registerSearchBackend(name: string, factory: SearchRuntimeFactory): void {
  factories.set(name, factory);
}

export function configuredSearchBackend(): string {
  return getEnvVar(SEARCH_BACKEND_ENV)?.trim() || DEFAULT_BACKEND;
}

export async function createSearchRuntime(
  deps: SearchRuntimeDeps,
  backend: string = configuredSearchBackend(),
): Promise<SearchRuntime> {
  const factory = factories.get(backend);
  if (!factory) {
    throw new Error(
      `${SEARCH_BACKEND_ENV}=${backend} is not a known search backend (known: ${[...factories.keys()].join(", ")})`,
    );
  }
  current = await factory(deps);
  return current;
}

/** Before createSearchRuntime() runs (unit tests, early boot) this is a memory runtime with no vector store. */
export function getSearchRuntime(): SearchRuntime {
  if (!current) {
    current = { backend: DEFAULT_BACKEND, keyword: memoryKeywordIndex(), vector: null, openPersistence: noPersistence };
  }
  return current;
}

function noPersistence(): never {
  throw new Error("search runtime was not created with createSearchRuntime()");
}

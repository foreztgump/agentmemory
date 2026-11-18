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

/** Ports are the defaults; the memory runtime keeps its concrete classes so existing callers stay synchronous. */
export interface SearchRuntime<
  K extends KeywordIndexPort = KeywordIndexPort,
  V extends VectorStorePort = VectorStorePort,
  P extends IndexPersistencePort = IndexPersistencePort,
> {
  readonly backend: SearchBackend;
  readonly keyword: K;
  readonly vector: V | null;
  openPersistence(): P;
}

export type MemorySearchRuntime = SearchRuntime<SearchIndex, VectorIndex, IndexPersistence>;

export const SEARCH_BACKEND_ENV = "AM_SEARCH_BACKEND";
const SEARCH_BACKENDS = ["memory"] as const;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

export function configuredSearchBackend(env: Record<string, string | undefined> = { [SEARCH_BACKEND_ENV]: getEnvVar(SEARCH_BACKEND_ENV) }): SearchBackend {
  const raw = env[SEARCH_BACKEND_ENV]?.trim() || "memory";
  const backend = SEARCH_BACKENDS.find((name) => name === raw);
  if (!backend) {
    throw new Error(`${SEARCH_BACKEND_ENV}=${raw} is not a search backend this build supports (${SEARCH_BACKENDS.join(", ")})`);
  }
  return backend;
}

let current: MemorySearchRuntime | null = null;

export function createSearchRuntime(
  deps: SearchRuntimeDeps,
  backend: SearchBackend = configuredSearchBackend(),
): MemorySearchRuntime {
  const vector = deps.embeddingProvider ? new VectorIndex() : null;
  current = {
    backend,
    keyword: current?.keyword ?? new SearchIndex(),
    vector,
    openPersistence: () => new IndexPersistence(deps.kv, vector, { requireRecoveryPlan: true }),
  };
  return current;
}

/** Before createSearchRuntime() runs (unit tests, early boot) this is a memory runtime with no vector store. */
export function getSearchRuntime(): MemorySearchRuntime {
  if (!current) {
    current = { backend: "memory", keyword: new SearchIndex(), vector: null, openPersistence: noPersistence };
  }
  return current;
}

function noPersistence(): never {
  throw new Error("search runtime was not created with createSearchRuntime()");
}

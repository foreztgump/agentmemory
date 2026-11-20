import type { IIIClient } from "iii-sdk";
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
  /** false may mean unknown for a remote index until prefetch() ran for the id; callers treat add() as an upsert. */
  has(id: string): boolean;
  /** A remote index loads these ids so has/sessionOf/layerOf answer for them; an in-process index knows them already. */
  prefetch?(ids: readonly string[]): Promise<void>;
  readonly size: number;

  observationCountsBySession(): MaybePromise<Map<string, number>>;
  documentKindCounts(): MaybePromise<{ memories: number; lessons: number }>;
  /** Synchronous because vector recovery re-checks it inside its critical section; a remote index answers from cached counts. */
  countMissingDocuments(
    hasDocument: (id: string) => boolean,
    since?: string | null,
    activeIds?: ReadonlySet<string>,
  ): number;
}

export interface LessonIndexPort {
  add(obs: CompressedObservation, layer?: SearchResultLayer): void;
  /** add() that sends nothing when the index already holds this content, so strengthening a lesson costs no write. */
  addIfChanged(obs: CompressedObservation, layer?: SearchResultLayer): void;
  remove(id: string): void;
  search(query: string, limit?: number, layer?: SearchLayer): MaybePromise<ScoredId[]>;
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

/** One stored image embedding, as mem::vision-embed builds it. */
export interface ImageEmbedding {
  imageRef: string;
  vector: number[];
  modelName: string;
  dimensions: number;
  updatedAt: string;
  sessionId?: string;
  observationId?: string;
}

export interface ImageSearchResult {
  imageRef: string;
  score: number;
  sessionId?: string;
  observationId?: string;
  updatedAt: string;
}

export interface ImageIndexPort {
  /** Idempotent upsert by imageRef. A remote index enqueues; it never blocks the caller. */
  put(embedding: ImageEmbedding): void;
  /** Idempotent: the image no longer appears in search. */
  remove(imageRef: string): void;
  /** Exact cosine top-K over the images that pass the session filter; `total` counts those images. Throws when the index is unreachable. */
  search(query: Float32Array, topK: number, sessionId?: string): Promise<{ results: ImageSearchResult[]; total: number }>;
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
  /** Needed by backends that live in another iii worker. */
  sdk?: IIIClient;
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
  /** Lessons in their own keyword index; absent in memory mode, where lessons.ts keeps its own. */
  readonly lessons?: LessonIndexPort | null;
  /** Image embeddings searched in the index; absent in memory mode, where vision-search reads the KV rows. */
  readonly images?: ImageIndexPort | null;
  openPersistence(): P;
}

export type MemorySearchRuntime = SearchRuntime<SearchIndex, VectorIndex, IndexPersistence>;

export const SEARCH_BACKEND_ENV = "AM_SEARCH_BACKEND";
const SEARCH_BACKENDS = ["memory", "disk"] as const;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];
export type SearchRuntimeFactory = (deps: SearchRuntimeDeps) => SearchRuntime;

const factories = new Map<Exclude<SearchBackend, "memory">, SearchRuntimeFactory>();

/** A backend other than memory registers itself here, so this module never imports it. */
export function registerSearchBackend(backend: Exclude<SearchBackend, "memory">, factory: SearchRuntimeFactory): void {
  factories.set(backend, factory);
}

export function configuredSearchBackend(env: Record<string, string | undefined> = { [SEARCH_BACKEND_ENV]: getEnvVar(SEARCH_BACKEND_ENV) }): SearchBackend {
  const raw = env[SEARCH_BACKEND_ENV]?.trim() || "memory";
  const backend = SEARCH_BACKENDS.find((name) => name === raw);
  if (!backend) {
    throw new Error(`${SEARCH_BACKEND_ENV}=${raw} is not a search backend this build supports (${SEARCH_BACKENDS.join(", ")})`);
  }
  return backend;
}

let current: SearchRuntime | null = null;

export function createSearchRuntime(
  deps: SearchRuntimeDeps,
  backend: SearchBackend = configuredSearchBackend(),
): SearchRuntime {
  if (backend !== "memory") {
    const factory = factories.get(backend);
    if (!factory) throw new Error(`${SEARCH_BACKEND_ENV}=${backend} is not registered in this build`);
    current = factory(deps);
    return current;
  }
  const vector = deps.embeddingProvider ? new VectorIndex() : null;
  let persistence: IndexPersistence | null = null;
  const runtime: MemorySearchRuntime = {
    backend,
    // Callers may have reached getSearchIndex() before boot; they must keep seeing the same index.
    keyword: current?.keyword instanceof SearchIndex ? current.keyword : new SearchIndex(),
    vector,
    openPersistence: () => (persistence ??= new IndexPersistence(deps.kv, vector, { requireRecoveryPlan: true })),
  };
  current = runtime;
  return runtime;
}

/** Before createSearchRuntime() runs (unit tests, early boot) this is a memory runtime with no vector store. */
export function getSearchRuntime(): SearchRuntime {
  if (!current) {
    current = { backend: "memory", keyword: new SearchIndex(), vector: null, openPersistence: noPersistence };
  }
  return current;
}

function noPersistence(): never {
  throw new Error("search runtime was not created with createSearchRuntime()");
}

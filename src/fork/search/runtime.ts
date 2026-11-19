import { logger } from "../../logger.js";
import { SHUTDOWN_FLUSH_TIMEOUT_MS } from "../../shutdown.js";
import type { IndexPersistenceStatus, PendingReplayResult, VectorLoadResult } from "../../state/index-persistence.js";
import { registerSearchBackend, type IndexPersistencePort, type LessonIndexPort, type SearchRuntime } from "../../state/search-ports.js";
import { iiiSearchClient, type SearchWorkerClient } from "./client.js";
import { RemoteImageIndex } from "./images.js";
import { DocLedger, SearchOutbox } from "./outbox.js";
import { RemoteKeywordIndex, RemoteVectorStore, StatsCache } from "./remote-index.js";

const SHUTDOWN_DRAIN_MS = SHUTDOWN_FLUSH_TIMEOUT_MS - 100;

/**
 * Disk mode has no index file to load, replay or save: Qdrant is the index
 * and boot does no rebuild. save() is the shutdown hook, so it drains every
 * outbox (docs, lessons, images) at once instead.
 */
export class DiskIndexPersistence implements IndexPersistencePort {
  constructor(private readonly outbox: SearchOutbox, private readonly otherOutboxes: readonly SearchOutbox[] = []) {}

  async load(): Promise<VectorLoadResult | null> {
    return null;
  }

  async prepareBackfill(): Promise<undefined> {
    return undefined;
  }

  async replayPendingLog(): Promise<PendingReplayResult> {
    return { entries: 0, added: 0, removed: 0, cleared: false, skipped: 0 };
  }

  async beginBackfill(): Promise<boolean> {
    return false;
  }

  async completeBackfill(): Promise<boolean> {
    return true;
  }

  isRecoveryPaused(): boolean {
    return false;
  }

  scheduleSave(): void {}

  async save(): Promise<void> {
    await Promise.all([this.outbox, ...this.otherOutboxes].map((outbox) => outbox.drainFor(SHUTDOWN_DRAIN_MS)));
  }

  stop(): void {}

  status(): IndexPersistenceStatus {
    return { saveIntervalMs: 0, saving: false, buckets: 0, pendingChanges: this.otherOutboxes.reduce((n, outbox) => n + outbox.pending, this.outbox.pending), vector: null, vectorCountShortfall: null };
  }
}

export interface DiskSearchRuntime extends SearchRuntime<RemoteKeywordIndex, RemoteVectorStore, DiskIndexPersistence> {
  readonly outbox: SearchOutbox;
  readonly stats: StatsCache;
  readonly lessons?: LessonIndexPort;
  readonly images?: RemoteImageIndex;
  /** Every outbox this runtime writes through: docs first, then lessons and images when present. */
  readonly outboxes: readonly SearchOutbox[];
}

/** Clients bound to the lessons and images collections; each gets its own outbox, so one writer and one ordered stream per store. */
export interface CollectionClients {
  lessons: SearchWorkerClient;
  images: SearchWorkerClient;
}

function createCollectionStores(clients: CollectionClients) {
  const lessonsOutbox = new SearchOutbox(clients.lessons);
  const imagesOutbox = new SearchOutbox(clients.images);
  return {
    outboxes: [lessonsOutbox, imagesOutbox],
    // Lesson recall reads search hits only, so this index never starts a stats poll.
    lessons: new RemoteKeywordIndex(clients.lessons, lessonsOutbox, new DocLedger(), new StatsCache(clients.lessons, lessonsOutbox)),
    images: new RemoteImageIndex(clients.images, imagesOutbox),
  };
}

export function createDiskSearchRuntime(
  client: SearchWorkerClient,
  withVectors: boolean,
  expectedDimensions?: number,
  collections?: CollectionClients,
): DiskSearchRuntime {
  const outbox = new SearchOutbox(client);
  const ledger = new DocLedger();
  const stats = new StatsCache(client, outbox);
  const extra = collections ? createCollectionStores(collections) : null;
  const persistence = new DiskIndexPersistence(outbox, extra?.outboxes);
  stats.start();
  void client.health().then(
    (health) => {
      if (!health.ok) logger.warn("search worker reports Qdrant unhealthy", { collection: health.collection, status: health.status, error: health.error });
      else if (expectedDimensions && health.dimensions !== expectedDimensions) {
        logger.error("Qdrant collection dimensions differ from the embedding provider; vector writes will fail", {
          collection: health.collection,
          collectionDimensions: health.dimensions,
          providerDimensions: expectedDimensions,
        });
      }
    },
    (err) => stats.markDegraded(err),
  );
  return {
    backend: "disk",
    keyword: new RemoteKeywordIndex(client, outbox, ledger, stats),
    vector: withVectors ? new RemoteVectorStore(client, outbox, ledger, stats) : null,
    ...(extra && { lessons: extra.lessons, images: extra.images }),
    openPersistence: () => persistence,
    outbox,
    outboxes: [outbox, ...(extra?.outboxes ?? [])],
    stats,
  };
}

registerSearchBackend("disk", ({ sdk, embeddingProvider }) => {
  if (!sdk) throw new Error("AM_SEARCH_BACKEND=disk needs the iii client to reach the am-search worker");
  return createDiskSearchRuntime(iiiSearchClient(sdk), embeddingProvider !== null, embeddingProvider?.dimensions, {
    lessons: iiiSearchClient(sdk, "lessons"),
    images: iiiSearchClient(sdk, "images"),
  });
});

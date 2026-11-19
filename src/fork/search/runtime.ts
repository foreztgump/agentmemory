import { logger } from "../../logger.js";
import { SHUTDOWN_FLUSH_TIMEOUT_MS } from "../../shutdown.js";
import type { IndexPersistenceStatus, PendingReplayResult, VectorLoadResult } from "../../state/index-persistence.js";
import { registerSearchBackend, type IndexPersistencePort, type LessonIndexPort, type SearchRuntime } from "../../state/search-ports.js";
import { iiiSearchClient, type SearchWorkerClient } from "./client.js";
import { RemoteImageIndex } from "./images.js";
import { DocLedger, SearchOutbox } from "./outbox.js";
import { BackendHealth, trackHealth } from "./health.js";
import { Reconciler } from "./reconcile.js";
import { ReembedLoop } from "./reembed.js";
import { RemoteKeywordIndex, RemoteVectorStore, StatsCache } from "./remote-index.js";
import { DiskBackendService } from "./service.js";
import { loadMaintenanceSettings, type MaintenanceSettings } from "./settings.js";

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

  private stopHooks: Array<() => void> = [];

  onStop(hook: () => void): void {
    this.stopHooks.push(hook);
  }

  stop(): void {
    for (const hook of this.stopHooks) hook();
  }

  status(): IndexPersistenceStatus {
    return { saveIntervalMs: 0, saving: false, buckets: 0, pendingChanges: this.otherOutboxes.reduce((n, outbox) => n + outbox.pending, this.outbox.pending), vector: null, vectorCountShortfall: null };
  }
}

export interface DiskSearchRuntime extends SearchRuntime<RemoteKeywordIndex, RemoteVectorStore, DiskIndexPersistence> {
  readonly outbox: SearchOutbox;
  readonly stats: StatsCache;
  readonly health: BackendHealth;
  readonly reconciler: Reconciler;
  readonly reembed: ReembedLoop;
  readonly service: DiskBackendService;
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
  const lessonsHealth = new BackendHealth();
  const lessonsClient = trackHealth(clients.lessons, lessonsHealth);
  const lessonsOutbox = new SearchOutbox(lessonsClient);
  const imagesOutbox = new SearchOutbox(clients.images);
  return {
    outboxes: [lessonsOutbox, imagesOutbox],
    // Lesson recall reads search hits only, so this index never starts a stats poll.
    // Lesson health logs failures separately: backend status and reconcile cover docs only (lessons and images reconcile is TEE-1196).
    lessons: new RemoteKeywordIndex(lessonsClient, lessonsOutbox, new DocLedger(), new StatsCache(lessonsClient, lessonsOutbox), lessonsHealth),
    images: new RemoteImageIndex(clients.images, imagesOutbox),
  };
}

export function createDiskSearchRuntime(
  rawClient: SearchWorkerClient,
  withVectors: boolean,
  expectedDimensions?: number,
  collections?: CollectionClients,
  maintenance: MaintenanceSettings = loadMaintenanceSettings(process.env),
): DiskSearchRuntime {
  const health = new BackendHealth();
  const client = trackHealth(rawClient, health);
  const outbox = new SearchOutbox(client);
  const ledger = new DocLedger();
  const stats = new StatsCache(client, outbox);
  const extra = collections ? createCollectionStores(collections) : null;
  const persistence = new DiskIndexPersistence(outbox, extra?.outboxes);
  stats.start();
  health.onRecover(() => void stats.refresh());
  void client.health().then(
    (h) => {
      if (!h.ok) logger.warn("search worker reports Qdrant unhealthy", { collection: h.collection, status: h.status, error: h.error });
      else if (expectedDimensions && h.dimensions !== expectedDimensions) {
        logger.error("Qdrant collection dimensions differ from the embedding provider; vector writes will fail", {
          collection: h.collection,
          collectionDimensions: h.dimensions,
          providerDimensions: expectedDimensions,
        });
      }
    },
    () => {},
  );
  const keyword = new RemoteKeywordIndex(client, outbox, ledger, stats, health);
  const vector = withVectors ? new RemoteVectorStore(client, outbox, ledger, stats, health) : null;
  const reconciler = new Reconciler({ client, keyword, outbox, health, intervalMs: maintenance.reconcileIntervalMs, sweepPerPass: maintenance.sweepPerPass });
  const reembed = new ReembedLoop({ client, keyword, vector, health, perMinute: maintenance.reembedPerMinute });
  const service = new DiskBackendService({ client, health, stats, outbox, reconciler, reembed, withVectors });
  persistence.onStop(() => void service.stop());
  return {
    backend: "disk",
    keyword,
    vector,
    ...(extra && { lessons: extra.lessons, images: extra.images }),
    openPersistence: () => persistence,
    outbox,
    outboxes: [outbox, ...(extra?.outboxes ?? [])],
    stats,
    health,
    reconciler,
    reembed,
    service,
  };
}

registerSearchBackend("disk", ({ sdk, embeddingProvider }) => {
  if (!sdk) throw new Error("AM_SEARCH_BACKEND=disk needs the iii client to reach the am-search worker");
  return createDiskSearchRuntime(iiiSearchClient(sdk), embeddingProvider !== null, embeddingProvider?.dimensions, {
    lessons: iiiSearchClient(sdk, "lessons"),
    images: iiiSearchClient(sdk, "images"),
  });
});

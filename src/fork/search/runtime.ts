import { logger } from "../../logger.js";
import type { IndexPersistenceStatus, PendingReplayResult, VectorLoadResult } from "../../state/index-persistence.js";
import { registerSearchBackend, type IndexPersistencePort, type SearchRuntime } from "../../state/search-ports.js";
import { iiiSearchClient, type SearchWorkerClient } from "./client.js";
import { DocLedger, SearchOutbox } from "./outbox.js";
import { RemoteKeywordIndex, RemoteVectorStore, StatsCache } from "./remote-index.js";

const SHUTDOWN_DRAIN_MS = 5000;

/**
 * Disk mode has no index file to load, replay or save: Qdrant is the index
 * and boot does no rebuild. save() is the shutdown hook, so it drains the
 * outbox instead.
 */
export class DiskIndexPersistence implements IndexPersistencePort {
  constructor(private readonly outbox: SearchOutbox) {}

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
    await this.outbox.drainFor(SHUTDOWN_DRAIN_MS);
  }

  stop(): void {}

  status(): IndexPersistenceStatus {
    return { saveIntervalMs: 0, saving: false, buckets: 0, pendingChanges: this.outbox.pending, vector: null, vectorCountShortfall: null };
  }
}

export interface DiskSearchRuntime extends SearchRuntime<RemoteKeywordIndex, RemoteVectorStore, DiskIndexPersistence> {
  readonly outbox: SearchOutbox;
  readonly stats: StatsCache;
}

export function createDiskSearchRuntime(client: SearchWorkerClient, withVectors: boolean, expectedDimensions?: number): DiskSearchRuntime {
  const outbox = new SearchOutbox(client);
  const ledger = new DocLedger();
  const stats = new StatsCache(client, outbox);
  const persistence = new DiskIndexPersistence(outbox);
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
    openPersistence: () => persistence,
    outbox,
    stats,
  };
}

registerSearchBackend("disk", ({ sdk, embeddingProvider }) => {
  if (!sdk) throw new Error("AM_SEARCH_BACKEND=disk needs the iii client to reach the am-search worker");
  return createDiskSearchRuntime(iiiSearchClient(sdk), embeddingProvider !== null, embeddingProvider?.dimensions);
});

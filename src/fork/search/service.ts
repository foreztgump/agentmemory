import { logger } from "../../logger.js";
import type { DegradedNotice, SearchBackendService, SearchBackendStatus, ServiceHooks } from "./backend-status.js";
import type { SearchWorkerClient } from "./client.js";
import type { BackendHealth } from "./health.js";
import type { SearchOutbox } from "./outbox.js";
import type { Reconciler } from "./reconcile.js";
import type { ReembedLoop } from "./reembed.js";
import type { StatsCache } from "./remote-index.js";

/** Below the status route's own 5 s deadline, so a hung worker reads as degraded rather than as a missing block. */
const PROBE_MS = 3000;
const RANKING_READY_TIMEOUT_MS = 120_000;
const RANKING_READY_POLL_MS = 500;

export class DiskBackendService implements SearchBackendService {
  private hooks: ServiceHooks | null = null;

  constructor(
    private readonly parts: {
      client: SearchWorkerClient;
      health: BackendHealth;
      stats: StatsCache;
      outbox: SearchOutbox;
      reconciler: Reconciler;
      reembed: ReembedLoop;
      withVectors: boolean;
    },
  ) {}

  start(hooks: ServiceHooks): void {
    if (this.hooks) return;
    this.hooks = hooks;
    this.parts.reconciler.start(hooks.kv);
    this.parts.reembed.start(hooks);
  }

  async stop(): Promise<void> {
    this.parts.reconciler.stop();
    this.parts.reembed.stop();
  }

  async whenRankingReady(timeoutMs = RANKING_READY_TIMEOUT_MS, pollMs = RANKING_READY_POLL_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stats = await Promise.race([
          this.parts.client.stats().catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
          }),
        ]);
        if (stats && stats.rankingReady !== false) return;
      } catch {} finally {
        clearTimeout(timer);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
    logger.warn("search worker ranking statistics not ready before boot deadline; continuing", { timeoutMs });
  }

  async status(): Promise<SearchBackendStatus> {
    const { client, health, stats, outbox, reconciler, reembed } = this.parts;
    // While the circuit is open the last failure stands; the probe runs once per retry window.
    if (health.ok || health.allowRequest()) await health.probe(client, PROBE_MS);
    const now = health.current;
    const missing = reconciler.missing();
    const vectorsTracked = this.parts.withVectors && (this.hooks?.embeddingEnabled() ?? false);
    return {
      backend: "disk",
      state: now.ok ? "healthy" : "degraded",
      reason: now.ok ? null : now.reason,
      since: now.since,
      documents: stats.value.docs,
      vectors: stats.value.vectors,
      pendingWrites: outbox.pending,
      droppedWrites: outbox.counters.spilled,
      missingDocuments: missing ? missing.observations + missing.memories : null,
      missing,
      missingVectors: vectorsTracked ? stats.value.missingVectors : null,
      reconcile: reconciler.report(),
      reembed: reembed.report(),
    };
  }

  degradedNotice(): DegradedNotice | null {
    const now = this.parts.health.current;
    if (now.ok) return null;
    return { backend: "disk", legs: this.parts.withVectors ? ["keyword", "vector"] : ["keyword"], reason: now.reason };
  }
}

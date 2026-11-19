import { logger } from "../../logger.js";
import { KV } from "../../state/schema.js";
import type { ReembedReport, ServiceHooks } from "./backend-status.js";
import type { SearchWorkerClient } from "./client.js";
import { docOfRecord } from "./doc-of-record.js";
import type { BackendHealth } from "./health.js";
import type { RemoteKeywordIndex, RemoteVectorStore } from "./remote-index.js";

const BATCH = 32;
const FIRST_DELAY_MS = 10_000;
const IDLE_MS = 30_000;
/** Between pages that yielded nothing to embed, so a backlog of cooled-down or unindexable ids is not rescanned in a tight loop. */
const SKIP_PAGE_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** An id whose embedding failed is left alone this long, so one bad record cannot spend the quota in a loop. */
const COOLDOWN_MS = 10 * 60_000;

export interface ReembedDeps {
  client: SearchWorkerClient;
  keyword: RemoteKeywordIndex;
  vector: RemoteVectorStore | null;
  health: BackendHealth;
  perMinute: number;
}

/**
 * Embeds documents the index holds without a vector, at most perMinute a
 * minute. The work comes from the index's own `dense=false` filter, so a
 * document with a vector is never embedded again; the record is re-read and
 * its rev compared, so a vector is only written for the content indexed now.
 */
export class ReembedLoop {
  private hooks: ServiceHooks | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private cursor: string | undefined;
  private failures = 0;
  private cooldown = new Map<string, number>();
  private counters = { embedded: 0, failed: 0 };
  private state: ReembedReport["state"];

  constructor(private readonly deps: ReembedDeps) {
    this.state = deps.perMinute === 0 ? "off" : "idle";
  }

  start(hooks: ServiceHooks): void {
    if (this.hooks) return;
    this.hooks = hooks;
    if (this.deps.perMinute > 0) this.schedule(FIRST_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  report(): ReembedReport {
    return { state: this.state, perMinute: this.deps.perMinute, ...this.counters };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.step().then((next) => this.schedule(next));
    }, delayMs);
    this.timer.unref?.();
  }

  /** One page of the backlog; resolves with the delay before the next. */
  async step(): Promise<number> {
    const { client, keyword, vector, health, perMinute } = this.deps;
    const hooks = this.hooks;
    if (!hooks || perMinute === 0) return IDLE_MS;
    if (!vector || !hooks.embeddingEnabled()) {
      this.state = "no-embedding-provider";
      return IDLE_MS;
    }
    if (!health.ok) {
      this.state = "paused-degraded";
      return IDLE_MS;
    }
    const started = Date.now();
    try {
      const page = await client.scanMissingVectors(this.cursor, Math.min(BATCH, perMinute));
      this.cursor = page.next;
      for (const [id, until] of this.cooldown) if (until <= started) this.cooldown.delete(id);
      const candidates = page.items.filter((item) => (this.cooldown.get(item.id) ?? 0) <= started && !vector.has(item.id));
      await keyword.prefetch(candidates.map((item) => item.id));
      const rows = await Promise.all(candidates.map((item) => hooks.kv.get(item.layer === "memory" ? KV.memories : KV.observations(item.sessionId), item.id)));
      const jobs: Parameters<ServiceHooks["embedBatch"]>[0] = [];
      for (const [index, item] of candidates.entries()) {
        const kind = item.layer === "memory" ? "memory" : "observation";
        const doc = docOfRecord(kind, rows[index]);
        if (!doc) continue;
        // The index holds older content: write the doc first so the vector is fenced against the new rev.
        if (!keyword.has(item.id) || keyword.revOf(item.id) !== doc.rev) keyword.add(doc.obs, doc.layer);
        jobs.push({ id: item.id, sessionId: item.sessionId, text: doc.embedText, context: { kind, logId: item.id } });
      }
      if (jobs.length === 0) {
        if (page.next) return SKIP_PAGE_MS;
        this.state = "idle";
        return IDLE_MS;
      }
      this.state = "running";
      const result = await hooks.embedBatch(jobs);
      this.counters.embedded += result.ok;
      this.counters.failed += result.fail;
      const cooldownUntil = Date.now() + COOLDOWN_MS;
      for (const job of jobs) if (!vector.has(job.id)) this.cooldown.set(job.id, cooldownUntil);
      if (result.ok === 0 && result.fail > 0) {
        this.failures++;
      } else {
        this.failures = 0;
      }
      const pace = (jobs.length * 60_000) / perMinute - (Date.now() - started);
      return Math.max(0, pace, this.backoffMs());
    } catch (err) {
      this.failures++;
      this.state = health.ok ? "idle" : "paused-degraded";
      logger.warn("vector re-embed step failed; retrying with backoff", { error: err instanceof Error ? err.message : String(err) });
      return this.backoffMs();
    }
  }

  private backoffMs(): number {
    return this.failures === 0 ? 0 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.failures);
  }
}

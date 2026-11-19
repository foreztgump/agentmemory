import type { CompressedObservation } from "../../types.js";
import { logger } from "../../logger.js";
import { getSearchResultLayer, type SearchLayer, type SearchResultLayer } from "../../state/search-layer.js";
import type { KeywordIndexPort, RevisionToken, ScoredId, VectorStorePort, VectorToken } from "../../state/search-ports.js";
import { termSourceOf } from "../../state/term-extraction.js";
import { float32ToBase64 } from "../../state/vector-index.js";
import type { SearchWorkerClient } from "./client.js";
import type { DocLedger, SearchOutbox } from "./outbox.js";
import { contentRev, type Hit, type StatsResult } from "./protocol.js";

/** Read-your-writes bound: a search waits at most this long for queued writes. */
export const READ_YOUR_WRITES_MS = 1000;
const STATS_REFRESH_MS = 15_000;

const toScored = (hits: Hit[]): ScoredId[] => hits.map((h) => ({ obsId: h.id, sessionId: h.sessionId, score: h.score }));

/** Counts from the worker, polled and bumped optimistically between polls so size checks stay synchronous. */
export class StatsCache {
  value: StatsResult = { docs: 0, vectors: 0, memories: 0, lessons: 0, missingVectors: 0 };
  degraded = false;
  lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly client: SearchWorkerClient, private readonly outbox: SearchOutbox) {}

  start(): void {
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), STATS_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<StatsResult> {
    try {
      await this.outbox.drainFor(READ_YOUR_WRITES_MS);
      this.value = await this.client.stats();
      this.degraded = false;
      this.lastError = null;
    } catch (err) {
      this.markDegraded(err);
    }
    return this.value;
  }

  markDegraded(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (!this.degraded) logger.warn("search worker unavailable; keyword search returns no hits until it recovers", { error: message });
    this.degraded = true;
    this.lastError = message;
  }

  bump(field: "docs" | "vectors", delta: number): void {
    this.value = { ...this.value, [field]: Math.max(0, this.value[field] + delta) };
  }
}

export class RemoteKeywordIndex implements KeywordIndexPort {
  constructor(
    private readonly client: SearchWorkerClient,
    private readonly outbox: SearchOutbox,
    private readonly ledger: DocLedger,
    private readonly stats: StatsCache,
  ) {}

  add(obs: CompressedObservation, layer: SearchResultLayer = "observation"): void {
    const fields = termSourceOf(obs);
    const rev = contentRev(fields);
    const previous = this.ledger.get(obs.id);
    this.ledger.replace(obs.id, { rev, sessionId: obs.sessionId, layer, vec: previous?.vec });
    if (typeof previous?.rev !== "string") this.stats.bump("docs", 1);
    const ts = Date.parse(obs.timestamp ?? "");
    this.outbox.put({ k: "doc", id: obs.id, sessionId: obs.sessionId, layer, ts: Number.isFinite(ts) ? ts : Date.now(), rev, fields });
  }

  remove(id: string): void {
    const previous = this.ledger.get(id);
    this.ledger.replace(id, { rev: null });
    if (typeof previous?.rev === "string") this.stats.bump("docs", -1);
    if (previous?.vec) this.stats.bump("vectors", -1);
    this.outbox.put({ k: "del", id });
  }

  clear(): void {
    this.outbox.clear("all");
    this.ledger.clear();
    this.stats.value = { docs: 0, vectors: 0, memories: 0, lessons: 0, missingVectors: 0 };
  }

  async search(query: string, limit = 20, layer: SearchLayer = "all"): Promise<ScoredId[]> {
    await this.outbox.drainFor(READ_YOUR_WRITES_MS);
    try {
      const hits = await this.client.keyword(query, limit, layer);
      this.stats.degraded = false;
      return toScored(hits);
    } catch (err) {
      // HybridSearch still has the vector and graph streams; a thrown error here would fail the whole request.
      this.stats.markDegraded(err);
      return [];
    }
  }

  watchRevision(id: string): RevisionToken {
    return this.ledger.watch(id);
  }

  invalidateRevision(id: string): void {
    this.ledger.replace(id, { ...this.ledger.get(id) });
  }

  layerOf(id: string): SearchResultLayer | undefined {
    const entry = this.ledger.get(id);
    if (entry?.rev === null) return undefined;
    return entry?.layer ?? getSearchResultLayer(id, entry?.sessionId ?? "");
  }

  sessionOf(id: string): string | undefined {
    const entry = this.ledger.get(id);
    return entry?.rev === null ? undefined : entry?.sessionId;
  }

  has(id: string): boolean {
    return typeof this.ledger.get(id)?.rev === "string";
  }

  get size(): number {
    return this.stats.value.docs;
  }

  async observationCountsBySession(): Promise<Map<string, number>> {
    await this.outbox.drainFor(READ_YOUR_WRITES_MS);
    try {
      return new Map(await this.client.sessionCounts());
    } catch (err) {
      this.stats.markDegraded(err);
      return new Map();
    }
  }

  async documentKindCounts(): Promise<{ memories: number; lessons: number }> {
    const { memories, lessons } = await this.stats.refresh();
    return { memories, lessons };
  }

  /** Observations and memories without a vector, as of the last stats poll. Disk mode has no recovery window. */
  countMissingDocuments(): number {
    return this.stats.value.missingVectors;
  }
}

export class RemoteVectorStore implements VectorStorePort {
  /** Vectors dropped here because this process does not know the record's current rev. */
  unfenced = 0;

  constructor(
    private readonly client: SearchWorkerClient,
    private readonly outbox: SearchOutbox,
    private readonly ledger: DocLedger,
    private readonly stats: StatsCache,
  ) {}

  add(obsId: string, _sessionId: string, embedding: Float32Array): void {
    const entry = this.ledger.get(obsId);
    if (typeof entry?.rev !== "string") {
      // Without the rev the worker cannot fence this vector; backfill embeds it once the record is indexed here.
      this.unfenced++;
      return;
    }
    if (!entry.vec) this.stats.bump("vectors", 1);
    entry.vec = {};
    this.outbox.put({ k: "vec", id: obsId, rev: entry.rev, f32b64: float32ToBase64(embedding) });
  }

  remove(obsId: string): void {
    const entry = this.ledger.get(obsId);
    if (entry?.vec) this.stats.bump("vectors", -1);
    if (entry) entry.vec = undefined;
    this.outbox.put({ k: "vec-del", id: obsId });
  }

  has(obsId: string): boolean {
    return this.ledger.get(obsId)?.vec !== undefined;
  }

  get(obsId: string): VectorToken | undefined {
    return this.ledger.get(obsId)?.vec;
  }

  async search(query: Float32Array, limit = 20, layer: SearchLayer = "all"): Promise<ScoredId[]> {
    await this.outbox.drainFor(READ_YOUR_WRITES_MS);
    return toScored(await this.client.vector(float32ToBase64(query), limit, layer));
  }

  get size(): number {
    return this.stats.value.vectors;
  }

  clear(): void {
    this.outbox.clear("vectors");
    for (const entry of this.ledger.values()) entry.vec = undefined;
    this.stats.value = { ...this.stats.value, vectors: 0 };
  }
}

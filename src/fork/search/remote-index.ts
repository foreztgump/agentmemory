import type { CompressedObservation } from "../../types.js";
import { logger } from "../../logger.js";
import { getSearchResultLayer, type SearchLayer, type SearchResultLayer } from "../../state/search-layer.js";
import type { KeywordIndexPort, RevisionToken, ScoredId, VectorStorePort, VectorToken } from "../../state/search-ports.js";
import { termSourceOf } from "../../state/term-extraction.js";
import { float32ToBase64 } from "../../state/vector-index.js";
import type { SearchWorkerClient } from "./client.js";
import type { DocLedger, SearchOutbox } from "./outbox.js";
import { contentRev, docOp, type Hit, type StatsResult } from "./protocol.js";

/** Read-your-writes bound: a search waits at most this long for queued writes. */
export const READ_YOUR_WRITES_MS = 1000;
const STATS_REFRESH_MS = 15_000;

const toScored = (hits: Hit[]): ScoredId[] => hits.map((h) => ({ obsId: h.id, sessionId: h.sessionId, score: h.score }));

const LOOKUP_BATCH = 1000;

const EMPTY_STATS: StatsResult = { docs: 0, vectors: 0, memories: 0, lessons: 0, missingVectors: 0 };

/** Counts from the worker, polled and bumped optimistically between polls so size checks stay synchronous. */
export class StatsCache {
  value: StatsResult = EMPTY_STATS;
  degraded = false;
  lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Running sum of every optimistic bump, so a poll can re-apply the ones made while it was in flight. */
  private bumped = { docs: 0, vectors: 0 };
  private resets = 0;
  private polls = 0;
  private landedPoll = 0;

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

  /**
   * A snapshot can predate writes this process made while the poll was in
   * flight, so those bumps are added back on top of it; a poll that lands
   * after a newer one or after a clear is discarded.
   */
  async refresh(): Promise<StatsResult> {
    try {
      await this.outbox.drainFor(READ_YOUR_WRITES_MS);
      const poll = ++this.polls;
      const resets = this.resets;
      const before = { ...this.bumped };
      const snapshot = await this.client.stats();
      if (resets === this.resets && poll > this.landedPoll) {
        this.landedPoll = poll;
        this.value = {
          ...snapshot,
          docs: Math.max(0, snapshot.docs + this.bumped.docs - before.docs),
          vectors: Math.max(0, snapshot.vectors + this.bumped.vectors - before.vectors),
        };
      }
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
    this.bumped[field] += delta;
    this.value = { ...this.value, [field]: Math.max(0, this.value[field] + delta) };
  }

  reset(value: Partial<StatsResult>): void {
    this.resets++;
    this.value = { ...this.value, ...value };
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
    const op = docOp(obs, layer);
    const previous = this.ledger.get(obs.id);
    this.ledger.replace(obs.id, { rev: op.rev, sessionId: obs.sessionId, layer, vec: previous?.vec });
    if (typeof previous?.rev !== "string") this.stats.bump("docs", 1);
    this.outbox.put(op);
  }

  /** add() that sends nothing when the ledger already holds this content, as for a lesson whose confidence changed but not its text. */
  addIfChanged(obs: CompressedObservation, layer: SearchResultLayer = "observation"): void {
    if (this.ledger.get(obs.id)?.rev === contentRev(termSourceOf(obs))) return;
    this.add(obs, layer);
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
    this.stats.reset(EMPTY_STATS);
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

  /**
   * After a restart the ledger is empty while Qdrant holds the documents, so
   * ids this process has not touched are read from the worker in batches;
   * has, sessionOf and layerOf then answer for them.
   */
  async prefetch(ids: readonly string[]): Promise<void> {
    const unknown = [...new Set(ids)].filter((id) => this.ledger.get(id)?.rev === undefined);
    for (let i = 0; i < unknown.length; i += LOOKUP_BATCH) {
      const epoch = this.ledger.epoch;
      let items: Awaited<ReturnType<SearchWorkerClient["lookup"]>>;
      try {
        items = await this.client.lookup(unknown.slice(i, i + LOOKUP_BATCH));
      } catch (err) {
        this.stats.markDegraded(err);
        return;
      }
      if (epoch !== this.ledger.epoch) return;
      for (const item of items) {
        // An add or remove made while the lookup ran is newer than the worker's answer.
        if (this.ledger.get(item.id)?.rev !== undefined) continue;
        this.ledger.replace(item.id, { rev: item.rev, sessionId: item.sessionId, layer: item.layer });
      }
    }
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
    this.stats.reset({ vectors: 0 });
  }
}

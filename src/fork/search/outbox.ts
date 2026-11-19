import type { SearchResultLayer } from "../../state/search-layer.js";
import { logger } from "../../logger.js";
import type { SearchWorkerClient } from "./client.js";
import { nextOpVersion, seedOpVersion, type ClearScope, type ContentRev, type DelOp, type DocOp, type Op, type VecDelOp, type VecOp } from "./protocol.js";

export interface OutboxLimits {
  maxOps: number;
  maxBytes: number;
  flushMs: number;
  batch: number;
}

export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = { maxOps: 5000, maxBytes: 64 * 1024 * 1024, flushMs: 250, batch: 256 };

const MAX_BACKOFF_MS = 5000;

/** Pending writes for one id: at most one document change and one vector change, flushed in that order. */
interface Slot {
  firstSeq: number;
  lastSeq: number;
  doc?: DocOp | DelOp;
  vec?: VecOp | VecDelOp;
  bytes: number;
}

function merge(slot: Slot, op: Op): void {
  switch (op.k) {
    case "doc":
      slot.doc = op;
      break;
    case "del":
      slot.doc = op;
      slot.vec = undefined;
      break;
    default:
      slot.vec = op;
  }
}

function slotBytes(slot: Slot): number {
  const doc = slot.doc?.k === "doc" ? JSON.stringify(slot.doc.fields).length : 0;
  const vec = slot.vec?.k === "vec" ? slot.vec.f32b64.length : 0;
  return 128 + doc + vec;
}

export interface OutboxCounters {
  /** Ops dropped because the outbox hit its cap while the worker was unreachable. A healthy worker never loses a write here. */
  spilled: number;
  /** Vector changes the worker refused because their revision or invocation lost its claim. */
  fenced: number;
  /** Ops the worker rejected as malformed. */
  failed: number;
}

/**
 * The only write path to the search worker. put() never blocks: it coalesces
 * by id and a single flusher sends batches in first-touch order, so writes
 * reach Qdrant serially. A write lost to a crash or a spill is repaired from
 * the records by reconcile (TEE-1169).
 */
export class SearchOutbox {
  private slots = new Map<string, Slot>();
  private bytes = 0;
  private seq = 0;
  private inFlightMinSeq = Infinity;
  private pendingClear: { scope: ClearScope; seq: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private failures = 0;
  private versionFloor: Promise<void> | null = null;
  private waiters: Array<{ target: number; resolve: () => void }> = [];
  readonly counters: OutboxCounters = { spilled: 0, fenced: 0, failed: 0 };

  constructor(private readonly client: SearchWorkerClient, private readonly limits: OutboxLimits = DEFAULT_OUTBOX_LIMITS) {}

  get pending(): number {
    return this.slots.size + (this.pendingClear ? 1 : 0);
  }

  put(op: Op): void {
    const seq = ++this.seq;
    let slot = this.slots.get(op.id);
    if (!slot) {
      slot = { firstSeq: seq, lastSeq: seq, bytes: 0 };
      this.slots.set(op.id, slot);
    }
    slot.lastSeq = seq;
    this.bytes -= slot.bytes;
    merge(slot, op);
    slot.bytes = slotBytes(slot);
    this.bytes += slot.bytes;
    if (this.failures > 0) {
      if (this.overCap()) this.spill(seq);
      this.schedule(this.limits.flushMs);
    } else if (this.slots.size >= this.limits.batch) {
      this.flushNow();
    } else {
      this.schedule(this.limits.flushMs);
    }
  }

  /** Writes queued before this call are dropped; the worker clears before any later write. */
  clear(scope: ClearScope): void {
    if (scope === "all") {
      this.slots.clear();
      this.bytes = 0;
    } else {
      this.bytes = 0;
      for (const [id, slot] of this.slots) {
        slot.vec = undefined;
        if (!slot.doc) this.slots.delete(id);
        else {
          slot.bytes = slotBytes(slot);
          this.bytes += slot.bytes;
        }
      }
    }
    const merged: ClearScope = scope === "all" || this.pendingClear?.scope === "all" ? "all" : "vectors";
    this.pendingClear = { scope: merged, seq: ++this.seq };
    this.notify();
    this.schedule(0);
  }

  /** Resolves once every write queued before the call has reached the worker, or after maxWaitMs. */
  async drainFor(maxWaitMs: number): Promise<void> {
    const target = this.seq;
    if (this.drained(target)) return;
    if (this.failures === 0) this.flushNow();
    await new Promise<void>((resolve) => {
      const waiter = { target, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve();
      }, maxWaitMs).unref?.();
    });
  }

  async stop(maxWaitMs: number): Promise<void> {
    await this.drainFor(maxWaitMs);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private drained(target: number): boolean {
    const firstQueued = this.slots.values().next().value?.firstSeq ?? Infinity;
    return Math.min(firstQueued, this.inFlightMinSeq, this.pendingClear?.seq ?? Infinity) > target;
  }

  private notify(): void {
    this.waiters = this.waiters.filter((w) => {
      if (!this.drained(w.target)) return true;
      w.resolve();
      return false;
    });
  }

  /** A full batch or a waiting reader does not wait out the flush delay; a backoff still applies. */
  private flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushing = this.run().finally(() => {
        this.flushing = null;
        this.notify();
        if (this.pending > 0) this.schedule(this.failures > 0 ? this.backoffMs() : this.limits.flushMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private backoffMs(): number {
    const base = Math.min(MAX_BACKOFF_MS, this.limits.flushMs * 2 ** this.failures);
    return base / 2 + Math.random() * (base / 2);
  }

  private async run(): Promise<void> {
    while (this.pending > 0) {
      if (this.pendingClear) {
        const clear = this.pendingClear;
        try {
          await this.client.clear(clear.scope);
        } catch (err) {
          this.recordFailure(err);
          return;
        }
        if (this.pendingClear === clear) this.pendingClear = null;
        this.failures = 0;
        this.notify();
        continue;
      }
      const batch = this.take();
      const sentThrough = this.seq;
      this.inFlightMinSeq = batch[0]![1].firstSeq;
      try {
        // A fresh version per invocation: a retry outranks the attempt it replaces if that one still lands.
        const ops = batch.flatMap(([, slot]) => [slot.doc, slot.vec].filter((op): op is Op => op !== undefined));
        // Before the first send, versions start above any stored: the clock may be behind the last process's.
        // A failed read fails the send, so the batch stays queued and the read retries with it.
        await (this.versionFloor ??= this.seedVersionFloor().catch((error: unknown) => {
          this.versionFloor = null;
          throw error;
        }));
        const result = await this.client.apply(ops, nextOpVersion());
        this.failures = 0;
        this.counters.fenced += result.fenced.length;
        this.counters.failed += result.failed.length;
        for (const f of result.failed) logger.warn("search worker rejected a write", { id: f.id, error: f.error });
      } catch (err) {
        this.requeue(batch);
        this.recordFailure(err);
        if (this.overCap()) this.spill(sentThrough);
        return;
      } finally {
        this.inFlightMinSeq = Infinity;
      }
      this.notify();
    }
  }

  private async seedVersionFloor(): Promise<void> {
    const floor = await this.client.maxVersion?.();
    if (floor !== undefined) seedOpVersion(floor);
  }

  private take(): Array<[string, Slot]> {
    const batch: Array<[string, Slot]> = [];
    for (const entry of this.slots) {
      if (batch.length >= this.limits.batch) break;
      batch.push(entry);
    }
    for (const [id, slot] of batch) {
      this.slots.delete(id);
      this.bytes -= slot.bytes;
    }
    return batch;
  }

  /**
   * A failed batch goes back to the front; anything queued for the same ids since then wins.
   * take() runs only with no clear pending, so a pending clear is newer than the batch and
   * erases what it covers: all of it for "all", its vectors for "vectors".
   */
  private requeue(batch: Array<[string, Slot]>): void {
    if (this.pendingClear?.scope === "all") return;
    if (this.pendingClear?.scope === "vectors") {
      batch = batch.filter(([, slot]) => {
        slot.vec = undefined;
        slot.bytes = slotBytes(slot);
        return slot.doc !== undefined;
      });
    }
    const newer = this.slots;
    this.slots = new Map(batch);
    this.bytes = batch.reduce((n, [, slot]) => n + slot.bytes, 0);
    for (const [id, slot] of newer) {
      const old = this.slots.get(id);
      if (!old) {
        this.slots.set(id, slot);
        this.bytes += slot.bytes;
        continue;
      }
      this.bytes -= old.bytes;
      old.lastSeq = slot.lastSeq;
      if (slot.doc) merge(old, slot.doc);
      if (slot.vec) merge(old, slot.vec);
      old.bytes = slotBytes(old);
      this.bytes += old.bytes;
    }
  }

  private recordFailure(err: unknown): void {
    this.failures++;
    if (this.failures === 1 || this.failures % 20 === 0) {
      logger.warn("search worker unreachable; writes stay queued", {
        pending: this.slots.size,
        failures: this.failures,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private overCap(): boolean {
    return this.slots.size > this.limits.maxOps || this.bytes > this.limits.maxBytes;
  }

  // While the worker is unreachable the heap bound is the invariant: the
  // index is derived from the records, so dropped writes are repaired by
  // reconcile rather than kept here. A healthy worker drains a burst of any
  // size. While it is unreachable the cap wins and the oldest queued writes
  // go first, including writes queued after the last failed send.
  // ponytail: a healthy burst is held in full until it drains; backpressure
  // on the bulk paths (indexRecords) would bound it if an import outgrows the heap.
  private spill(throughSeq: number): void {
    let dropped = 0;
    for (const [id, slot] of this.slots) {
      if (!this.overCap()) break;
      if (slot.lastSeq > throughSeq) continue;
      this.slots.delete(id);
      this.bytes -= slot.bytes;
      dropped++;
    }
    if (dropped === 0) return;
    this.counters.spilled += dropped;
    logger.error("search outbox full; dropped queued writes until reconcile repairs them", { dropped, spilledTotal: this.counters.spilled });
    this.notify();
  }
}

export interface DocEntry {
  /** string: indexed with this content; null: removed; undefined: not known here. */
  rev?: ContentRev | null;
  sessionId?: string;
  layer?: SearchResultLayer;
  /** Identity of the last vector written from this process; replaced on every vector add or remove. */
  vec?: object;
}

/**
 * What this process knows about recently written documents, bounded by
 * `cap`. It answers has/sessionOf/layerOf and revision tokens; correctness of
 * vector writes does not depend on it, because the worker fences by rev.
 */
export class DocLedger {
  private entries = new Map<string, DocEntry>();
  private evictions = 0;
  private clears = 0;

  constructor(private readonly cap = 20_000) {}

  get(id: string): DocEntry | undefined {
    return this.entries.get(id);
  }

  /** Changes on every clear(), so a slow reader can tell its answer predates one. */
  get epoch(): number {
    return this.clears;
  }

  replace(id: string, entry: DocEntry): void {
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (this.entries.size > this.cap) {
      this.entries.delete(this.entries.keys().next().value!);
      this.evictions++;
    }
  }

  clear(): void {
    this.entries.clear();
    this.clears++;
  }

  values(): IterableIterator<DocEntry> {
    return this.entries.values();
  }

  /** Current while nothing touched the id; an evicted or cleared entry fails safe as stale. */
  watch(id: string): { isCurrent(): boolean; release(): void } {
    const entry = this.entries.get(id);
    const evictions = this.evictions;
    const clears = this.clears;
    return {
      isCurrent: () =>
        this.clears === clears && this.entries.get(id) === entry && (entry !== undefined || this.evictions === evictions),
      release: () => {},
    };
  }
}

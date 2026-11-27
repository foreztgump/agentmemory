import { logger } from "../../logger.js";
import type { SearchResultLayer } from "../../state/search-layer.js";
import type { Qdrant } from "./qdrant.js";
import { TOMBSTONE } from "./versioned.js";

export const LAYERS: SearchResultLayer[] = ["memory", "observation", "lesson", "insight"];
export const LIVE_DOCS = { must: [{ key: "layer", match: { any: LAYERS } }] };
export const MISSING_VECTOR_FILTER = {
  must: [
    { key: "dense", match: { value: false } },
    { key: "layer", match: { any: ["observation", "memory"] } },
  ],
};
const VECTORS = { must: [{ key: "dense", match: { value: true } }], must_not: [TOMBSTONE] };
const NOT_DELETED = { must_not: [TOMBSTONE] };
const byLayer = (value: SearchResultLayer) => ({ must: [{ key: "layer", match: { value } }] });
const DL_FACET_LIMIT = 100_000;
const SESSION_FACET_LIMIT = 1_000_000;

/** A collection's counts kept between reads are checked against Qdrant this often; a write keeps them exact in between. */
export const COUNTS_RESYNC_MS = 10 * 60_000;

/** What the stats, session counts, lesson search and BM25 mean read from a collection. */
export interface Tally {
  docs: number;
  vectors: number;
  memories: number;
  lessons: number;
  missingVectors: number;
  /** Points that are not tombstones. */
  live: number;
  /** Live points with a term count, and the sum of their term counts: the BM25 mean document length is dlTotal / dlDocs. */
  dlDocs: number;
  dlTotal: number;
  /** Live observations per session. */
  sessions: Map<string, number>;
}

/** The payload fields a point's place in the tally depends on; a write reads them before and after its batch. */
export const COUNTED_FIELDS = ["layer", "session_id", "dense", "deleted", "dl"] as const;
export type CountedPayload = Partial<Record<(typeof COUNTED_FIELDS)[number], unknown>>;
/** A point's counted payload before and after one write; undefined is an absent point. */
export type CountedChange = readonly [CountedPayload | undefined, CountedPayload | undefined];

type FacetHits<T> = { hits: Array<{ value: T; count: number }> };

/** One read of every count in the tally, each with the filter Qdrant answered it with before the tally existed. */
export async function readTally(qdrant: Qdrant): Promise<Tally> {
  const facet = <T>(body: unknown) => qdrant.call<FacetHits<T>>("POST", `${qdrant.path}/facet`, body);
  const [docs, vectors, memories, lessons, missingVectors, live, sessions, dl] = await Promise.all([
    qdrant.count(LIVE_DOCS),
    qdrant.count(VECTORS),
    qdrant.count(byLayer("memory")),
    qdrant.count(byLayer("lesson")),
    qdrant.count(MISSING_VECTOR_FILTER),
    qdrant.count(NOT_DELETED),
    facet<string>({ key: "session_id", filter: byLayer("observation"), limit: SESSION_FACET_LIMIT, exact: true }),
    facet<number>({ key: "dl", filter: NOT_DELETED, limit: DL_FACET_LIMIT, exact: true }),
  ]);
  let dlDocs = 0;
  let dlTotal = 0;
  for (const { value, count } of dl.hits) {
    dlDocs += count;
    dlTotal += value * count;
  }
  return { docs, vectors, memories, lessons, missingVectors, live, dlDocs, dlTotal, sessions: new Map(sessions.hits.map(({ value, count }) => [value, count])) };
}

/** Adds (sign 1) or removes (sign -1) one point, matching each filter readTally counts with. */
function count(tally: Tally, p: CountedPayload | undefined, sign: 1 | -1): void {
  if (!p) return;
  const { layer } = p;
  const live = p.deleted !== true;
  if (LAYERS.includes(layer as SearchResultLayer)) tally.docs += sign;
  if (live) tally.live += sign;
  if (live && p.dense === true) tally.vectors += sign;
  if (layer === "memory") tally.memories += sign;
  if (layer === "lesson") tally.lessons += sign;
  if (p.dense === false && (layer === "observation" || layer === "memory")) tally.missingVectors += sign;
  if (live && typeof p.dl === "number") {
    tally.dlDocs += sign;
    tally.dlTotal += sign * p.dl;
  }
  if (layer === "observation" && typeof p.session_id === "string") {
    const n = (tally.sessions.get(p.session_id) ?? 0) + sign;
    if (n > 0) tally.sessions.set(p.session_id, n);
    else tally.sessions.delete(p.session_id);
  }
}

function sameTally(a: Tally, b: Tally): boolean {
  const scalar = (["docs", "vectors", "memories", "lessons", "missingVectors", "live", "dlDocs", "dlTotal"] as const).every((k) => a[k] === b[k]);
  return scalar && a.sessions.size === b.sessions.size && [...a.sessions].every(([id, n]) => b.sessions.get(id) === n);
}

/**
 * A collection's tally, read from Qdrant once and kept exact by the deltas of
 * the engine's own writes; the engine is the collection's only writer. A write
 * reports the counted payload of every point it touched, read before and after
 * its batch. Anything it cannot account for (a failed write, two writes at
 * once, a clear or bulk load) drops the tally and the next read reads Qdrant.
 */
export class CorpusCounts {
  private kept: { tally: Tally; at: number } | null = null;
  private reading: Promise<Tally> | null = null;
  /** Bumped when a write starts or ends, so a read that overlapped one is not kept. */
  private generation = 0;
  private writes = 0;
  private overlapped = false;

  constructor(private readonly qdrant: Qdrant, private readonly ready: () => Promise<void>) {}

  /** Whether a write must report its changes; false while nothing is kept. */
  get tracking(): boolean {
    return this.kept !== null;
  }

  /** The kept tally, or a fresh read of Qdrant when none is kept or it is due a resync. Callers must not modify it. */
  read(): Promise<Tally> {
    if (this.kept && Date.now() - this.kept.at < COUNTS_RESYNC_MS) return Promise.resolve(this.kept.tally);
    return (this.reading ??= this.readQdrant().finally(() => {
      this.reading = null;
    }));
  }

  /** Call before a write reads anything it will report. */
  beginWrite(): void {
    this.generation++;
    if (++this.writes > 1) this.overlapped = true;
  }

  /** Call once per beginWrite. `changes` is null when the write failed or does not report what it changed. */
  endWrite(changes: Iterable<CountedChange> | null): void {
    this.generation++;
    this.writes--;
    if (changes === null || this.overlapped) this.kept = null;
    else if (this.kept) {
      for (const [before, after] of changes) {
        count(this.kept.tally, before, -1);
        count(this.kept.tally, after, 1);
      }
    }
    if (this.writes === 0) this.overlapped = false;
  }

  private async readQdrant(): Promise<Tally> {
    await this.ready();
    const generation = this.generation;
    const quiet = this.writes === 0;
    const tally = await readTally(this.qdrant);
    if (!quiet || this.writes > 0 || generation !== this.generation) {
      // ponytail: under back-to-back writes from boot no read is kept and each one reads Qdrant, as before TEE-1450; a write lock would bound it.
      if (this.kept) this.kept.at = Date.now();
      return this.kept?.tally ?? tally;
    }
    if (this.kept && !sameTally(this.kept.tally, tally)) {
      logger.warn("am-search kept counts drifted from Qdrant; using Qdrant's", { collection: this.qdrant.config.collection, kept: summary(this.kept.tally), qdrant: summary(tally) });
    }
    this.kept = { tally, at: Date.now() };
    return tally;
  }
}

function summary(t: Tally) {
  return { docs: t.docs, vectors: t.vectors, memories: t.memories, lessons: t.lessons, missingVectors: t.missingVectors, live: t.live, dlDocs: t.dlDocs, dlTotal: t.dlTotal, sessions: t.sessions.size };
}

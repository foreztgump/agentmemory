import type { StateKV } from "../../state/kv.js";
import { pinGraphState } from "../../state/graph-generation.js";
import {
  GRAPH_INDEX_MAX_ID_BYTES, createGraphIndexReader, getGraphIndexStatus, mutateIndexedGraphRecord,
  type GraphIndexReader, type GraphPostingKind,
} from "../../state/graph-retrieval-index.js";

export interface GraphStaleResult {
  readonly nodes: number;
  readonly edges: number;
  readonly marked: number;
  /** The nodes and edges marked, for the caller's audit entry. */
  readonly ids: readonly string[];
  /** Some graph items that cite an id could not be reached: the index is not ready, changed under every read, or the id is one the index cannot hold. Nothing retries it. */
  readonly deferred: boolean;
}

type Kind = "node" | "edge";
type Hit = { readonly kind: Kind; readonly id: string };
type Found = Map<string, Hit>;

const BATCH = 16;
const ATTEMPTS = 3;
const POSTINGS: readonly (readonly [GraphPostingKind, Kind])[] = [["observation", "node"], ["edgeObservation", "edge"]];

/**
 * Marks every graph node and edge that cites one of `observationIds` stale, through the graph retrieval index's
 * `observation` and `edgeObservation` postings and `mutateIndexedGraphRecord`: the path `mem::cascade-update`
 * takes. Graph queries already skip stale items (D7, L3).
 *
 * Graph citations are bare observation ids, so a session cannot be told apart: an id two imported sessions share
 * marks the graph items of both stale, and erring toward stale is the safe side of an erasure. For the same reason
 * a node that cites the forgotten id among others goes stale whole, since what it took from the erased row cannot be separated out.
 *
 * Discovery reads the postings of one batch under one bounded reader and checks it with `finish()` before any
 * mutation, so a graph that changed under the read is discovered again. A batch the reader's budget cannot cover is split.
 */
export async function markGraphStale(kv: StateKV, observationIds: readonly string[]): Promise<GraphStaleResult> {
  const ids = [...new Set(observationIds)];
  const indexable = ids.filter((id) => id.length > 0 && Buffer.byteLength(id) <= GRAPH_INDEX_MAX_ID_BYTES);
  const marked: Found = new Map();
  let deferred = indexable.length < ids.length;
  if (indexable.length > 0) {
    try {
      if (await getGraphIndexStatus(await pinGraphState(kv))) {
        for (let start = 0; start < indexable.length; start += BATCH) {
          if (!(await markBatch(kv, indexable.slice(start, start + BATCH), marked))) deferred = true;
        }
      }
    } catch {
      deferred = true;
    }
  }
  const hits = [...marked.values()];
  const nodes = hits.filter((hit) => hit.kind === "node").length;
  return { nodes, edges: hits.length - nodes, marked: hits.length, ids: hits.map((hit) => hit.id), deferred };
}

async function markBatch(kv: StateKV, ids: readonly string[], marked: Found, attempt = 1): Promise<boolean> {
  const found = await discover(kv, ids);
  if (found === "unavailable") return false;
  if (found) {
    await mutate(kv, found, new Set(ids), marked);
    return true;
  }
  if (ids.length > 1) {
    const middle = ids.length >> 1;
    const first = await markBatch(kv, ids.slice(0, middle), marked);
    return (await markBatch(kv, ids.slice(middle), marked)) && first;
  }
  return attempt < ATTEMPTS ? markBatch(kv, ids, marked, attempt + 1) : false;
}

/** `null`: the read was cut short or the graph changed under it. */
async function discover(kv: StateKV, ids: readonly string[]): Promise<Found | null | "unavailable"> {
  const reader = await createGraphIndexReader(kv, { maxReads: 4096 });
  if (!reader) return "unavailable";
  const found: Found = new Map();
  for (const id of ids) {
    for (const [posting, kind] of POSTINGS) if (!(await collect(reader, posting, kind, id, found))) return null;
  }
  return (await reader.finish()) ? found : null;
}

async function collect(reader: GraphIndexReader, posting: GraphPostingKind, kind: Kind, id: string, found: Found): Promise<boolean> {
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<GraphIndexReader["posting"]>> = await reader.posting(posting, id, { cursor, limit: 128 });
    for (const citing of page.ids) found.set(`${kind}:${citing}`, { kind, id: citing });
    if (reader.exhausted) return false;
    cursor = page.cursor;
  } while (cursor);
  return true;
}

async function mutate(kv: StateKV, found: Found, wanted: ReadonlySet<string>, marked: Found): Promise<void> {
  const now = new Date().toISOString();
  for (const [key, { kind, id }] of found) {
    const changed = await mutateIndexedGraphRecord(kv, kind, id, (latest) =>
      !latest || latest.stale || !(latest.sourceObservationIds ?? []).some((source) => wanted.has(source))
        ? undefined
        : { ...latest, stale: true, ...(kind === "node" ? { updatedAt: now } : {}) },
    );
    if (changed) marked.set(key, { kind, id });
  }
}

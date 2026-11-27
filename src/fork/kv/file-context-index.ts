import { idKey, orderKey, type StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import type { CompressedObservation, Session } from "../../types.js";
import type { ObservationStats } from "./observation-stats.js";

const POSTINGS_CAP = 48;

type Ordered = { at: number; idk: string; seq: number };
type Fields<P> = Omit<P, keyof Ordered>;

export type SessionEntry = Pick<Session, "id" | "project" | "startedAt"> & Ordered;
export type Posting = Pick<CompressedObservation, "id" | "type" | "title" | "narrative" | "importance" | "timestamp" | "files"> &
  Ordered;
export type PostingsByBasename = (basename: string) => readonly Posting[];

type Loader = (kv: StateKV, scope: string) => Promise<Array<[string, unknown]>>;

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function byInsertion(a: Ordered, b: Ordered): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.idk !== b.idk) return a.idk < b.idk ? -1 : 1;
  return a.seq - b.seq;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return Object.is(a, b);
}

function sameFields(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return Object.keys(left).every((key) => sameValue(left[key], right[key]));
}

const asRecord = (row: unknown) => row as Record<string, unknown>;

function sessionFields(row: unknown): Fields<SessionEntry> {
  const { id, project, startedAt } = asRecord(row);
  return { id, project, startedAt } as Fields<SessionEntry>;
}

function postingFields(row: unknown): Fields<Posting> | null {
  const { id, type, title, narrative, importance, timestamp, files } = asRecord(row);
  if (!title || !((importance as number) >= 4)) return null;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return null;
  return { id, type, title, narrative, importance, timestamp, files: [...files] } as Fields<Posting>;
}

async function readByKeys(kv: StateKV, scope: string): Promise<Array<[string, unknown]>> {
  const keys = await kv.listKeys(scope);
  const rows = await kv.getMany(scope, keys);
  return keys.map((key, i) => [key, rows[i]]);
}

async function listByKeys(kv: StateKV, scope: string): Promise<Array<[string, unknown]>> {
  const keys = await kv.listKeys(scope);
  const rows = await kv.list(scope);
  const keyed = new Set(keys);
  const byId = new Map<string, unknown>();
  for (const row of rows) {
    const id = asRecord(row)?.id;
    if (typeof id === "string" && keyed.has(id)) byId.set(id, row);
  }
  if (byId.size === rows.length && rows.length === keys.length) return keys.map((key) => [key, byId.get(key)]);
  const read = await kv.getMany(scope, keys);
  return keys.map((key, i) => [key, read[i]]);
}

/**
 * In-process copy of one scope's rows, loaded by one scan and kept current from write notices.
 * Dirty keys are re-read on the next `ordered()` call.
 * ponytail: rows with equal order keys that arrive after the scan sort after older ties, where the
 * engine may list them elsewhere; a total order over the row would close that if it ever mattered.
 */
class ScopeMirror<P extends Ordered> {
  private readonly rows = new Map<string, P>();
  private dirty = new Set<string>();
  private reading = new Set<string>();
  private loading: Promise<void> | null = null;
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private sorted: P[] | null = null;

  constructor(
    private readonly kv: StateKV,
    private readonly scope: string,
    private readonly project: (row: unknown) => Fields<P> | null,
    private readonly load: Loader,
  ) {}

  noteWrite(key: string, deleted: boolean): void {
    if (!this.loaded && !this.loading) return;
    if (deleted && this.loaded) this.apply(key, null);
    if (!deleted || this.loading || this.reading.has(key)) this.dirty.add(key);
  }

  /** Rows in insertion order. A new array whenever a row changes, so identity can key caches. */
  async ordered(): Promise<readonly P[]> {
    if (!this.loaded) await (this.loading ??= this.scan());
    await this.sync();
    return (this.sorted ??= [...this.rows.values()].sort(byInsertion));
  }

  private scan(): Promise<void> {
    this.dirty.clear();
    const run = async () => {
      for (const [key, row] of await this.load(this.kv, this.scope)) this.apply(key, row);
      this.loaded = true;
    };
    return run().finally(() => {
      this.loading = null;
    });
  }

  private sync(): Promise<void> {
    const run = this.chain.then(() => this.drain());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async drain(): Promise<void> {
    if (this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty = new Set();
    this.reading = new Set(keys);
    try {
      const rows = await this.kv.getMany(this.scope, keys);
      keys.forEach((key, i) => this.apply(key, rows[i]));
    } catch (error) {
      for (const key of keys) this.dirty.add(key);
      throw error;
    } finally {
      this.reading = new Set();
    }
  }

  private apply(key: string, row: unknown): void {
    const old = this.rows.get(key);
    const fields = row === null || row === undefined ? null : this.project(row);
    if (!fields) {
      if (old && this.rows.delete(key)) this.sorted = null;
      return;
    }
    const next = { ...fields, at: orderKey(row), idk: idKey(row), seq: old?.seq ?? this.nextSeq++ } as P;
    if (old && sameFields(old, next)) return;
    this.rows.set(key, next);
    this.sorted = null;
  }
}

class SessionPostings {
  readonly mirror: ScopeMirror<Posting>;
  pins = 0;
  private indexed: readonly Posting[] | null = null;
  private byBase = new Map<string, Posting[]>();

  constructor(kv: StateKV, scope: string) {
    this.mirror = new ScopeMirror<Posting>(kv, scope, postingFields, listByKeys);
  }

  async lookup(): Promise<PostingsByBasename> {
    const ordered = await this.mirror.ordered();
    if (ordered !== this.indexed) {
      const byBase = new Map<string, Posting[]>();
      for (const posting of ordered) {
        for (const base of new Set(posting.files.map(basenameOf))) {
          const list = byBase.get(base);
          if (list) list.push(posting);
          else byBase.set(base, [posting]);
        }
      }
      this.byBase = byBase;
      this.indexed = ordered;
    }
    const byBase = this.byBase;
    return (basename) => byBase.get(basename) ?? [];
  }
}

/** Every session, and postings by file basename for the most recently used sessions, kept in process. Assumes one writer process. */
export class FileContextIndex {
  private readonly sessions: ScopeMirror<SessionEntry>;
  private readonly postings = new Map<string, SessionPostings>();

  constructor(
    private readonly kv: StateKV,
    stats: ObservationStats,
  ) {
    this.sessions = new ScopeMirror<SessionEntry>(kv, KV.sessions, sessionFields, readByKeys);
    stats.onWrite((scope, key, deleted) => {
      if (scope === KV.sessions) this.sessions.noteWrite(key, deleted);
      else this.postings.get(scope)?.mirror.noteWrite(key, deleted);
    });
  }

  /** Every session, ordered as `orderLikeInsertion` orders them. */
  allSessions(): Promise<readonly SessionEntry[]> {
    return this.sessions.ordered();
  }

  async postingsOf(sessionIds: string[]): Promise<Map<string, PostingsByBasename>> {
    const ids = [...new Set(sessionIds)];
    const entries = ids.map((id) => this.pin(KV.observations(id)));
    try {
      const lookups = await Promise.all(entries.map((entry) => entry.lookup()));
      return new Map(ids.map((id, i) => [id, lookups[i]!]));
    } finally {
      for (const entry of entries) entry.pins--;
      this.evict();
    }
  }

  private pin(scope: string): SessionPostings {
    const entry = this.postings.get(scope) ?? new SessionPostings(this.kv, scope);
    this.postings.delete(scope);
    this.postings.set(scope, entry);
    entry.pins++;
    return entry;
  }

  private evict(): void {
    for (const [scope, entry] of this.postings) {
      if (this.postings.size <= POSTINGS_CAP) return;
      if (entry.pins === 0) this.postings.delete(scope);
    }
  }
}

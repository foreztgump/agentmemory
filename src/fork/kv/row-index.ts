import type { StateKV } from "../../state/kv.js";
import { scanRows } from "./paged-scan.js";

type Change<E> = { key: string; entry: E | null };

/**
 * An in-process copy of one scope without the heavy fields of its rows, so sweeps and status calls
 * read memory instead of paging the scope. It loads with one paged scan on first use, and every
 * write the owner makes to the scope is mirrored with `put` and `drop`. `reload` scans again and
 * replaces the copy, which heals drift. It assumes the owning process is the only writer of the
 * scope, the same assumption the redis backend's kv.update makes. Rows with equal order keys come
 * back in the order they were first seen, where a scan returns them in engine order.
 */
export class RowIndex<Row extends { key: string }, Entry extends { key: string }> {
  private entriesByKey = new Map<string, Entry>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private buffered: Change<Entry>[] = [];

  constructor(
    private readonly kv: StateKV,
    private readonly scope: string,
    private readonly strip: (row: Row) => Entry,
  ) {}

  put(row: Row): void {
    this.apply({ key: row.key, entry: this.strip(row) });
  }

  drop(key: string): void {
    this.apply({ key, entry: null });
  }

  /** The entry for `key` when the copy is loaded, without waiting for a load. Undefined also before the load, so a miss does not prove the row is absent. */
  peek(key: string): Entry | undefined {
    return this.loaded ? this.entriesByKey.get(key) : undefined;
  }

  /** The number of rows when the copy is loaded, else undefined after starting the load in the background. */
  loadedSize(): number | undefined {
    if (this.loaded) return this.entriesByKey.size;
    void this.ensureLoaded().catch(() => undefined);
    return undefined;
  }

  async entries(): Promise<Entry[]> {
    await this.ensureLoaded();
    return [...this.entriesByKey.values()];
  }

  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.entriesByKey.size;
  }

  /** Scans the scope again, replaces the copy with the result and returns it. Throws when the scan fails, leaving the copy as it was. */
  async reload(): Promise<Entry[]> {
    await (this.loading ?? this.load());
    return this.entries();
  }

  private apply(change: Change<Entry>): void {
    if (this.loaded) this.commit(this.entriesByKey, change);
    if (this.loading) this.buffered.push(change);
  }

  private commit(into: Map<string, Entry>, { key, entry }: Change<Entry>): void {
    if (entry) into.set(key, entry);
    else into.delete(key);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await (this.loading ?? this.load());
  }

  private load(): Promise<void> {
    this.buffered = [];
    const scan = async () => {
      const next = new Map<string, Entry>();
      for (const entry of await scanRows<Row, Entry>(this.kv, this.scope, this.strip)) next.set(entry.key, entry);
      for (const change of this.buffered) this.commit(next, change);
      this.entriesByKey = next;
      this.loaded = true;
    };
    this.loading = scan().finally(() => {
      this.buffered = [];
      this.loading = null;
    });
    return this.loading;
  }
}

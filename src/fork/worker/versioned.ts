import { nextOpVersion, seedOpVersion, type OpVersion } from "../search/protocol.js";
import type { Qdrant } from "./qdrant.js";

/**
 * Every point carries `v`, the version of the last invocation that changed
 * it, and a delete leaves a tombstone (`deleted: true`, no vectors). An op
 * applies only to a point whose `v` is not newer than its own, so a late
 * duplicate of an older invocation cannot overwrite a newer one or undo a
 * delete. Points written before versions existed have no `v` and count as older.
 */
export const notNewerThan = (version: OpVersion) => ({ should: [{ key: "v", range: { lte: version } }, { is_empty: { key: "v" } }] });
export const TOMBSTONE = { key: "deleted", match: { value: true } };

export function validVersion(version: unknown): OpVersion | null {
  return typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? version : null;
}

/** The version floor of one collection: the highest `v` stored, and the stamps a caller without a version gets above it. */
export class VersionClock {
  private floor: Promise<unknown> | null = null;

  constructor(private readonly qdrant: Qdrant, private readonly ready: () => Promise<void>) {}

  /** The highest version stored, tombstones included; this process's own stamps start above it. */
  async maxVersion(): Promise<OpVersion> {
    await this.ready();
    const res = await this.qdrant.call<{ points: Array<{ payload?: { v?: unknown } }> }>("POST", `${this.qdrant.path}/points/scroll`, {
      filter: { must: [{ key: "v", range: { gte: 1 } }] },
      order_by: { key: "v", direction: "desc" },
      limit: 1,
      with_payload: ["v"],
      with_vector: false,
    });
    const version = validVersion(res.points?.[0]?.payload?.v) ?? 0;
    seedOpVersion(version);
    return version;
  }

  /** A caller's version, or one stamped here above every version stored. */
  async versionFor(rawVersion: unknown): Promise<OpVersion> {
    const version = validVersion(rawVersion);
    if (version !== null) {
      seedOpVersion(version);
      return version;
    }
    await (this.floor ??= this.maxVersion().catch((error) => {
      this.floor = null;
      throw error;
    }));
    return nextOpVersion();
  }
}

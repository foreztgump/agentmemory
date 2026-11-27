import type { IIIClient } from "iii-sdk";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import type { StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import type { ImageEmbedding } from "../../state/search-ports.js";
import type { RetentionDeps, Satellite } from "./satellites.js";
import { itemKey } from "./scopes.js";
import type { VaultEntry } from "./types.js";
import { Vault } from "./vault.js";

/**
 * `mem:retention:image-holds`, key = image file path. `holders` lists the `itemKey` of every vault entry that
 * still holds a reference to the file, so a hold and its release are idempotent under a replayed detach, attach
 * or purge, which a counter is not. Live referrers are the file's reference count minus `holders.length`.
 * `embedding` is the `mem:image-embeddings` row, parked here while no live row references the file, so TEE-1196's
 * reconciler finds no record and no index entry for it (R8) and a restore puts it back without embedding (R3).
 */
export interface ImageHold {
  readonly holders: readonly string[];
  readonly embedding?: ImageEmbedding;
}

const lockOf = (path: string): string => `imgHold:${path}`;

/** One reference per distinct file; a stage T entry holds only `source`, never a row. */
export function imagePaths(entry: VaultEntry): string[] {
  if (entry.stage === "T") return [];
  const row = entry.row as { imageData?: string; imageRef?: string };
  const files = entry.ref.kind === "memory" ? [row.imageRef] : [row.imageData, row.imageRef];
  return [...new Set(files.filter((file): file is string => typeof file === "string" && file.length > 0))];
}

const readHold = async (kv: StateKV, path: string): Promise<ImageHold> => (await kv.get<ImageHold>(KV.retentionImageHolds, path)) ?? { holders: [] };

const writeHold = (kv: StateKV, path: string, hold: ImageHold): Promise<unknown> =>
  hold.holders.length === 0 ? kv.delete(KV.retentionImageHolds, path) : kv.set(KV.retentionImageHolds, path, hold);

/** The row has left its scope: note the held reference and, when no live row is left on the file, take it out of search. */
async function holdImage(deps: RetentionDeps, path: string, holder: string): Promise<void> {
  await withKeyedLock(lockOf(path), async () => {
    const current = await readHold(deps.kv, path);
    const holders = current.holders.includes(holder) ? current.holders : [...current.holders, holder];
    const row = await deps.kv.get<ImageEmbedding>(KV.imageEmbeddings, path);
    const liveReferrers = (Number(await deps.kv.get<number>(KV.imageRefs, path)) || 0) - holders.length;
    const embedding = current.embedding ?? (liveReferrers <= 0 && row ? row : undefined);
    if (holders !== current.holders || embedding !== current.embedding) await writeHold(deps.kv, path, { holders, ...(embedding ? { embedding } : {}) });
    if (!embedding) return;
    if (row) await deps.kv.delete(KV.imageEmbeddings, path);
    deps.search().images?.remove(path);
  });
}

/** The row is live again: its reference is no longer held, and a parked embedding returns to the records and the index. */
async function returnImage(deps: RetentionDeps, path: string, holder: string): Promise<void> {
  await withKeyedLock(lockOf(path), async () => {
    const current = await readHold(deps.kv, path);
    if (current.embedding) {
      await deps.kv.set(KV.imageEmbeddings, path, current.embedding);
      deps.search().images?.put(current.embedding);
    }
    const holders = current.holders.filter((h) => h !== holder);
    if (holders.length !== current.holders.length || current.embedding) await writeHold(deps.kv, path, { holders });
  });
}

/** The reference is released for good: purge and forget. The embedding stays parked while another entry still holds the file. */
async function dropHolder(kv: StateKV, path: string, holder: string): Promise<void> {
  await withKeyedLock(lockOf(path), async () => {
    const current = await readHold(kv, path);
    if (!current.holders.includes(holder)) return;
    await writeHold(kv, path, { ...current, holders: current.holders.filter((h) => h !== holder) });
  });
}

/**
 * Releases the entry's image references once, at purge or forget. `imageReleased` is written first, so a crash leaks
 * one reference and never frees a file another row still uses; a second call skips the decrement and only drops the hold.
 * ponytail: a crash between the marker and the decrement leaks the reference (the file lives on); an idempotent
 * decrement would need the reference count and the marker in one write, which `mem:image-refs` cannot hold.
 */
export async function releaseImages(sdk: IIIClient, kv: StateKV, entry: VaultEntry): Promise<void> {
  const paths = imagePaths(entry);
  if (paths.length === 0) return;
  if (!entry.imageReleased) {
    await new Vault(kv).update({ ...entry, imageReleased: true });
    const { decrementImageRef } = await import("../../functions/image-refs.js");
    for (const path of paths) await decrementImageRef(kv, sdk, path);
  }
  const holder = itemKey(entry.ref);
  for (const path of paths) await dropHolder(kv, path, holder);
}

export function imageSatellite(): Satellite {
  return {
    name: "image",
    appliesTo: ["observation", "memory"],
    async detach(deps, entry) {
      for (const path of imagePaths(entry)) await holdImage(deps, path, itemKey(entry.ref));
    },
    async attach(deps, entry) {
      for (const path of imagePaths(entry)) await returnImage(deps, path, itemKey(entry.ref));
    },
    finalize: (deps, entry) => releaseImages(deps.sdk, deps.kv, entry),
  };
}

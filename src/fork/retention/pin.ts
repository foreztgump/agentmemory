import { safeAudit } from "../../functions/audit.js";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import { reinstateDemoteLocked } from "./demote.js";
import { lockOf, scopeOf } from "./move.js";
import type { RetentionDeps } from "./satellites.js";
import { itemKey, RETENTION_KV, type Pin } from "./scopes.js";
import type { ItemRef } from "./types.js";
import { Vault } from "./vault.js";

export type PinOutcome =
  /** `vaulted`: the item is in a run's vault. It stays there until the grace period ends, when purge's recheck sees the pin and restores it; `mem::retention-restore` brings it back at once. */
  | { readonly kind: "pinned"; readonly pin: Pin; readonly vaulted: boolean; readonly undemoted: boolean }
  | { readonly kind: "unpinned"; readonly existed: boolean }
  | { readonly kind: "not-found" };

const idsOf = (ref: ItemRef): string[] => [ref.id];
const sessionOf = (ref: ItemRef): Record<string, string> => (ref.kind === "observation" ? { session: ref.sessionId } : {});

/**
 * D3: writes the pin `Protector.judge` reads first (`mem:retention:pins`), under the item's lock. An item that is neither
 * live nor restorable from a vault is not found, so the scope cannot fill with pins for ids that never existed, and a pin
 * never promises what purge will not keep: a trim entry whose row is gone everywhere, or an entry purge has committed,
 * is purged whatever a pin says. Purge and the pin share the item lock, so a pin it accepts reaches purge's recheck. A pin on a
 * demoted memory un-demotes it in the same hold, from its stored vector with no embedding call (R3), because a demote
 * is never purged and nothing else would bring it back. A pin on a vaulted item leaves it there (design 4.6): purge
 * rechecks protection at the end of grace and restores a pinned entry.
 */
export async function pinItem(deps: RetentionDeps, req: { readonly ref: ItemRef; readonly who: string; readonly reason: string }): Promise<PinOutcome> {
  const { ref } = req;
  const vault = new Vault(deps.kv);
  const done = await withKeyedLock(lockOf(ref), async () => {
    const [live, claim] = await Promise.all([deps.kv.get(scopeOf(ref), ref.id), vault.locate(ref)]);
    if (!live && !(await vault.holdsRestorableRow(ref))) return null;
    const pin: Pin = { ref, who: req.who, reason: req.reason, pinnedAt: deps.now().toISOString() };
    await deps.kv.set(RETENTION_KV.pins, itemKey(ref), pin);
    const undemoted = ref.kind === "memory" && (await reinstateDemoteLocked(deps, ref.id))?.restored === true;
    return { pin, vaulted: claim !== null, undemoted };
  });
  if (!done) return { kind: "not-found" };
  await safeAudit(deps.kv, "retention_pin", "mem::retention-pin", idsOf(ref), { pinned: true, who: req.who, reason: req.reason, undemoted: done.undemoted, vaulted: done.vaulted, ...sessionOf(ref) });
  return { kind: "pinned", ...done };
}

/** Removes a pin, and audits it only when there was one. It does not look for the item, so a pin left by a row that is gone can still be cleared. */
export async function unpinItem(deps: RetentionDeps, ref: ItemRef, who: string): Promise<PinOutcome> {
  const existed = await withKeyedLock(lockOf(ref), async () => {
    const found = (await deps.kv.get(RETENTION_KV.pins, itemKey(ref))) !== null;
    if (found) await deps.kv.delete(RETENTION_KV.pins, itemKey(ref));
    return found;
  });
  if (existed) await safeAudit(deps.kv, "retention_pin", "mem::retention-pin", idsOf(ref), { pinned: false, who, ...sessionOf(ref) });
  return { kind: "unpinned", existed };
}

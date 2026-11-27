import type { StateKV } from "../../state/kv.js";
import { logger } from "../../logger.js";
import { RETENTION_KV } from "./scopes.js";

/**
 * The job ledger behind the long REST routes (TEE-1443). The engine answers a call 504 after its HTTP timeout and the function keeps
 * running, so the REST handler cannot learn the outcome. The function records it here instead, and the job route reads it back.
 */

export type JobId = string & { readonly __brand: "JobId" };
export type JobRoute = "sweep" | "purge" | "restore";

type JobBase = { readonly id: JobId; readonly route: JobRoute; readonly startedAt: string; readonly bootId: string };
export type JobRow =
  | (JobBase & { readonly state: "running" })
  | (JobBase & { readonly state: "done"; readonly finishedAt: string; readonly outcome: unknown })
  | (JobBase & { readonly state: "failed"; readonly finishedAt: string; readonly error: string });

/** A running row written by another boot reads as lost: that worker is gone and nothing will finish it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JobView = DistributiveOmit<JobRow, "bootId"> | (Omit<JobBase, "bootId"> & { readonly state: "lost" });
export type JobLookup = { readonly kind: "found"; readonly job: JobView } | { readonly kind: "not-found" };

async function record(kv: StateKV, row: JobRow): Promise<void> {
  try {
    await kv.set(RETENTION_KV.jobs, row.id, row);
  } catch (err) {
    logger.warn("retention job row not written", { job: row.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** With no job id, just the work. With one, the row is running before the work starts and done or failed after; a row write never changes the work's result. */
export async function tracked<T>(kv: StateKV, bootId: string, now: () => Date, id: JobId | undefined, route: JobRoute, work: () => Promise<T>): Promise<T> {
  if (id === undefined) return work();
  const base: JobBase = { id, route, startedAt: now().toISOString(), bootId };
  await record(kv, { ...base, state: "running" });
  try {
    const outcome = await work();
    await record(kv, { ...base, state: "done", finishedAt: now().toISOString(), outcome });
    return outcome;
  } catch (err) {
    await record(kv, { ...base, state: "failed", finishedAt: now().toISOString(), error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export async function readJob(kv: StateKV, bootId: string, id: JobId): Promise<JobLookup> {
  const row = await kv.get<JobRow>(RETENTION_KV.jobs, id);
  if (row === null) return { kind: "not-found" };
  const { bootId: wroteBy, ...job } = row;
  if (row.state === "running" && wroteBy !== bootId) return { kind: "found", job: { id: row.id, route: row.route, startedAt: row.startedAt, state: "lost" } };
  return { kind: "found", job };
}

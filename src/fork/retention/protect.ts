import type { AccessLog } from "../../functions/access-tracker.js";
import type { StateKV } from "../../state/kv.js";
import { KV } from "../../state/schema.js";
import type { CompressedObservation, Insight, Lesson, Memory } from "../../types.js";
import type { ActiveClock } from "./clock.js";
import { itemKey, RETENTION_KV, type Pin } from "./scopes.js";
import { RETENTION_IMPORTANCE_FLOOR, RETENTION_SPILL_IDS } from "./settings.js";
import type { ItemRef, Reason, SessionSeal, SignalId, Stage, VaultEntry, Windows } from "./types.js";

declare const cleared: unique symbol;
declare const chained: unique symbol;

/** Proof that a session's summary covers every row (seal.ts). Only `judgeSeal` returns one. */
export interface SealProof {
  readonly seal: SessionSeal;
}

/** Proof that a superseded memory's successor exists, is latest and the chain has no cycle. */
export interface ChainProof {
  readonly successorId: string;
  readonly [chained]: true;
}

/**
 * `project` is the item's project (a memory's own, a session's for an observation): the `retrieved` signal reads the project-active clock with it.
 * `graphCited` is set by the plan on a stage O row that a graph posting cites: no veto, the judge only counts it for the report.
 */
export type Candidate = { readonly project: string; readonly graphCited?: true } & (
  | { readonly stage: "T" | "O"; readonly ref: Extract<ItemRef, { kind: "observation" }>; readonly row: CompressedObservation; readonly proof: SealProof; readonly reason: Reason }
  | { readonly stage: "S"; readonly ref: Extract<ItemRef, { kind: "memory" }>; readonly row: Memory; readonly proof: ChainProof; readonly reason: Reason }
  | { readonly stage: "X" | "C"; readonly ref: Extract<ItemRef, { kind: "memory" }>; readonly row: Memory; readonly reason: Reason }
);

/** A candidate that passed every protection signal. `displace` accepts nothing else. */
export type Cleared = Candidate & { readonly [cleared]: true };

export type Verdict =
  | { readonly kind: "clear"; readonly item: Cleared }
  | { readonly kind: "protected"; readonly signal: SignalId; readonly candidate: Candidate };

/**
 * Section 6 signals, each a point read or a per-sweep pass over a small collection, never a whole read of
 * a growing one. `judge` reports the first that applies, in this order:
 *   pin              mem:retention:pins point read.
 *   importance       row.importance >= RETENTION_IMPORTANCE_FLOOR (settings.ts; only LLM compression writes
 *                    other than 5; off on both stacks today). Observations only.
 *   memory-type      architecture and preference memories are never demoted (stage C).
 *   deliberate-save  a latest memory saved on purpose (`origin.channel` user or agent, which is everything
 *                    `mem::remember` writes) is never demoted on age alone (stage C). A memory with an
 *                    expiry (`forgetAfter`, stage X) is not protected: the save named its own end.
 *   cited-by-memory  ids from `sourceObservationIds` of latest memories and of superseded ones still inside
 *                    their window (`windows.supersededDays`: active-day age under it, read from the clock
 *                    with the memory's project and the time it stopped being latest), collected once per
 *                    sweep in one paged pass over mem:memories into a Set. Memories are about 1% of
 *                    observations (760 on buddy). The ids are bare, so an id two sessions share protects
 *                    both rows: the set errs toward keeping.
 *                    ponytail: in-RAM Set, spilled to RETENTION_KV.sweepScratch (scopes.ts, classified in
 *                    scope-classes.ts) above RETENTION_SPILL_IDS ids (design 6).
 *   cited-by-insight Insight.sourceMemoryIds, one paged pass over mem:insights.
 *   cited-by-graph   observation and edgeObservation postings, point reads (plan.ts); not a veto: lowers
 *                    priority so cited rows go last (`Candidate.graphCited`), and counts in the report.
 *   retrieved        mem:access point read: a last access at or after
 *                    `clock.cutoffForActiveDays(project, windows.coldDays)` protects, so the window is
 *                    project-active days, not wall-clock; no access is not evidence.
 *   lesson           lessons are never candidates (R5); `hits().lesson` is the count of live lessons, read once
 *                    when the Protector is built, so the report can say so.
 * Re-run at purge time (design 4.6) through `recheck`: an entry that became protected during grace is
 * restored instead.
 */
export interface Protector {
  judge(candidate: Candidate): Promise<Verdict>;
  /**
   * The same signals for a vault entry, which carries no seal or chain proof and mints no `Cleared`. Purge
   * calls it with a Protector built for that pass, so it sees the current pins and citations.
   *
   * It does not evaluate the memory-only signals, memory-type and deliberate-save: no entry carries a subject
   * for them, because they apply at stage C and this slice never displaces C. Slice 8 must not assume recheck
   * covers them. Importance is read for stage O from the entry's row and for stage T from the live row (a trim
   * entry holds no row), so a row that became important during grace is not purged.
   */
  recheck(entry: VaultEntry): Promise<{ readonly kind: "clear" } | { readonly kind: "protected"; readonly signal: SignalId }>;
  /** Hits per signal so far in this sweep, for the report (R1, R5). */
  hits(): Readonly<Record<SignalId, number>>;
  /**
   * Empties `RETENTION_KV.sweepScratch` when this Protector spilled the cited set into it. Call it when the pass
   * ends. One spilling Protector at a time: the sweep lease admits it, and purge must not build a spilling one
   * while a sweep holds the lease.
   *
   * A sweep that crashes or aborts after spilling never calls it, and its scratch keys stay until the next
   * Protector that spills clears them (`createProtector` does so at its first spill). A Protector that never
   * spills clears nothing, and `release` on a Protector that did not spill is a no-op, so run recovery
   * (slice 6) must clear the scope itself for a run it finds unfinished; calling `release` on a fresh
   * Protector does not.
   */
  release(): Promise<void>;
}

/**
 * One Protector per sweep or purge pass. `windows` and `clock` are the run's: `supersededDays` bounds
 * which superseded memories still count as citing, `coldDays` through the clock's cutoff bounds the
 * `retrieved` signal. The sweep passes its RunRow windows, and purge passes the current settings'.
 *
 * Scratch lifetime: a spilling Protector writes `RETENTION_KV.sweepScratch` and `release` empties it. A crashed
 * sweep leaves its keys until the next spilling Protector clears them. A Protector that never spills does not
 * clear leftovers and its `release` is a no-op, so run recovery (slice 6) must clear the scope itself.
 */
export async function createProtector(
  kv: StateKV,
  windows: Pick<Windows, "supersededDays" | "coldDays">,
  clock: ActiveClock,
  limits: { readonly spillIds?: number } = {},
): Promise<Protector> {
  const [citedObservations, citedMemories, lessons] = await Promise.all([
    collectCitedObservations(kv, windows, clock, limits.spillIds ?? RETENTION_SPILL_IDS),
    collectCitedMemories(kv),
    countLiveLessons(kv),
  ]);
  const counts = Object.fromEntries(SIGNAL_IDS.map((signal) => [signal, 0])) as Record<SignalId, number>;
  counts.lesson = lessons;

  /** A stage O entry holds its row. A trim entry holds only `source`, so the live row is read for its current importance. */
  async function importanceOf(entry: VaultEntry): Promise<{ importance?: number }> {
    if (entry.stage === "O") return { importance: entry.row.importance };
    if (entry.stage !== "T") return {};
    const live = await kv.get<CompressedObservation>(KV.observations(entry.ref.sessionId), entry.ref.id);
    return live ? { importance: live.importance } : {};
  }

  async function protection(subject: Subject): Promise<SignalId | null> {
    const { ref, stage, project } = subject;
    if (await kv.get<Pin>(RETENTION_KV.pins, itemKey(ref))) return "pin";
    if (subject.importance !== undefined && subject.importance >= RETENTION_IMPORTANCE_FLOOR) return "importance";
    if (stage === "C" && subject.memory) {
      if (subject.memory.type === "architecture" || subject.memory.type === "preference") return "memory-type";
      if (subject.memory.origin?.channel === "user" || subject.memory.origin?.channel === "agent") return "deliberate-save";
    }
    if (ref.kind === "observation" && (await citedObservations.has(ref.id))) return "cited-by-memory";
    if (ref.kind === "memory" && citedMemories.has(ref.id)) return "cited-by-insight";
    const access = await kv.get<AccessLog>(KV.accessLog, ref.id);
    const accessedAt = Date.parse(access?.lastAt ?? "");
    if (accessedAt >= clock.cutoffForActiveDays(project, windows.coldDays).getTime()) return "retrieved";
    return null;
  }

  return {
    async judge(candidate) {
      if (candidate.graphCited) counts["cited-by-graph"]++;
      const signal = await protection({
        ref: candidate.ref,
        stage: candidate.stage,
        project: candidate.project,
        ...(candidate.ref.kind === "observation" ? { importance: (candidate.row as CompressedObservation).importance } : { memory: candidate.row as Memory }),
      });
      if (signal) {
        counts[signal]++;
        return { kind: "protected", signal, candidate };
      }
      return { kind: "clear", item: candidate as Cleared };
    },
    async recheck(entry) {
      const signal = await protection({
        ref: entry.ref,
        stage: entry.stage,
        project: entry.project,
        ...(await importanceOf(entry)),
      });
      if (!signal) return { kind: "clear" };
      counts[signal]++;
      return { kind: "protected", signal };
    },
    hits: () => ({ ...counts }),
    release: citedObservations.release,
  };
}

const SIGNAL_IDS: readonly SignalId[] = [
  "pin", "importance", "deliberate-save", "cited-by-memory", "cited-by-insight", "cited-by-graph", "retrieved", "lesson", "memory-type",
];

interface Subject {
  readonly ref: ItemRef;
  readonly stage: Stage;
  readonly project: string;
  readonly importance?: number;
  readonly memory?: Memory;
}

interface CitedObservations {
  has(id: string): Promise<boolean>;
  release(): Promise<void>;
}

const SPILL_BATCH = 200;

async function collectCitedObservations(
  kv: StateKV,
  windows: Pick<Windows, "supersededDays">,
  clock: ActiveClock,
  spillIds: number,
): Promise<CitedObservations> {
  const ram = new Set<string>();
  let spilled = false;
  const stillCites = (memory: Memory): boolean => {
    if (memory.isLatest !== false) return true;
    const stoppedAt = Date.parse(memory.updatedAt);
    return Number.isNaN(stoppedAt) || clock.activeDaysSince(memory.project ?? "", new Date(stoppedAt)) < windows.supersededDays;
  };
  const flush = async (): Promise<void> => {
    const ids = [...ram];
    ram.clear();
    for (let start = 0; start < ids.length; start += SPILL_BATCH) {
      await Promise.all(ids.slice(start, start + SPILL_BATCH).map((id) => kv.set(RETENTION_KV.sweepScratch, id, 1)));
    }
  };
  const clearScratch = async (): Promise<void> => {
    const keys = await kv.listKeys(RETENTION_KV.sweepScratch);
    for (let start = 0; start < keys.length; start += SPILL_BATCH) {
      await Promise.all(keys.slice(start, start + SPILL_BATCH).map((key) => kv.delete(RETENTION_KV.sweepScratch, key)));
    }
  };
  const release = async (): Promise<void> => {
    if (!spilled) return;
    await clearScratch();
    spilled = false;
  };
  for await (const page of kv.iterate<Memory>(KV.memories)) {
    for (const memory of page) {
      if (memory && stillCites(memory)) for (const id of memory.sourceObservationIds ?? []) ram.add(id);
    }
    if (!spilled && ram.size > spillIds) {
      await clearScratch();
      spilled = true;
    }
    if (spilled) await flush();
  }
  return {
    has: async (id) => (spilled ? (await kv.get(RETENTION_KV.sweepScratch, id)) !== null : ram.has(id)),
    release,
  };
}

async function collectCitedMemories(kv: StateKV): Promise<ReadonlySet<string>> {
  const cited = new Set<string>();
  for await (const page of kv.iterate<Insight>(KV.insights)) {
    for (const insight of page) if (insight && !insight.deleted) for (const id of insight.sourceMemoryIds ?? []) cited.add(id);
  }
  return cited;
}

async function countLiveLessons(kv: StateKV): Promise<number> {
  let live = 0;
  for await (const page of kv.iterate<Lesson>(KV.lessons)) for (const lesson of page) if (lesson && !lesson.deleted) live++;
  return live;
}

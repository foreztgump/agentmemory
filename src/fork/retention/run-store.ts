import type { StateKV } from "../../state/kv.js";
import { withKeyedLock } from "../../state/keyed-mutex.js";
import { RETENTION_KV } from "./scopes.js";
import type { RunId, RunRow, Stage, StageCounters, Windows } from "./types.js";

export const LEASE_STALE_MS = 5 * 60_000;
const LEASE_KEY = "lease";
const LEASE_LOCK = "retention:lease";
const STAGES: readonly Stage[] = ["T", "O", "S", "X", "C"];

interface Lease {
  readonly owner: string;
  readonly heartbeatAt: string;
}

export type LeaseResult =
  | { readonly held: true; readonly tookOverFrom?: string }
  | { readonly held: false; readonly heldBy: string };

export interface NewRun {
  readonly id: RunId;
  readonly dryRun: boolean;
  readonly windows: Windows;
  readonly graceDays: number;
  readonly ranBy: string;
  readonly startedAt: string;
}

export function newRunRow(run: NewRun): RunRow {
  const counters = Object.fromEntries(
    STAGES.map((stage): [Stage, StageCounters] => [stage, { planned: 0, moved: 0, bytes: 0, protectedHits: 0 }]),
  ) as Record<Stage, StageCounters>;
  return {
    id: run.id,
    dryRun: run.dryRun,
    startedAt: run.startedAt,
    windows: run.windows,
    graceDays: run.graceDays,
    phase: "seal",
    outcome: "running",
    cursor: null,
    counters,
    observationCap: null,
    held: 0,
    ranBy: run.ranBy,
  };
}

/**
 * The persisted run rows and the one sweep lease. The lease has a heartbeat, so a sweep that died holding
 * it is taken over after LEASE_STALE_MS. Acquire, heartbeat and release run under one in-process lock.
 * ponytail: no compare-and-set across processes; the state store has one writer process (see
 * ObservationStats), so a second process needs a conditional write here.
 */
export class RunStore {
  constructor(
    private readonly kv: StateKV,
    private readonly now: () => Date,
  ) {}

  save(row: RunRow): Promise<RunRow> {
    return this.kv.set(RETENTION_KV.runs, row.id, row);
  }

  get(id: RunId): Promise<RunRow | null> {
    return this.kv.get<RunRow>(RETENTION_KV.runs, id);
  }

  async unfinished(): Promise<RunRow[]> {
    return (await this.kv.list<RunRow>(RETENTION_KV.runs)).filter((row) => row.phase !== "done");
  }

  acquireLease(owner: string): Promise<LeaseResult> {
    return withKeyedLock(LEASE_LOCK, async () => {
      const current = await this.kv.get<Lease>(RETENTION_KV.control, LEASE_KEY);
      const foreign = current && current.owner !== owner ? current : null;
      if (foreign && this.now().getTime() - Date.parse(foreign.heartbeatAt) < LEASE_STALE_MS) {
        return { held: false, heldBy: foreign.owner } as const;
      }
      await this.kv.set<Lease>(RETENTION_KV.control, LEASE_KEY, { owner, heartbeatAt: this.now().toISOString() });
      return foreign ? ({ held: true, tookOverFrom: foreign.owner } as const) : ({ held: true } as const);
    });
  }

  /** False when another process has taken the lease: the sweep must stop. */
  heartbeat(owner: string): Promise<boolean> {
    return withKeyedLock(LEASE_LOCK, async () => {
      const current = await this.kv.get<Lease>(RETENTION_KV.control, LEASE_KEY);
      if (current?.owner !== owner) return false;
      await this.kv.set<Lease>(RETENTION_KV.control, LEASE_KEY, { owner, heartbeatAt: this.now().toISOString() });
      return true;
    });
  }

  releaseLease(owner: string): Promise<void> {
    return withKeyedLock(LEASE_LOCK, async () => {
      const current = await this.kv.get<Lease>(RETENTION_KV.control, LEASE_KEY);
      if (current?.owner === owner) await this.kv.delete(RETENTION_KV.control, LEASE_KEY);
    });
  }
}

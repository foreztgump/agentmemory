import type { StateKV } from "../../state/kv.js";

/** Structurally a StatusProblem; declared here so the fork typecheck does not pull in the status module. */
interface StatusProblem {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  fix?: string;
}

export type ReconcileState = "waiting" | "running" | "idle" | "paused-degraded" | "off";
export type ReembedState = "running" | "idle" | "off" | "paused-degraded" | "no-embedding-provider";

export interface ReconcileReport {
  state: ReconcileState;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Units (a session's observations, the memories, a session gone from the records) compared document by document. */
  checked: number;
  added: number;
  deleted: number;
  error: string | null;
}

export interface ReembedReport {
  state: ReembedState;
  perMinute: number;
  embedded: number;
  failed: number;
}

/** The status page's view of a search backend that lives outside the app worker. */
export interface SearchBackendStatus {
  backend: "disk";
  state: "healthy" | "degraded";
  reason: string | null;
  since: string;
  documents: number;
  vectors: number;
  /** Writes queued for the search worker. */
  pendingWrites: number;
  /** Writes dropped while the worker was unreachable; reconcile repairs them. */
  droppedWrites: number;
  /** Indexable records not yet in the index after the last reconcile pass; null until a pass has finished. */
  missingDocuments: number | null;
  missing: { observations: number; memories: number } | null;
  /** Observations and memories without a vector; null when no embedding provider is configured. */
  missingVectors: number | null;
  reconcile: ReconcileReport;
  reembed: ReembedReport;
}

/** What smart-search attaches while it answers without the keyword and vector streams. */
export interface DegradedNotice {
  backend: "disk";
  legs: Array<"keyword" | "vector">;
  reason: string;
}

export interface SearchBackendService {
  /** Idempotent. Schedules reconcile and the re-embed loop in the background; never waits for them. */
  start(hooks: ServiceHooks): void;
  stop(): Promise<void>;
  /** Probes the backend (bounded) and reads cached counters. */
  status(): Promise<SearchBackendStatus>;
  degradedNotice(): DegradedNotice | null;
  /** True once a reconcile pass has finished, so the status page can take missing counts from it. */
  readonly reconciled: boolean;
}

/** Provided by the app's search module at boot, so the fork code does not import it. */
export interface ServiceHooks {
  kv: StateKV;
  /** Embeds and stores vectors through the vector port; vectorIndexAddBatchGuarded. */
  embedBatch(jobs: Array<{ id: string; sessionId: string; text: string; context: { kind: "memory" | "observation"; logId: string } }>): Promise<{ ok: number; fail: number; skipped: number }>;
  embeddingEnabled(): boolean;
}

export function searchBackendProblems(s: SearchBackendStatus | null | undefined): StatusProblem[] {
  if (!s) return [];
  const problems: StatusProblem[] = [];
  if (s.state === "degraded") {
    problems.push({
      level: "error",
      code: "search-backend-degraded",
      message: `The search backend is unavailable (${s.reason ?? "unknown error"}). Keyword and vector search return nothing; graph search still answers. Records are safe.`,
      fix: "Check the Qdrant and am-search containers. Queued writes are sent and the index catches up on its own once they answer.",
    });
  }
  if (s.state === "healthy" && s.reconcile.error) {
    problems.push({
      level: "warn",
      code: "search-reconcile-failing",
      message: `The search index reconcile failed: ${s.reconcile.error}.`,
      fix: "The next pass retries. Check the server log if this stays.",
    });
  }
  if (s.missingDocuments !== null && s.missingDocuments > 0) {
    problems.push({
      level: "warn",
      code: "search-documents-missing",
      message: `${s.missingDocuments} stored records are not yet in the search index.`,
      fix: "No action needed: reconcile adds them in the background.",
    });
  }
  if (s.droppedWrites > 0) {
    problems.push({
      level: "info",
      code: "search-writes-dropped",
      message: `${s.droppedWrites} search index writes were dropped while the search worker was unreachable.`,
      fix: "No action needed: reconcile re-derives them from the records.",
    });
  }
  if (s.missingVectors !== null && s.missingVectors > 0) {
    problems.push({
      level: "info",
      code: "search-vectors-missing",
      message: `${s.missingVectors} documents are waiting for a vector embedding.`,
      fix: s.reembed.state === "off"
        ? "Re-embedding is off. Set AM_SEARCH_REEMBED_PER_MINUTE above 0 to backfill them."
        : `They are embedded in the background at up to ${s.reembed.perMinute} per minute (AM_SEARCH_REEMBED_PER_MINUTE).`,
    });
  }
  return problems;
}

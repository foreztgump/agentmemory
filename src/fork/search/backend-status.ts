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
  sessions?: number;
  /** Units (a session's observations, the memories, a session gone from the records) compared document by document; for a collection, its records. */
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

export type CollectionName = "lessons" | "images";

/** One small collection (lessons, images) against its records, as the last reconcile compare found it. */
export interface CollectionStatus {
  state: "healthy" | "degraded";
  reason: string | null;
  pendingWrites: number;
  /** Writes dropped while the worker was unreachable; reconcile repairs them. */
  droppedWrites: number;
  /** Records with no entry or an outdated one; null until a compare has finished. */
  missing: number | null;
  /** Entries with no live record; null until a compare has finished. */
  extra: number | null;
  reconcile: ReconcileReport;
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
  collections?: Partial<Record<CollectionName, CollectionStatus>>;
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
  /** Resolves once keyword ranking is exact, or at the deadline with a warning; it never rejects. */
  whenRankingReady?(timeoutMs?: number, pollMs?: number): Promise<void>;
  /** Probes the backend (bounded) and reads cached counters. */
  status(): Promise<SearchBackendStatus>;
  degradedNotice(): DegradedNotice | null;
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
  if (s.missingDocuments === null && s.reconcile.state === "off") {
    problems.push({
      level: "info",
      code: "search-documents-unchecked",
      message: "Reconcile is off, so the search index is not checked for records it is missing.",
      fix: "Set AM_SEARCH_RECONCILE_INTERVAL_MS above 0 to check and backfill them.",
    });
  } else if (s.missingDocuments === null && s.state === "healthy") {
    problems.push({
      level: "info",
      code: "search-reconcile-pending",
      message: "The first reconcile pass since start has not finished, so missing search documents are not counted yet.",
      fix: "No action needed. The count appears when the pass ends; on an empty index that is the time it takes to fill it.",
    });
  }
  if (s.missingDocuments !== null && s.missingDocuments > 0) {
    problems.push({
      level: "warn",
      code: "search-documents-missing",
      message: `${s.missingDocuments} stored records are not yet in the search index.`,
      fix: s.reconcile.state === "off"
        ? "Reconcile is off. Set AM_SEARCH_RECONCILE_INTERVAL_MS above 0 to backfill them."
        : "No action needed: reconcile adds them in the background.",
    });
  }
  for (const [name, c] of Object.entries(s.collections ?? {})) {
    if (!c) continue;
    if (c.state === "healthy" && c.reconcile.error) {
      problems.push({
        level: "warn",
        code: "search-collection-reconcile-failing",
        message: `The ${name} search collection reconcile failed: ${c.reconcile.error}. Its missing and extra counts may be stale.`,
        fix: "The next pass retries. Check the server log if this stays.",
      });
    }
    const missing = c.missing ?? 0;
    const extra = c.extra ?? 0;
    if (missing + extra === 0) continue;
    problems.push({
      level: "warn",
      code: "search-collection-differs",
      message: `The ${name} search collection differs from the records: ${missing} missing or outdated, ${extra} with no record.`,
      fix: c.reconcile.state === "off"
        ? "Reconcile is off. Set AM_SEARCH_RECONCILE_INTERVAL_MS above 0 to repair it."
        : "No action needed: reconcile repairs it in the background.",
    });
  }
  const droppedWrites = Object.values(s.collections ?? {}).reduce((n, c) => n + (c?.droppedWrites ?? 0), s.droppedWrites);
  if (droppedWrites > 0) {
    problems.push({
      level: "info",
      code: "search-writes-dropped",
      message: `${droppedWrites} search index writes were dropped while the search worker was unreachable.`,
      fix: s.reconcile.state === "off"
        ? "Reconcile is off. Set AM_SEARCH_RECONCILE_INTERVAL_MS above 0 to re-derive them from the records."
        : "No action needed: reconcile re-derives them from the records.",
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

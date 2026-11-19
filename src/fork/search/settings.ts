export interface SearchWorkerSettings {
  qdrantUrl: string;
  qdrantApiKey?: string;
  collection: string;
  dimensions: number;
  oversampling: number;
  /** Mean document length in terms, used only until the collection holds a document. */
  avgdl: number;
}

// Mean term count per document of the synthetic corpus shaped like buddy's store
// (bench/fork/profiles/buddy-2026-11-16.json). The worker replaces it with the
// collection's own mean as soon as it holds a document.
export const DEFAULT_AVGDL = 70;

function positive(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}=${raw} must be a positive number`);
  return value;
}

// Qdrant answers every query with 422 when quantization oversampling is below 1.
function atLeastOne(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = positive(env, name, fallback);
  if (value < 1) throw new Error(`${name}=${value} must be at least 1`);
  return value;
}

/** Validates at boot so a bad setting fails the start, not the first search. */
export function loadSearchWorkerSettings(env: Record<string, string | undefined>): SearchWorkerSettings {
  const qdrantUrl = env.AM_QDRANT_URL?.trim();
  if (!qdrantUrl) throw new Error("AM_SEARCH_BACKEND=disk requires AM_QDRANT_URL (e.g. http://qdrant:6333)");
  if (!/^https?:\/\/[^\s]+$/.test(qdrantUrl)) throw new Error(`AM_QDRANT_URL=${qdrantUrl} is not an http(s) URL`);
  const collection = env.AM_QDRANT_COLLECTION?.trim() || "agentmemory";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(collection)) throw new Error(`AM_QDRANT_COLLECTION=${collection} may only use letters, digits, _ and -`);
  const dimensions = positive(env, "AM_SEARCH_DIMENSIONS", 1024);
  if (!Number.isInteger(dimensions)) throw new Error(`AM_SEARCH_DIMENSIONS=${dimensions} must be a positive whole number`);
  return {
    qdrantUrl: qdrantUrl.replace(/\/+$/, ""),
    qdrantApiKey: env.AM_QDRANT_API_KEY?.trim() || undefined,
    collection,
    dimensions,
    oversampling: atLeastOne(env, "AM_SEARCH_OVERSAMPLING", 6),
    avgdl: positive(env, "AM_SEARCH_AVGDL", DEFAULT_AVGDL),
  };
}

export interface MaintenanceSettings {
  /** Milliseconds between reconcile passes; 0 turns reconcile off. */
  reconcileIntervalMs: number;
  /** Sessions compared document by document each pass even when their counts agree; 0 compares counts only. */
  sweepPerPass: number;
  /** Embeddings per minute for documents without a vector; 0 turns re-embedding off. */
  reembedPerMinute: number;
}

function wholeAtLeastZero(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}=${raw} must be a whole number of 0 or more`);
  return value;
}

/** Read by the app worker in disk mode; validated at boot. */
export function loadMaintenanceSettings(env: Record<string, string | undefined>): MaintenanceSettings {
  return {
    reconcileIntervalMs: wholeAtLeastZero(env, "AM_SEARCH_RECONCILE_INTERVAL_MS", 60_000),
    sweepPerPass: wholeAtLeastZero(env, "AM_SEARCH_RECONCILE_SWEEP", 3),
    // Provider quotas count tokens; 120 a minute is about 13k tokens a minute at ~110 tokens a document.
    reembedPerMinute: wholeAtLeastZero(env, "AM_SEARCH_REEMBED_PER_MINUTE", 120),
  };
}

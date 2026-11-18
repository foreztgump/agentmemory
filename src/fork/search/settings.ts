export interface SearchWorkerSettings {
  qdrantUrl: string;
  qdrantApiKey?: string;
  collection: string;
  dimensions: number;
  oversampling: number;
  /** Mean document length in terms; frozen so a document's sparse weights never need rewriting. */
  avgdl: number;
}

// Mean term count per document of the synthetic corpus shaped like buddy's store
// (bench/fork/profiles/buddy-2026-11-16.json); keyword top-10 agreement with the
// in-memory index peaked there (0.964, against 0.927 at 40 and 0.934 at 100).
export const DEFAULT_AVGDL = 70;

function positive(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}=${raw} must be a positive number`);
  return value;
}

/** Validates at boot so a bad setting fails the start, not the first search. */
export function loadSearchWorkerSettings(env: Record<string, string | undefined>): SearchWorkerSettings {
  const qdrantUrl = env.AM_QDRANT_URL?.trim();
  if (!qdrantUrl) throw new Error("AM_SEARCH_BACKEND=disk requires AM_QDRANT_URL (e.g. http://qdrant:6333)");
  if (!/^https?:\/\/[^\s]+$/.test(qdrantUrl)) throw new Error(`AM_QDRANT_URL=${qdrantUrl} is not an http(s) URL`);
  const collection = env.AM_QDRANT_COLLECTION?.trim() || "agentmemory";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(collection)) throw new Error(`AM_QDRANT_COLLECTION=${collection} may only use letters, digits, _ and -`);
  return {
    qdrantUrl: qdrantUrl.replace(/\/+$/, ""),
    qdrantApiKey: env.AM_QDRANT_API_KEY?.trim() || undefined,
    collection,
    dimensions: Math.floor(positive(env, "AM_SEARCH_DIMENSIONS", 1024)),
    oversampling: positive(env, "AM_SEARCH_OVERSAMPLING", 6),
    avgdl: positive(env, "AM_SEARCH_AVGDL", DEFAULT_AVGDL),
  };
}

import { MAX_IMPORT_OBS_PER_SESSION } from "../config.js";

export const IMPORT_LIMITS = {
  sessions: 10_000,
  memories: 50_000,
  summaries: 10_000,
  observations: 500_000,
  accessLogs: 50_000,
  observationBuckets: 10_000,
  observationsPerSession: MAX_IMPORT_OBS_PER_SESSION,
} as const;

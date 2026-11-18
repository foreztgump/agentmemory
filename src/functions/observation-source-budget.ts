import type { CompressedObservation, SessionSourceTotals } from "../types.js";
import { oversizedPayloadError, payloadByteLength, SAFE_PAYLOAD_BYTES, type OversizedPayload } from "../state/frame-guard.js";
import { normalizeObservationSource, OBSERVATION_SOURCE_MAX_BYTES, withoutObservationSource } from "./observation-source.js";

export const SESSION_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

export type { SessionSourceTotals };

export const EMPTY_SESSION_TOTALS: SessionSourceTotals = { rows: 0, sourceBytes: 0, summaryBytes: 0 };

export function observationSourceTotals(rows: CompressedObservation[]): SessionSourceTotals {
  const totals = { ...EMPTY_SESSION_TOTALS };
  for (const row of rows) {
    totals.rows++;
    totals.sourceBytes += row?.source ? payloadByteLength(row.source) + 10 : 0;
    totals.summaryBytes += payloadByteLength(withoutObservationSource(row));
  }
  return totals;
}

export function budgetLiveObservationSource(
  observation: CompressedObservation,
  existing: CompressedObservation[] | SessionSourceTotals,
): CompressedObservation {
  const kept = Array.isArray(existing)
    ? observationSourceTotals(existing.filter((row) => row.id !== observation.id))
    : existing;
  const planned = planObservationSources([{ ...observation, source: normalizeObservationSource(observation.source) }], kept);
  return planned.success ? planned.observations[0]! : withoutObservationSource(observation);
}

export function budgetImportedObservationSources(
  incoming: CompressedObservation[],
  existing: CompressedObservation[] = [],
  strategy: "merge" | "replace" | "skip" = "merge",
): { success: true; observations: CompressedObservation[]; sourceTruncated: number; sourceOmitted: number } | OversizedPayload {
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const rows = incoming.map((row) => ({ ...row, source: normalizeObservationSource(row.source) }));
  const written = rows.filter((row) => strategy !== "skip" || !existingById.has(row.id));
  const replacedIds = new Set(written.map((row) => row.id));
  const kept = strategy === "replace" ? [] : existing.filter((row) => !replacedIds.has(row.id));
  const planned = planObservationSources(written, observationSourceTotals(kept));
  return planned.success ? { ...planned, observations: rows } : planned;
}

const EMPTY_ENVELOPE_BYTES = payloadByteLength({
  message_type: "invocation_result",
  invocation_id: "00000000-0000-0000-0000-000000000000",
  result: [],
});

function planObservationSources(
  written: CompressedObservation[],
  kept: SessionSourceTotals,
): { success: true; observations: CompressedObservation[]; sourceTruncated: number; sourceOmitted: number } | OversizedPayload {
  const writtenSummaryBytes = written.reduce((sum, row) => sum + payloadByteLength(withoutObservationSource(row)), 0);
  const items = kept.rows + written.length;
  const envelopeBytes = EMPTY_ENVELOPE_BYTES + kept.summaryBytes + kept.sourceBytes + writtenSummaryBytes + Math.max(0, items - 1);
  if (envelopeBytes > SAFE_PAYLOAD_BYTES) {
    return oversizedPayloadError(envelopeBytes, "observation summaries already exceed one session response; split the import into smaller sessions");
  }

  const sourceRows = written.filter((row) => row.source !== undefined);
  const available = Math.max(0, Math.min(
    SESSION_SOURCE_MAX_BYTES - kept.sourceBytes,
    SAFE_PAYLOAD_BYTES - envelopeBytes - 64 * 1024,
  ));
  const incomingSourceBytes = sourceRows.reduce((sum, row) => sum + payloadByteLength(row.source) + 10, 0);
  const perSource = incomingSourceBytes <= available
    ? OBSERVATION_SOURCE_MAX_BYTES
    : Math.min(OBSERVATION_SOURCE_MAX_BYTES, Math.floor(available / Math.max(1, sourceRows.length)) - 10);
  let sourceTruncated = 0;
  let sourceOmitted = 0;
  for (const row of sourceRows) {
    const source = row.source!;
    const metadata = { hookType: source.hookType, originalBytes: source.originalBytes, truncated: true };
    if (payloadByteLength(metadata) > perSource) {
      delete row.source;
      sourceOmitted++;
      continue;
    }
    row.source = normalizeObservationSource(source, perSource);
    if (row.source?.truncated) sourceTruncated++;
  }
  return { success: true, observations: written, sourceTruncated, sourceOmitted };
}

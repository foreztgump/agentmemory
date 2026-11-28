import type { IIIClient } from "iii-sdk";
import type {
  CompressedObservation,
  Session,
  TimelineEntry,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV, collectAll, mapPooled } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import { withoutObservationSource } from "./observation-source.js";

export function registerTimelineFunction(sdk: IIIClient, kv: StateKV): void {
  sdk.registerFunction("mem::timeline", 
    async (data: {
      anchor: string;
      project?: string;
      before?: number;
      after?: number;
    }) => {
      const before = Math.max(0, Math.floor(data.before ?? 5));
      const after = Math.max(0, Math.floor(data.after ?? 5));

      if (!data.anchor || typeof data.anchor !== "string") {
        return { entries: [], anchor: data.anchor, reason: "invalid_anchor" };
      }

      let anchorTime = NaN;
      const isoAnchor = /^\d{4}-\d{2}-\d{2}/.test(data.anchor);
      if (isoAnchor) {
        anchorTime = new Date(data.anchor).getTime();
        if (isNaN(anchorTime)) {
          return { entries: [], anchor: data.anchor, reason: "invalid_date" };
        }
      }

      const scanned = await listSessionObservations(kv, data.project);
      if (!isoAnchor) {
        const searchResults = findByKeyword(scanned, data.anchor);
        if (searchResults.length === 0) {
          return { entries: [], anchor: data.anchor, reason: "no_match" };
        }
        anchorTime = new Date(searchResults[0].timestamp).getTime();
      }

      const allObs: Array<CompressedObservation & { sid: string }> = [];
      for (const { sessionId, observations } of scanned) {
        for (const obs of observations) {
          if (obs.title && obs.timestamp) {
            allObs.push({ ...obs, sid: sessionId });
          }
        }
      }

      allObs.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      let anchorIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < allObs.length; i++) {
        const dist = Math.abs(
          new Date(allObs[i].timestamp).getTime() - anchorTime,
        );
        if (dist < minDist) {
          minDist = dist;
          anchorIdx = i;
        }
      }

      const startIdx = Math.max(0, anchorIdx - before);
      const endIdx = Math.min(allObs.length - 1, anchorIdx + after);
      const entries: TimelineEntry[] = [];

      for (let i = startIdx; i <= endIdx; i++) {
        const obs = allObs[i];
        const { sid, ...observation } = obs;
        entries.push({
          observation: withoutObservationSource(observation),
          sessionId: sid,
          relativePosition: i - anchorIdx,
        });
      }

      void recordAccessBatch(
        kv,
        entries.map((e) => e.observation.id),
      );

      logger.info("Timeline retrieved", {
        anchor: data.anchor,
        entries: entries.length,
      });
      return { entries, anchorIndex: anchorIdx - startIdx };
    },
  );
}

async function listSessionObservations(
  kv: StateKV,
  project?: string,
): Promise<Array<{ sessionId: string; observations: CompressedObservation[] }>> {
  const sessions = await collectAll<Session>(kv, KV.sessions);
  const filtered = project
    ? sessions.filter((s) => s.project === project)
    : sessions;
  const lists = await mapPooled(filtered, (session) =>
    kv.list<CompressedObservation>(KV.observations(session.id)),
  );
  return filtered.map((session, i) => ({ sessionId: session.id, observations: lists[i] }));
}

function findByKeyword(
  scanned: Array<{ observations: CompressedObservation[] }>,
  keyword: string,
): CompressedObservation[] {
  const lower = keyword.toLowerCase();
  const matches: CompressedObservation[] = [];

  for (const { observations } of scanned) {
    for (const obs of observations) {
      if (
        obs.title?.toLowerCase().includes(lower) ||
        obs.narrative?.toLowerCase().includes(lower) ||
        obs.concepts?.some((c) => c.toLowerCase().includes(lower))
      ) {
        matches.push(obs);
      }
    }
  }

  return matches.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

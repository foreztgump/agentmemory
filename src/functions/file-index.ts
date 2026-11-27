import type { IIIClient } from "iii-sdk";
import type { CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV, collectAll } from "../state/kv.js";
import { observationStatsOf } from "../fork/kv/observation-stats.js";
import { FileContextIndex, basenameOf } from "../fork/kv/file-context-index.js";
import { recordAudit } from "./audit.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";

interface FileHistory {
  file: string;
  observations: Array<{
    sessionId: string;
    obsId: string;
    type: string;
    title: string;
    narrative: string;
    importance: number;
    timestamp: string;
  }>;
}

type SessionRef = Pick<Session, "id" | "project" | "startedAt">;
type FileRow = Pick<CompressedObservation, "id" | "type" | "title" | "narrative" | "importance" | "timestamp" | "files">;

/** The sessions to search and, per session and normalized file, the rows that may mention it in `kv.list` order. */
interface SessionRows {
  sessionIds: string[];
  rowsOf: (sessionId: string, normalizedFile: string) => readonly FileRow[];
}

function recentSessions<S extends SessionRef>(sessions: readonly S[], sessionId: string, project?: string): S[] {
  let otherSessions = sessionId ? sessions.filter((s) => s.id !== sessionId) : [...sessions];
  if (project) {
    otherSessions = otherSessions.filter((s) => s.project === project);
  }
  return otherSessions
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 15);
}

async function scannedRows(kv: StateKV, sessionId: string, project?: string): Promise<SessionRows> {
  const sessions = recentSessions(await collectAll<Session>(kv, KV.sessions), sessionId, project);
  const obsCache = new Map<string, CompressedObservation[]>();
  for (const session of sessions) {
    obsCache.set(session.id, await kv.list<CompressedObservation>(KV.observations(session.id)));
  }
  return { sessionIds: sessions.map((s) => s.id), rowsOf: (id) => obsCache.get(id) || [] };
}

async function indexedRows(index: FileContextIndex, sessionId: string, project?: string): Promise<SessionRows> {
  const sessionIds = recentSessions(await index.allSessions(), sessionId, project).map((s) => s.id);
  const postings = await index.postingsOf(sessionIds);
  return { sessionIds, rowsOf: (id, normalizedFile) => postings.get(id)?.(basenameOf(normalizedFile)) ?? [] };
}

function fileHistory(file: string, { sessionIds, rowsOf }: SessionRows): FileHistory {
  const history: FileHistory = { file, observations: [] };
  const normalizedFile = file.replace(/^\.\//, "");

  for (const sessionId of sessionIds) {
    for (const obs of rowsOf(sessionId, normalizedFile)) {
      if (!obs.files || !obs.title) continue;
      const matches = obs.files.some(
        (f) =>
          f === file ||
          f === normalizedFile ||
          f.endsWith(`/${normalizedFile}`) ||
          normalizedFile.endsWith(`/${f}`),
      );
      if (matches && obs.importance >= 4) {
        history.observations.push({
          sessionId,
          obsId: obs.id,
          type: obs.type,
          title: obs.title,
          narrative: obs.narrative,
          importance: obs.importance,
          timestamp: obs.timestamp,
        });
      }
    }
  }

  history.observations.sort((a, b) => b.importance - a.importance);
  history.observations = history.observations.slice(0, 5);
  return history;
}

export function registerFileIndexFunction(sdk: IIIClient, kv: StateKV): void {
  const stats = observationStatsOf(kv);
  const index = kv.backend === "redis" && stats ? new FileContextIndex(kv, stats) : null;

  sdk.registerFunction("mem::file-context",
    async (
      data: { sessionId?: string; files?: string[]; project?: string } | undefined,
    ) => {
      const sessionId =
        data && typeof data.sessionId === "string" ? data.sessionId.trim() : "";
      const normalizedProject =
        typeof data?.project === "string" ? data.project.trim() : undefined;
      const files = Array.isArray(data?.files)
        ? data!.files
            .map((file) => (typeof file === "string" ? file.trim() : ""))
            .filter(Boolean)
        : [];
      if (files.length === 0) {
        await recordAudit(kv, "observe", "mem::file-context", [sessionId || "unknown"], {
          error: "invalid_payload",
          hasSessionId: !!sessionId,
          hasProject: !!normalizedProject,
          fileCount: files.length,
        });
        return { context: "", files: [] };
      }

      const rows = index
        ? await indexedRows(index, sessionId, normalizedProject)
        : await scannedRows(kv, sessionId, normalizedProject);
      const results = files.map((file) => fileHistory(file, rows)).filter((fh) => fh.observations.length > 0);

      if (results.length === 0) {
        return { context: "" };
      }

      const lines: string[] = ["<agentmemory-file-context>"];
      for (const fh of results) {
        lines.push(`## ${fh.file}`);
        for (const obs of fh.observations) {
          lines.push(`- [${obs.type}] ${obs.title}: ${obs.narrative}`);
        }
      }
      lines.push("</agentmemory-file-context>");

      const accessedIds: string[] = [];
      for (const fh of results) {
        for (const obs of fh.observations) accessedIds.push(obs.obsId);
      }
      void recordAccessBatch(kv, accessedIds);

      const context = lines.join("\n");
      logger.info("File context generated", {
        files: files.length,
        results: results.length,
      });
      return { context };
    },
  );
}

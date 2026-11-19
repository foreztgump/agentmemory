import { http } from "@iii-dev/helpers/http";
import type { Writable } from "node:stream";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { pinGraphState } from "../state/graph-generation.js";
import { KV } from "../state/schema.js";
import { VERSION } from "../version.js";
import type { Memory, Session } from "../types.js";

export const EXPORT_STREAM_FORMAT = "agentmemory-export-stream";
export const PART_BYTES = 4 * 1024 * 1024;
const OBS = "\0obs:";

/** The collections `mem::export` returns after sessions, memories and summaries, minus access logs; a test pins it to upstream's list. */
export const STREAM_COLLECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["graphNodes", KV.graphNodes],
  ["graphEdges", KV.graphEdges],
  ["semanticMemories", KV.semantic],
  ["proceduralMemories", KV.procedural],
  ["actions", KV.actions],
  ["actionEdges", KV.actionEdges],
  ["sentinels", KV.sentinels],
  ["sketches", KV.sketches],
  ["crystals", KV.crystals],
  ["facets", KV.facets],
  ["lessons", KV.lessons],
  ["insights", KV.insights],
  ["routines", KV.routines],
  ["signals", KV.signals],
  ["checkpoints", KV.checkpoints],
];

export type ExportStreamLine =
  | { t: "header"; format: typeof EXPORT_STREAM_FORMAT; v: 1; version: string; exportedAt: string }
  | { t: "part"; seq: number; data: Record<string, unknown> }
  | { t: "end"; parts: number; rows: Record<string, number> }
  | { t: "error"; message: string };

async function* pages(kv: StateKV, scope: string): AsyncIterable<unknown[]> {
  if (typeof kv.iterate !== "function") {
    yield await kv.list(scope);
    return;
  }
  yield* kv.iterate(scope);
}

async function getMany(kv: StateKV, scope: string, keys: string[]): Promise<unknown[]> {
  if (typeof kv.getMany === "function") return kv.getMany(scope, keys);
  return Promise.all(keys.map((key) => kv.get(scope, key)));
}

/**
 * Writes the whole store as NDJSON: a header, then parts, then an end line. Each part's
 * `data` is a partial ExportData that `mem::import` accepts on its own, at most `partBytes`
 * unless one row is larger. Only one KV page and one part are held at a time. Access logs
 * ride in the part of their memory, because `mem::import` drops a log whose memory is not
 * in the same payload.
 */
export async function streamExport(
  state: StateKV,
  write: (line: string) => Promise<void>,
  partBytes = PART_BYTES,
): Promise<{ parts: number; rows: Record<string, number> }> {
  const kv = await pinGraphState(state);
  const rows: Record<string, number> = {};
  let seq = 0;
  let open = new Map<string, string[]>();
  let bytes = 0;

  const flush = async () => {
    if (open.size === 0) return;
    const fields: string[] = [];
    const observations: string[] = [];
    for (const [key, items] of open) {
      const list = `[${items.join(",")}]`;
      if (key.startsWith(OBS)) observations.push(`${JSON.stringify(key.slice(OBS.length))}:${list}`);
      else fields.push(`${JSON.stringify(key)}:${list}`);
    }
    if (observations.length) fields.push(`"observations":{${observations.join(",")}}`);
    open = new Map();
    bytes = 0;
    await write(`{"t":"part","seq":${seq++},"data":{${fields.join(",")}}}`);
  };
  const add = async (key: string, row: unknown) => {
    const field = key.startsWith(OBS) ? "observations" : key;
    const json = JSON.stringify(row);
    const size = Buffer.byteLength(json) + 1;
    if (field !== "accessLogs" && bytes > 0 && bytes + size > partBytes) await flush();
    const items = open.get(key) ?? [];
    items.push(json);
    open.set(key, items);
    bytes += size;
    rows[field] = (rows[field] ?? 0) + 1;
  };

  await write(JSON.stringify({ t: "header", format: EXPORT_STREAM_FORMAT, v: 1, version: VERSION, exportedAt: new Date().toISOString() }));

  for await (const page of pages(kv, KV.sessions)) {
    for (const session of page as Session[]) {
      await add("sessions", session);
      for await (const obs of pages(kv, KV.observations(session.id))) {
        for (const row of obs) await add(OBS + session.id, row);
      }
    }
  }

  for await (const page of pages(kv, KV.memories)) {
    const memories = page as Memory[];
    const logs = await getMany(kv, KV.accessLog, memories.map((m) => m.id));
    for (const [i, memory] of memories.entries()) {
      await add("memories", memory);
      if (logs[i]) await add("accessLogs", logs[i]);
    }
  }

  const scopes: ReadonlyArray<readonly [string, string]> = [
    ["summaries", KV.summaries],
    ["profiles", KV.profiles],
    ...STREAM_COLLECTIONS,
  ];
  for (const [field, scope] of scopes) {
    for await (const page of pages(kv, scope)) for (const row of page) await add(field, row);
  }
  await flush();

  await write(JSON.stringify({ t: "end", parts: seq, rows }));
  return { parts: seq, rows };
}

function writeLine(stream: Writable, line: string): Promise<void> {
  if (stream.destroyed) return Promise.reject(new Error("export client disconnected"));
  if (stream.write(`${line}\n`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      stream.off("drain", onDrain);
      stream.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error("export client disconnected"));
    stream.once("drain", onDrain);
    stream.once("close", onClose);
  });
}

export function exportStreamHandler(kv: StateKV) {
  return http(async (_req, res) => {
    res.status(200);
    res.headers({ "content-type": "application/x-ndjson", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const stream = res.stream as Writable;
    const write = (line: string) => writeLine(stream, line);
    try {
      const { parts, rows } = await streamExport(kv, write);
      logger.info("Streamed export complete", { parts, rows });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Streamed export failed", { error: message });
      await write(JSON.stringify({ t: "error", message })).catch(() => {});
    } finally {
      stream.end();
    }
  });
}

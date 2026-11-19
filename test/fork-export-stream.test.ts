import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExportImportFunction, EXPORT_COLLECTIONS } from "../src/functions/export-import.js";
import { streamExport, PART_BYTES, STREAM_COLLECTIONS } from "../src/fork/export-stream.js";
import { runExportCommand, runImportCommand, verifyExportFile } from "../src/fork/cli-export-import.js";
import { SAFE_PAYLOAD_BYTES } from "../src/state/frame-guard.js";
import { KV } from "../src/state/schema.js";
import type { StateKV } from "../src/state/kv.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

type Store = ReturnType<typeof mockKV>;

function seed(kv: Store, sessions: number, obsPerSession: number, obsBytes = 200): void {
  const set = (scope: string, key: string, value: unknown) => {
    if (!kv.store.has(scope)) kv.store.set(scope, new Map());
    kv.store.get(scope)!.set(key, value);
  };
  for (let s = 0; s < sessions; s++) {
    const id = `ses_${s}`;
    set(KV.sessions, id, { id, project: `p${s % 3}`, cwd: "/tmp", startedAt: "2026-11-01T00:00:00Z", status: "completed", observationCount: obsPerSession });
    for (let o = 0; o < obsPerSession; o++) {
      set(KV.observations(id), `obs_${s}_${o}`, {
        id: `obs_${s}_${o}`, sessionId: id, timestamp: "2026-11-01T00:00:01Z", type: "file_edit", title: `t${o}`,
        facts: [], narrative: "x".repeat(obsBytes), concepts: [], files: [], importance: 5,
      });
    }
    set(KV.summaries, id, { sessionId: id, project: `p${s % 3}`, createdAt: "2026-11-01T01:00:00Z", title: "s", narrative: "n", keyDecisions: [], filesModified: [], concepts: [], observationCount: obsPerSession });
  }
  for (let m = 0; m < 30; m++) {
    const id = `mem_${m}`;
    set(KV.memories, id, { id, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", type: "fact", title: `m${m}`, content: "c".repeat(300), concepts: [], files: [], sessionIds: [], strength: 1, version: 1, isLatest: true });
    if (m % 2 === 0) set(KV.accessLog, id, { memoryId: id, count: m, lastAt: "2026-11-01T00:00:00Z", recent: [1] });
  }
  for (let p = 0; p < 3; p++) set(KV.profiles, `p${p}`, { project: `p${p}`, updatedAt: "2026-11-01T00:00:00Z", topConcepts: [], topFiles: [], conventions: [], commonErrors: [], recentActivity: [], sessionCount: 1, totalObservations: 1 });
  for (let l = 0; l < 7; l++) set(KV.lessons, `les_${l}`, { id: `les_${l}`, content: "lesson", context: "", confidence: 0.5, reinforcements: 0, source: "manual", sourceIds: [], tags: [], createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", decayRate: 0.05 });
  for (let i = 0; i < 12; i++) set(KV.semantic, `sem_${i}`, { id: `sem_${i}`, fact: "f", confidence: 1, sourceSessionIds: [], sourceMemoryIds: [], accessCount: 0, lastAccessedAt: "2026-11-01T00:00:00Z", strength: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
}

function counts(kv: Store): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [scope, rows] of kv.store) {
    const family = scope.startsWith("mem:obs:") ? "mem:obs:*" : scope;
    if (rows.size) out[family] = (out[family] ?? 0) + rows.size;
  }
  return out;
}

async function exportLines(kv: Store, partBytes?: number): Promise<string[]> {
  const lines: string[] = [];
  await streamExport(kv as unknown as StateKV, async (line) => { lines.push(line); }, partBytes);
  return lines;
}

function streamResponse(lines: string[]): Response {
  return new Response(lines.map((line) => `${line}\n`).join(""), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "am-export-stream-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("streamed export", () => {
  it("streams the same collections as mem::export", () => {
    expect([...STREAM_COLLECTIONS, ["accessLogs", KV.accessLog]]).toEqual(EXPORT_COLLECTIONS);
  });

  it("round-trips every collection through the CLI into an empty store with equal counts", async () => {
    const source = mockKV();
    seed(source, 25, 40);
    const lines = await exportLines(source, 8 * 1024);
    const parts = lines.filter((line) => line.startsWith('{"t":"part"'));
    expect(parts.length).toBeGreaterThan(5);

    const file = join(dir, "backup.ndjson");
    const log: string[] = [];
    expect(await runExportCommand({ base: "http://src", args: [file], log: (l) => log.push(l), fetchImpl: async () => streamResponse(lines) })).toBe(0);

    const target = mockKV();
    const sdk = mockSdk({ looseTrigger: true });
    registerExportImportFunction(sdk as never, target as never);
    const bodies: number[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body).length);
      const payload = JSON.parse(String(init.body));
      return Response.json(await sdk.trigger({ function_id: "mem::import", payload }));
    }) as unknown as typeof fetch;
    expect(await runImportCommand({ base: "http://dst", args: [file], log: (l) => log.push(l), fetchImpl })).toBe(0);
    expect(bodies.length).toBe(parts.length);

    const want = counts(source);
    const got = counts(target);
    for (const [family, n] of Object.entries(want)) expect([family, got[family]]).toEqual([family, n]);
  });

  it("streams a store larger than the 60 MiB reply limit in parts that each stay under the part cap", async () => {
    const source = mockKV();
    seed(source, 80, 16, 50 * 1024);
    let bytes = 0;
    let largest = 0;
    let parts = 0;
    let end: { rows: Record<string, number> } | undefined;
    await streamExport(source as unknown as StateKV, async (line) => {
      bytes += Buffer.byteLength(line) + 1;
      largest = Math.max(largest, Buffer.byteLength(line));
      if (line.startsWith('{"t":"part"')) parts++;
      if (line.startsWith('{"t":"end"')) end = JSON.parse(line);
    });
    expect(bytes).toBeGreaterThan(SAFE_PAYLOAD_BYTES);
    expect(largest).toBeLessThan(PART_BYTES + 64 * 1024);
    expect(parts).toBeGreaterThan(15);
    expect(end?.rows.observations).toBe(80 * 16);
    expect(end?.rows.sessions).toBe(80);
  });

  it("keeps each access log in the same part as its memory", async () => {
    const source = mockKV();
    seed(source, 1, 1);
    const lines = await exportLines(source, 600);
    for (const line of lines.filter((l) => l.startsWith('{"t":"part"'))) {
      const { data } = JSON.parse(line) as { data: { memories?: Array<{ id: string }>; accessLogs?: Array<{ memoryId: string }> } };
      const ids = new Set((data.memories ?? []).map((m) => m.id));
      for (const log of data.accessLogs ?? []) expect(ids.has(log.memoryId)).toBe(true);
    }
  });
});

describe("export file verification", () => {
  async function fileOf(lines: string[]): Promise<string> {
    const file = join(dir, `f${Math.random()}.ndjson`);
    await writeFile(file, lines.map((line) => `${line}\n`).join(""));
    return file;
  }

  it("rejects a truncated file, a missing part, an error line and a non-export file", async () => {
    const source = mockKV();
    seed(source, 5, 10);
    const lines = await exportLines(source, 2 * 1024);
    await expect(verifyExportFile(await fileOf(lines))).resolves.toBeTruthy();
    await expect(verifyExportFile(await fileOf(lines.slice(0, -1)))).rejects.toThrow(/truncated/);
    await expect(verifyExportFile(await fileOf([...lines.slice(0, 2), ...lines.slice(3)]))).rejects.toThrow(/expected part 1/);
    await expect(verifyExportFile(await fileOf([...lines.slice(0, 3), '{"t":"error","message":"boom"}']))).rejects.toThrow(/boom/);
    await expect(verifyExportFile(await fileOf(['{"version":"0.9.33","sessions":[]}']))).rejects.toThrow(/not an agentmemory stream export/);
    const cut = (await readFile(await fileOf(lines), "utf8")).slice(0, -40);
    await expect(verifyExportFile(await fileOf([cut]))).rejects.toThrow();
  });

  it("export leaves no file when the stream ends early", async () => {
    const source = mockKV();
    seed(source, 3, 3);
    const lines = await exportLines(source, 1024);
    const file = join(dir, "short.ndjson");
    const code = await runExportCommand({ base: "http://src", args: [file], log: () => {}, fetchImpl: async () => streamResponse(lines.slice(0, -1)) });
    expect(code).toBe(1);
    await expect(access(file)).rejects.toThrow();
    await expect(access(`${file}.part`)).rejects.toThrow();
  });

  it("import refuses replace and stops at the first failed part", async () => {
    const source = mockKV();
    seed(source, 3, 3);
    const file = await fileOf(await exportLines(source, 1024));
    expect(await runImportCommand({ base: "http://dst", args: [file, "--strategy", "replace"], log: () => {} })).toBe(2);
    let calls = 0;
    const log: string[] = [];
    const fetchImpl = (async () => { calls++; return Response.json({ success: false, error: "nope" }, { status: 200 }); }) as unknown as typeof fetch;
    expect(await runImportCommand({ base: "http://dst", args: [file], log: (l) => log.push(l), fetchImpl })).toBe(1);
    expect(calls).toBe(1);
    expect(log.join("\n")).toMatch(/stopped at part 0/);
  });
});

describe("stream backpressure", () => {
  it("ends the export when the client stops reading", async () => {
    const { Writable } = await import("node:stream");
    const { writeLine } = await import("../src/fork/export-stream.js");
    const stuck = new Writable({ highWaterMark: 4, write: () => {} });
    await writeLine(stuck, "a").catch(() => {});
    await expect(writeLine(stuck, "more than the buffer", 50)).rejects.toThrow(/read nothing/);
    expect(stuck.destroyed).toBe(true);
  });
});

describe("export stream handler", () => {
  it("survives a client that resets the connection mid-export", async () => {
    const { Writable } = await import("node:stream");
    const { exportStreamHandler } = await import("../src/fork/export-stream.js");
    const source = mockKV();
    seed(source, 20, 20, 2000);
    let written = 0;
    let calls = 0;
    const stream = new Writable({
      highWaterMark: 1024,
      write(chunk, _enc, callback) {
        written += chunk.length;
        calls++;
        if (written > 100_000) callback(Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" }));
        else setImmediate(callback);
      },
    });
    const response = { sendMessage: vi.fn(), close: vi.fn(), stream };
    const handler = exportStreamHandler(source as unknown as StateKV);
    await expect(handler({ path_params: {}, query_params: {}, body: undefined, headers: {}, method: "GET", request_body: {} as never, response })).resolves.toBeUndefined();
    expect(stream.destroyed).toBe(true);
    expect(calls).toBeLessThanOrEqual(3);
  });
});

describe("export stream route", () => {
  it("registers GET /agentmemory/export/stream behind the auth middleware", async () => {
    const { registerApiTriggers } = await import("../src/triggers/api.js");
    const sdk = mockSdk({ looseTrigger: true });
    registerApiTriggers(sdk as never, mockKV() as never, "secret");
    expect(sdk.fns.has("api::export-stream")).toBe(true);
    expect(sdk.registerTrigger).toHaveBeenCalledWith({
      type: "http",
      function_id: "api::export-stream",
      config: { api_path: "/agentmemory/export/stream", http_method: "GET", middleware_function_ids: ["middleware::api-auth"] },
    });
  });
});

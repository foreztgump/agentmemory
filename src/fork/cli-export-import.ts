import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { EXPORT_STREAM_FORMAT, STALL_MS, type ExportStreamLine } from "./export-stream.js";

interface CommandOptions {
  base: string;
  args: string[];
  secret?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  idleMs?: number;
}

type Header = Extract<ExportStreamLine, { t: "header" }>;
type End = Extract<ExportStreamLine, { t: "end" }>;

const VALUE_FLAGS = new Set(["--port", "--instance", "--data-dir", "--tools"]);
const IMPORT_TIMEOUT_MS = 180_000;

function parseArgs(args: string[], valueFlags: string[]): { file?: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg) || VALUE_FLAGS.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      values[arg] = value;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const [flag, value] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
      if (valueFlags.includes(flag) || VALUE_FLAGS.has(flag)) { values[flag] = value; continue; }
    }
    if (arg === "--verbose" || arg === "-v") continue;
    if (!arg.startsWith("-") && file === undefined) { file = arg; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { file, values };
}

function rowsOf(data: Record<string, unknown>): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const [field, value] of Object.entries(data)) {
    if (Array.isArray(value)) rows[field] = value.length;
    else if (field === "observations" && value && typeof value === "object") {
      rows[field] = Object.values(value).reduce((n: number, list) => n + (Array.isArray(list) ? list.length : 0), 0);
    }
  }
  return rows;
}

function addRows(total: Record<string, number>, rows: Record<string, number>): void {
  for (const [field, n] of Object.entries(rows)) if (n) total[field] = (total[field] ?? 0) + n;
}

function sameRows(a: Record<string, number>, b: Record<string, number>): boolean {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...fields].every((field) => (a[field] ?? 0) === (b[field] ?? 0));
}

function parseLine(raw: string, n: number): ExportStreamLine {
  try {
    return JSON.parse(raw) as ExportStreamLine;
  } catch {
    throw new Error(`line ${n} is not valid JSON; the file is truncated or corrupt`);
  }
}

// Splits on "\n" only: JSON.stringify leaves U+2028/U+2029 raw, and node:readline would break lines there.
async function* readLines(path: string): AsyncGenerator<ExportStreamLine> {
  const decoder = new StringDecoder("utf8");
  let pending: string[] = [];
  let n = 0;
  for await (const chunk of createReadStream(path)) {
    const pieces = decoder.write(chunk as Buffer).split("\n");
    for (let i = 0; i < pieces.length - 1; i++) {
      const raw = pending.join("") + pieces[i];
      pending = [];
      n++;
      if (raw.length > 0) yield parseLine(raw, n);
    }
    pending.push(pieces[pieces.length - 1]!);
  }
  const last = pending.join("") + decoder.end();
  if (last.length > 0) yield parseLine(last, n + 1);
}

/** Reads the whole file once, one line at a time, and checks it is a complete stream export. */
export async function verifyExportFile(path: string): Promise<{ header: Header; end: End }> {
  let header: Header | undefined;
  let end: End | undefined;
  let seq = 0;
  const rows: Record<string, number> = {};
  for await (const line of readLines(path)) {
    if (end) throw new Error("data after the end line");
    if (line.t === "error") throw new Error(`the server failed during export: ${line.message}`);
    if (!header) {
      if (line.t !== "header" || line.format !== EXPORT_STREAM_FORMAT) throw new Error("not an agentmemory stream export (no header line)");
      header = line;
      continue;
    }
    if (line.t === "end") { end = line; continue; }
    if (line.t !== "part" || line.seq !== seq) throw new Error(`expected part ${seq}; the file is out of order or corrupt`);
    seq++;
    addRows(rows, rowsOf(line.data));
  }
  if (!header) throw new Error("the file is empty");
  if (!end) throw new Error("no end line; the export is truncated");
  if (end.parts !== seq || !sameRows(end.rows, rows)) throw new Error("row counts do not match the end line; the file is corrupt");
  return { header, end };
}

function headersFor(secret?: string): Record<string, string> {
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

function formatRows(rows: Record<string, number>): string {
  return Object.entries(rows).map(([field, n]) => `${field} ${n}`).join(", ") || "nothing";
}

export async function runExportCommand(options: CommandOptions): Promise<number> {
  const log = options.log ?? console.log;
  let file: string | undefined;
  try {
    ({ file } = parseArgs(options.args, []));
    if (!file) throw new Error("Usage: agentmemory export <file>");
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const partial = `${file}.part`;
  const controller = new AbortController();
  const idleMs = options.idleMs ?? STALL_MS;
  let input: Readable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle!: (error: Error) => void;
  const idle = new Promise<never>((_, reject) => { rejectIdle = reject; });
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error(`export stalled: no data from the server for ${idleMs / 1000} s`);
      rejectIdle(error);
      controller.abort(error);
      input?.destroy(error);
    }, idleMs);
  };
  try {
    resetIdle();
    const response = await Promise.race([(options.fetchImpl ?? fetch)(`${options.base}/agentmemory/export/stream`, {
      headers: headersFor(options.secret),
      signal: controller.signal,
    }), idle]);
    if (!response.ok || !response.body) {
      const text = await Promise.race([response.text().catch(() => ""), idle]);
      const hint = response.status === 404 ? " (the server does not support streamed export; upgrade it)" : "";
      throw new Error(`export failed: HTTP ${response.status}${hint} ${text.slice(0, 300)}`);
    }
    input = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    input.on("data", resetIdle);
    input.once("end", () => clearTimeout(timer));
    await pipeline(input, createWriteStream(partial, { mode: 0o600 }));
    clearTimeout(timer);
    const { end } = await verifyExportFile(partial);
    await rename(partial, file);
    log(`Exported ${end.parts} parts to ${file}: ${formatRows(end.rows)}`);
    return 0;
  } catch (error) {
    await rm(partial, { force: true });
    log(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

export async function runImportCommand(options: CommandOptions): Promise<number> {
  const log = options.log ?? console.log;
  let file: string | undefined;
  let strategy: string;
  try {
    const parsed = parseArgs(options.args, ["--strategy"]);
    file = parsed.file;
    strategy = parsed.values["--strategy"] ?? "merge";
    if (!file) throw new Error("Usage: agentmemory import <file> [--strategy merge|skip]");
    if (strategy !== "merge" && strategy !== "skip") {
      throw new Error("--strategy must be merge or skip; replace needs one complete payload, so import into an empty stack instead");
    }
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const { header, end } = await verifyExportFile(file);
    const stats: Record<string, number> = {};
    const rows: Record<string, number> = {};
    let posted = 0;
    for await (const line of readLines(file)) {
      if (line.t !== "part") continue;
      if (line.seq !== posted || posted >= end.parts) {
        throw new Error(`import stopped at part ${line.seq}: expected part ${posted} of ${end.parts}; the file changed since verify`);
      }
      const exportData = { version: header.version, exportedAt: header.exportedAt, sessions: [], observations: {}, memories: [], summaries: [], ...line.data };
      const response = await (options.fetchImpl ?? fetch)(`${options.base}/agentmemory/import`, {
        method: "POST",
        headers: { ...headersFor(options.secret), "Content-Type": "application/json" },
        body: JSON.stringify({ exportData, strategy }),
        signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || result?.success !== true) {
        throw new Error(`import stopped at part ${line.seq} of ${end.parts}: HTTP ${response.status} ${JSON.stringify(result)?.slice(0, 300)}; parts before it are imported, and re-running with merge is safe`);
      }
      posted++;
      addRows(rows, rowsOf(line.data));
      for (const key of ["sessions", "observations", "memories", "summaries", "skipped"]) {
        if (typeof result[key] === "number") stats[key] = (stats[key] ?? 0) + (result[key] as number);
      }
    }
    if (posted !== end.parts) throw new Error(`import stopped at part ${posted} of ${end.parts}; the file changed since verify`);
    log(`Imported ${posted} parts from ${file} (${strategy}): ${formatRows(rows)}`);
    log(`Server counts: ${formatRows(stats)}`);
    return 0;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EXPORT_STREAM_FORMAT, type ExportStreamLine } from "./export-stream.js";

interface CommandOptions {
  base: string;
  args: string[];
  secret?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
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

async function* readLines(path: string): AsyncGenerator<ExportStreamLine> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  for await (const raw of lines) {
    n++;
    if (raw.length === 0) continue;
    try {
      yield JSON.parse(raw) as ExportStreamLine;
    } catch {
      throw new Error(`line ${n} is not valid JSON; the file is truncated or corrupt`);
    }
  }
}

/** Reads the whole file once, one line at a time, and checks it is a complete stream export. */
export async function verifyExportFile(path: string): Promise<{ header: Header; end: End }> {
  let header: Header | undefined;
  let end: End | undefined;
  let seq = 0;
  const rows: Record<string, number> = {};
  for await (const line of readLines(path)) {
    if (end) throw new Error("data after the end line");
    if (!header) {
      if (line.t !== "header" || line.format !== EXPORT_STREAM_FORMAT) throw new Error("not an agentmemory stream export (no header line)");
      header = line;
      continue;
    }
    if (line.t === "error") throw new Error(`the server failed during export: ${line.message}`);
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
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.base}/agentmemory/export/stream`, {
      headers: headersFor(options.secret),
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      const hint = response.status === 404 ? " (the server does not support streamed export; upgrade it)" : "";
      throw new Error(`export failed: HTTP ${response.status}${hint} ${text.slice(0, 300)}`);
    }
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(partial, { mode: 0o600 }));
    const { end } = await verifyExportFile(partial);
    await rename(partial, file);
    log(`Exported ${end.parts} parts to ${file}: ${formatRows(end.rows)}`);
    return 0;
  } catch (error) {
    await rm(partial, { force: true });
    log(error instanceof Error ? error.message : String(error));
    return 1;
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
    for await (const line of readLines(file)) {
      if (line.t !== "part") continue;
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
      for (const key of ["sessions", "observations", "memories", "summaries", "skipped"]) {
        if (typeof result[key] === "number") stats[key] = (stats[key] ?? 0) + (result[key] as number);
      }
    }
    log(`Imported ${end.parts} parts from ${file} (${strategy}): ${formatRows(end.rows)}`);
    log(`Server counts: ${formatRows(stats)}`);
    return 0;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

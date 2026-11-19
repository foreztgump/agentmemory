import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { IIIClient } from "iii-sdk";
import { StateKV, type StateKVOptions } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { SCOPE_CLASS, type ScopeClass } from "./kv/scope-classes.js";
import { getEnvVar } from "../config.js";
import { logger } from "../logger.js";

export type ScopeGuardMode = "off" | "warn" | "throw";
export type WholeReadOp = "list" | "listKeys" | "iterate" | "listPage";

export interface WholeReadRecord {
  collection: string;
  op: WholeReadOp;
  site: string;
  calls: number;
  items: number;
  bytes: number;
  maxItems: number;
  maxBytes: number;
  firstAt: string;
  lastAt: string;
}

export interface WholeReadInventory {
  v: 1;
  startedAt: string;
  restarts?: number;
  writtenAt: string;
  reads: WholeReadRecord[];
}

const INVENTORY_FILE = "scope-guard-inventory.json";
const DUMP_INTERVAL_MS = 30_000;
const WARN_INTERVAL_MS = 60_000;
const SENTINEL = "\u0000";

export function getScopeGuardMode(): ScopeGuardMode {
  const raw = (getEnvVar("AGENTMEMORY_SCOPE_GUARD") ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return "off";
  if (raw === "warn") return "warn";
  if (raw === "throw" || raw === "refuse") return "throw";
  throw new Error(`AGENTMEMORY_SCOPE_GUARD must be off, warn or throw, got "${raw}"`);
}

export class ScopeTooLargeError extends Error {
  constructor(
    readonly scope: string,
    readonly op: WholeReadOp,
    readonly scopeClass: ScopeClass,
  ) {
    const instead =
      scopeClass === "point-read-only"
        ? "read it by key with get or getMany"
        : "use iterate, collectAll, listPage or getMany";
    super(
      `scope-guard: ${op} of ${scope} (${scopeClass}) reads a collection that grows with data in one call; ${instead}`,
    );
    this.name = "ScopeTooLargeError";
  }
}

type KvName = keyof typeof KV;

const kvEntries = Object.entries(KV) as Array<[KvName, unknown]>;

const dynamicScopes = kvEntries
  .filter((entry): entry is [KvName, (...args: string[]) => string] => typeof entry[1] === "function")
  .map(([name, template]) => {
    const sample = template(SENTINEL, SENTINEL);
    const parts = sample.split(SENTINEL).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return { name, pattern: new RegExp(`^${parts.join("[^:]+")}$`) };
  });

const staticScopes = new Map<string, KvName>(
  kvEntries.flatMap(([name, value]) => (typeof value === "string" ? [[value, name] as [string, KvName]] : [])),
);

function kvNameOf(scope: string): KvName | undefined {
  return staticScopes.get(scope) ?? dynamicScopes.find(({ pattern }) => pattern.test(scope))?.name;
}

export function scopeClassOf(scope: string): ScopeClass | undefined {
  const name = kvNameOf(scope);
  return name === undefined ? undefined : SCOPE_CLASS[name];
}

const PAGED_OPS: ReadonlySet<WholeReadOp> = new Set(["iterate", "listPage", "listKeys"]);

export function assertWholeReadAllowed(scope: string, op: WholeReadOp): void {
  const scopeClass = scopeClassOf(scope);
  if (scopeClass === undefined || scopeClass === "bounded") return;
  if (scopeClass === "paged-only" && PAGED_OPS.has(op)) return;
  throw new ScopeTooLargeError(scope, op, scopeClass);
}

export function normalizeScope(scope: string): string {
  if (staticScopes.has(scope)) return scope;
  for (const { pattern } of dynamicScopes) {
    if (pattern.test(scope)) {
      return pattern.source.slice(1, -1).replaceAll("[^:]+", "*").replace(/\\(.)/g, "$1");
    }
  }
  return scope
    .split(":")
    .map((segment) => (/^\d[\d-]*$/.test(segment) || (/\d/.test(segment) && segment.length >= 8) ? "*" : segment))
    .join(":");
}

function itemBytes(values: unknown[]): number {
  let total = 0;
  for (const value of values) total += safeBytes(value);
  return total;
}

function arrayBytes(items: number, itemTotal: number): number {
  return items === 0 ? 2 : itemTotal + items + 1;
}

function safeBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null");
  } catch {
    return 0;
  }
}

function jsonBytes(values: unknown[]): number {
  return arrayBytes(values.length, itemBytes(values));
}

function callerFrame(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  for (const line of lines) {
    if (/callerFrame|StateKV\.|collectAll|node:|node_modules/.test(line)) continue;
    const match = line.match(/at (?:async )?(?:(\S+) \()?(.+?):(\d+):\d+\)?\s*$/);
    if (match) return `${match[1] ? `${match[1]} ` : ""}${basename(match[2]!)}:${match[3]}`;
  }
  return "unknown";
}

const recordKey = (collection: string, op: string, site: string) => `${collection}\u0000${op}\u0000${site}`;

export class ScopeReadInventory {
  private readonly records = new Map<string, WholeReadRecord>();
  private readonly lastWarn = new Map<string, number>();
  readonly startedAt: string;
  readonly restarts: number;

  constructor(previous?: WholeReadInventory) {
    this.startedAt = previous?.startedAt ?? new Date().toISOString();
    this.restarts = previous ? (previous.restarts ?? 0) + 1 : 0;
    for (const read of previous?.reads ?? []) {
      if (typeof read?.collection !== "string" || typeof read.op !== "string" || typeof read.site !== "string") continue;
      if (![read.calls, read.items, read.bytes, read.maxItems, read.maxBytes].every(Number.isFinite)) continue;
      this.records.set(recordKey(read.collection, read.op, read.site), { ...read });
    }
  }

  record(collection: string, op: WholeReadOp, site: string, items: number, bytes: number): void {
    const now = new Date().toISOString();
    const key = recordKey(collection, op, site);
    const existing = this.records.get(key);
    if (existing) {
      existing.calls++;
      existing.items += items;
      existing.bytes += bytes;
      existing.maxItems = Math.max(existing.maxItems, items);
      existing.maxBytes = Math.max(existing.maxBytes, bytes);
      existing.lastAt = now;
    } else {
      this.records.set(key, {
        collection, op, site, calls: 1, items, bytes,
        maxItems: items, maxBytes: bytes, firstAt: now, lastAt: now,
      });
    }
    const nowMs = Date.now();
    if (nowMs - (this.lastWarn.get(key) ?? 0) >= WARN_INTERVAL_MS) {
      this.lastWarn.set(key, nowMs);
      logger.warn("scope-guard: whole-collection read", { collection, op, site, items, bytes });
    }
  }

  snapshot(): WholeReadInventory {
    const reads = [...this.records.values()]
      .map((record) => ({ ...record }))
      .sort((a, b) => b.maxBytes - a.maxBytes || b.calls - a.calls);
    return { v: 1, startedAt: this.startedAt, restarts: this.restarts, writtenAt: new Date().toISOString(), reads };
  }

  writeTo(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
    renameSync(tmp, file);
  }
}

type InvocationAware = { currentInvocation?: () => { function_id?: string } | undefined };

// TEE-1157 SCOPE_CLASS replaces this: warn mode treats every scope as growing with data.
const everyScopeGrows = (_collection: string) => true;

export class GuardedStateKV extends StateKV {
  constructor(
    private readonly client: IIIClient,
    options: StateKVOptions,
    readonly inventory: ScopeReadInventory,
    private readonly isGrowing: (collection: string) => boolean = everyScopeGrows,
    private readonly refuse = false,
  ) {
    super(client, options);
  }

  private site(): string {
    let functionId: string | undefined;
    try {
      functionId = (this.client as unknown as InvocationAware).currentInvocation?.()?.function_id;
    } catch {}
    return `${functionId ?? "-"} ${callerFrame()}`;
  }

  private note(scope: string, op: WholeReadOp, site: string, items: number, bytes: number): void {
    const collection = normalizeScope(scope);
    if (this.isGrowing(collection)) this.inventory.record(collection, op, site, items, bytes);
  }

  private guard(scope: string, op: WholeReadOp): void {
    if (this.refuse) assertWholeReadAllowed(scope, op);
  }

  override async list<T = unknown>(scope: string): Promise<T[]> {
    this.guard(scope, "list");
    const site = this.site();
    const values = await super.list<T>(scope);
    if (Array.isArray(values)) this.note(scope, "list", site, values.length, jsonBytes(values));
    else this.note(scope, "list", site, 0, safeBytes(values));
    return values;
  }

  override async listKeys(scope: string): Promise<string[]> {
    this.guard(scope, "listKeys");
    const site = this.site();
    const keys = await super.listKeys(scope);
    this.note(scope, "listKeys", site, keys.length, jsonBytes(keys));
    return keys;
  }

  override async listPage<T = unknown>(
    scope: string,
    opts: { limit: number; cursor?: string; order?: "desc" | "asc" },
  ): Promise<{ items: T[]; nextCursor?: string; total: number }> {
    this.guard(scope, "listPage");
    const site = this.site();
    const page = await super.listPage<T>(scope, opts);
    this.note(scope, "listPage", site, page.total, jsonBytes(page.items));
    return page;
  }

  override async *iterate<T = unknown>(
    scope: string,
    opts: { pageSize?: number } = {},
  ): AsyncGenerator<T[]> {
    this.guard(scope, "iterate");
    const site = this.site();
    let items = 0;
    let itemTotal = 0;
    try {
      for await (const page of super.iterate<T>(scope, opts)) {
        items += page.length;
        itemTotal += itemBytes(page);
        yield page;
      }
    } finally {
      this.note(scope, "iterate", site, items, arrayBytes(items, itemTotal));
    }
  }
}

export function readInventory(file: string): WholeReadInventory | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as WholeReadInventory;
    return parsed?.v === 1 && typeof parsed.startedAt === "string" && Array.isArray(parsed.reads) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function withScopeGuard(kv: StateKV, sdk: IIIClient, dataDir: string): StateKV {
  const mode = getScopeGuardMode();
  if (mode === "off") return kv;
  const file = join(dataDir, INVENTORY_FILE);
  const inventory = new ScopeReadInventory(readInventory(file));
  const dump = () => {
    try {
      inventory.writeTo(file);
    } catch (error) {
      logger.warn("scope-guard: inventory write failed", { file, error: String(error) });
    }
  };
  setInterval(dump, DUMP_INTERVAL_MS).unref();
  process.once("beforeExit", dump);
  logger.warn(
    mode === "throw"
      ? "scope-guard: throw mode on, refusing whole reads of growing collections (refused reads are not recorded)"
      : "scope-guard: warn mode on, recording whole-collection reads",
    { file },
  );
  return new GuardedStateKV(sdk, { backend: kv.backend }, inventory, undefined, mode === "throw");
}

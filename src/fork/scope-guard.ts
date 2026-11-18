import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { IIIClient } from "iii-sdk";
import { StateKV, type StateKVOptions } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { getEnvVar } from "../config.js";
import { logger } from "../logger.js";

export type ScopeGuardMode = "off" | "warn";
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
  throw new Error(`AGENTMEMORY_SCOPE_GUARD must be off or warn, got "${raw}"`);
}

const dynamicScopes: RegExp[] = Object.values(KV)
  .filter((value): value is (...args: string[]) => string => typeof value === "function")
  .map((template) => {
    const sample = template(SENTINEL, SENTINEL);
    const parts = sample.split(SENTINEL).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${parts.join("[^:]+")}$`);
  });

const staticScopes = new Set(Object.values(KV).filter((value): value is string => typeof value === "string"));

export function normalizeScope(scope: string): string {
  if (staticScopes.has(scope)) return scope;
  for (const pattern of dynamicScopes) {
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
  for (const value of values) total += Buffer.byteLength(JSON.stringify(value) ?? "null");
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

export class ScopeReadInventory {
  private readonly records = new Map<string, WholeReadRecord>();
  private readonly lastWarn = new Map<string, number>();
  readonly startedAt = new Date().toISOString();

  record(collection: string, op: WholeReadOp, site: string, items: number, bytes: number): void {
    const now = new Date().toISOString();
    const key = `${collection}\u0000${op}\u0000${site}`;
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
    return { v: 1, startedAt: this.startedAt, writtenAt: new Date().toISOString(), reads };
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

  override async list<T = unknown>(scope: string): Promise<T[]> {
    const site = this.site();
    const values = await super.list<T>(scope);
    if (Array.isArray(values)) this.note(scope, "list", site, values.length, jsonBytes(values));
    else this.note(scope, "list", site, 0, safeBytes(values));
    return values;
  }

  override async listKeys(scope: string): Promise<string[]> {
    const site = this.site();
    const keys = await super.listKeys(scope);
    this.note(scope, "listKeys", site, keys.length, jsonBytes(keys));
    return keys;
  }

  override async listPage<T = unknown>(
    scope: string,
    opts: { limit: number; cursor?: string; order?: "desc" | "asc" },
  ): Promise<{ items: T[]; nextCursor?: string; total: number }> {
    const site = this.site();
    const page = await super.listPage<T>(scope, opts);
    this.note(scope, "listPage", site, page.total, jsonBytes(page.items));
    return page;
  }

  override async *iterate<T = unknown>(
    scope: string,
    opts: { pageSize?: number } = {},
  ): AsyncGenerator<T[]> {
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

export function withScopeGuard(kv: StateKV, sdk: IIIClient, dataDir: string): StateKV {
  if (getScopeGuardMode() === "off") return kv;
  const inventory = new ScopeReadInventory();
  const file = join(dataDir, INVENTORY_FILE);
  const dump = () => {
    try {
      inventory.writeTo(file);
    } catch (error) {
      logger.warn("scope-guard: inventory write failed", { file, error: String(error) });
    }
  };
  setInterval(dump, DUMP_INTERVAL_MS).unref();
  process.once("beforeExit", dump);
  logger.warn("scope-guard: warn mode on, recording whole-collection reads", { file });
  return new GuardedStateKV(sdk, { backend: kv.backend }, inventory);
}

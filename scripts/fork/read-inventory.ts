// Turns scope-guard inventory snapshots from a replay run into the read-inventory
// tables: one row per (collection, call site), with calls and bytes per day.
//
// Usage:
//   npx tsx scripts/fork/read-inventory.ts --map <image dist/index.mjs.map> \
//     --boot s0.json --day s1.json [--extra s2.json] [--timer-scale N] [--json]
//
// --boot is the snapshot taken once the replica was ready, --day the one taken
// when the replay day ended, --extra the one taken after the one-off feature calls.
// The day window is day minus boot. The replay driver plays a whole day, so rows it
// causes count once. Rows from server timers ran in real time, so they are scaled
// by 1440 / (window minutes) unless --timer-scale is given. Each bundle line in a
// call site is resolved to its source file and line through the image's source map.

import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { KV } from "../../src/state/schema.js";
import { SCOPE_CLASS } from "../../src/fork/kv/scope-classes.js";
import type { WholeReadInventory } from "../../src/fork/scope-guard.js";

const { values: args } = parseArgs({
  options: {
    map: { type: "string" },
    boot: { type: "string" },
    day: { type: "string" },
    extra: { type: "string" },
    "timer-scale": { type: "string" },
    json: { type: "boolean", default: false },
  },
});
if (!args.map || !args.boot || !args.day) {
  console.error("usage: read-inventory.ts --map <index.mjs.map> --boot <s0.json> --day <s1.json> [--extra <s2.json>] [--timer-scale N] [--json]");
  process.exit(2);
}

// Functions whose reads follow the replay driver's calls: the ones it calls, the events
// those calls fire, and mem::summary-repair, which the 30 s recovery timer runs once
// per pending summary the driver's sessions leave, so its count tracks sessions.
const DRIVEN = new Set([
  "api::observe", "mem::observe", "api::context", "mem::context", "api::search", "mem::search",
  "api::smart-search", "mem::smart-search", "api::session::start", "api::session::end", "mem::summarize",
  "api::summarize", "mem::auto-forget", "api::auto-forget", "mem::consolidate-pipeline",
  "api::consolidate-pipeline", "mem::session-sweep", "mem::diagnostic::recent-searches-sweep",
  "mem::lesson-decay-sweep", "mem::insight-decay-sweep", "mem::audit-retention-sweep", "mem::capture",
  "event::session::stopped", "mem::summary-repair", "mem::slot-reflect", "mem::graph-extract",
  "mem::auto-crystallize", "mem::skill-extract",
]);

// mem:obs:<session> is bounded per session; these sites read every session (or many) per call.
// Lines are in the source the --map was built from (d148219 for the 2026-11-18 run).
const WALKS_SESSIONS = new Set([
  "src/functions/search.ts:438", "src/functions/search.ts:641", "src/functions/auto-forget.ts:163",
  "src/functions/context.ts:231", "src/functions/consolidate.ts:102", "src/state/graph-generation.ts:102",
  "src/functions/profile.ts:60", "src/fork/kv/observation-stats.ts:90",
]);

const OWNERS: Record<string, string> = {
  "auto-forget.ts": "retention (auto-forget)", "context.ts": "context injection", "summarize.ts": "summaries",
  "summary-recovery.ts": "summaries", "events.ts": "summaries", "lessons.ts": "lessons", "reflect.ts": "reflect",
  "viewer-counts.ts": "viewer", "api.ts": "viewer / REST lists", "graph-generation.ts": "export",
  "diagnostics.ts": "diagnostics", "facets.ts": "diagnostics", "consolidate.ts": "consolidation",
  "profile.ts": "profile", "metrics-store.ts": "status", "session-index.ts": "sessions",
  "crystallize.ts": "crystallize", "actions.ts": "actions", "audit.ts": "audit",
  "recent-searches-sweep.ts": "search", "observation-stats.ts": "capture (one-time stats repair)",
};

function owner(source: string, fn: string): string {
  const file = basename(source.split(":")[0]!);
  if (source === "src/functions/search.ts:432" || source === "src/functions/search.ts:438") return "status / health (index reconcile)";
  if (file === "search.ts") return "search (boot index rebuild)";
  if (file === "paged-scan.ts" && fn === "-") return "capture (sweep timers)";
  if (file === "paged-scan.ts") return fn === "mem::capture" ? "capture" : "status / health";
  if (fn.startsWith("mem::diagnose") || fn.startsWith("mem::heal")) return "diagnostics";
  if (fn === "mem::export") return "export";
  return OWNERS[file] ?? "?";
}

function load(path: string): WholeReadInventory {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as WholeReadInventory;
  if (parsed?.v !== 1 || !Array.isArray(parsed.reads) || typeof parsed.writtenAt !== "string") {
    console.error(`${path} is not a v1 scope-guard inventory`);
    process.exit(2);
  }
  return parsed;
}
const sourceMap = new SourceMap(JSON.parse(readFileSync(args.map, "utf8")));

const classOf = new Map<string, string>();
const families: Array<[prefix: string, scope: string]> = [];
for (const [key, value] of Object.entries(KV)) {
  const scope = typeof value === "function" ? (value as (...a: string[]) => string)("*", "*") : value;
  classOf.set(scope, SCOPE_CLASS[key as keyof typeof SCOPE_CLASS]);
  if (typeof value === "function") families.push([scope.slice(0, scope.indexOf("*")), scope]);
}
families.sort((a, b) => b[0].length - a[0].length);

// The guard already writes ids as *; this also folds ids that contain ":" into their family.
function collapse(collection: string): string {
  if (classOf.has(collection)) return collection;
  return families.find(([prefix]) => collection.startsWith(prefix))?.[1] ?? collection;
}

function resolve(site: string): { fn: string; source: string } {
  const parts = site.split(" ");
  const location = parts.pop() ?? "";
  const fn = parts[0] ?? "-";
  const line = Number(location.split(":").pop());
  if (!Number.isFinite(line)) return { fn, source: location };
  for (let column = 0; column < 4000; column++) {
    const entry = sourceMap.findEntry(line - 1, column) as { generatedLine?: number; originalSource?: string; originalLine?: number };
    if (entry.generatedLine === line - 1 && entry.originalSource) {
      return { fn, source: `${entry.originalSource.replace(/^.*?\/src\//, "src/")}:${(entry.originalLine ?? 0) + 1}` };
    }
  }
  console.error(`warning: no source-map entry for ${location}; its owner and verdict may be wrong`);
  return { fn, source: location };
}

type Row = {
  collection: string; op: string; fn: string; source: string; scopeClass: string; owner: string; timer: boolean;
  bootCalls: number; dayCalls: number; dayBytes: number; extraCalls: number; maxItems: number; maxBytes: number;
  convert: "yes" | "on demand" | "no";
};

const boot = load(args.boot);
const day = load(args.day);
const extra = args.extra ? load(args.extra) : day;
const windowMinutes = (Date.parse(day.writtenAt) - Date.parse(boot.writtenAt)) / 60_000;
const timerScale = args["timer-scale"] ? Number(args["timer-scale"]) : 1440 / windowMinutes;
if (!(windowMinutes > 0) || !Number.isFinite(timerScale) || timerScale <= 0) {
  console.error(`unusable window (${windowMinutes} min) or --timer-scale (${args["timer-scale"]}); it must be a positive number`);
  process.exit(2);
}
const index = (inventory: WholeReadInventory) => new Map(inventory.reads.map((r) => [`${r.collection}|${r.op}|${r.site}`, r]));
const atBoot = index(boot);
const atDay = index(day);

const rows = new Map<string, Row>();
for (const [key, last] of index(extra)) {
  const b = atBoot.get(key);
  const d = atDay.get(key);
  const { fn, source } = resolve(last.site);
  const collection = collapse(last.collection);
  const rowKey = `${collection}|${last.op}|${fn}|${source}`;
  const timer = !DRIVEN.has(fn);
  const scale = timer ? timerScale : 1;
  const row = rows.get(rowKey) ?? {
    collection, op: last.op, fn, source, scopeClass: classOf.get(collection) ?? "unknown", owner: owner(source, fn), timer,
    bootCalls: 0, dayCalls: 0, dayBytes: 0, extraCalls: 0, maxItems: 0, maxBytes: 0, convert: "no" as const,
  };
  row.bootCalls += b?.calls ?? 0;
  row.dayCalls += ((d?.calls ?? 0) - (b?.calls ?? 0)) * scale;
  row.dayBytes += ((d?.bytes ?? 0) - (b?.bytes ?? 0)) * scale;
  row.extraCalls += last.calls - (d?.calls ?? 0);
  row.maxItems = Math.max(row.maxItems, last.maxItems);
  row.maxBytes = Math.max(row.maxBytes, last.maxBytes);
  rows.set(rowKey, row);
}

for (const row of rows.values()) {
  const unpaged = row.scopeClass === "point-read-only" || (row.scopeClass === "paged-only" && row.op === "list") ||
    WALKS_SESSIONS.has(row.source);
  if (!unpaged) row.convert = "no";
  else row.convert = row.dayCalls > 0 ? "yes" : "on demand";
}

const all = [...rows.values()];
if (args.json) {
  console.log(JSON.stringify({ windowMinutes, timerScale, restarts: extra.restarts ?? 0, rows: all }, null, 2));
  process.exit(0);
}

const n = (value: number) => Math.round(value).toLocaleString("en-US");
const mb = (bytes: number) => (bytes / 1e6 >= 10 ? n(bytes / 1e6) : (bytes / 1e6).toFixed(2));
const growth = (row: Row) => (row.scopeClass === "bounded" ? "bounded" : `growing (${row.scopeClass})`);
const site = (row: Row) => `\`${row.fn}\` ${row.source}`;

function table(title: string, header: string, list: Row[], cells: (row: Row, index: number) => string[]) {
  console.log(`\n### ${title}\n\n${header}\n${header.replace(/[^|]+/g, "---")}`);
  list.forEach((row, index) => console.log(`| ${cells(row, index).join(" | ")} |`));
}

console.log(`Window ${windowMinutes.toFixed(1)} min; timer rows scaled x${timerScale.toFixed(2)}; restarts ${extra.restarts ?? 0}.`);
table(
  "Recurring reads per day",
  "| # | Collection | Op | Call site | Owner | Scope | Calls/day | Max items | Max reply MB | MB/day | Scaled | TEE-1160 |",
  all.filter((r) => r.dayCalls > 0).sort((a, b) => b.dayBytes - a.dayBytes || b.maxBytes - a.maxBytes),
  (r, i) => [String(i + 1), r.collection, r.op, site(r), r.owner, growth(r), n(r.dayCalls), n(r.maxItems), mb(r.maxBytes), mb(r.dayBytes), r.timer ? "timer" : "x1", r.convert],
);
table(
  "Boot reads (once per start)",
  "| Collection | Op | Call site | Owner | Scope | Calls | Max items | Max reply MB |",
  all.filter((r) => r.bootCalls > 0).sort((a, b) => b.maxBytes * b.bootCalls - a.maxBytes * a.bootCalls),
  (r) => [r.collection, r.op, site(r), r.owner, growth(r), n(r.bootCalls), n(r.maxItems), mb(r.maxBytes)],
);
table(
  "On-demand reads (one call to each feature)",
  "| Collection | Op | Call site | Owner | Scope | Calls | Max items | Max reply MB | TEE-1160 |",
  all.filter((r) => r.extraCalls > 0 && r.dayCalls === 0 && r.fn !== "-" && !r.fn.startsWith("event::")).sort((a, b) => b.maxBytes - a.maxBytes),
  (r) => [r.collection, r.op, site(r), r.owner, growth(r), n(r.extraCalls), n(r.maxItems), mb(r.maxBytes), r.convert],
);

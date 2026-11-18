import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_SITES,
  allowedReason,
  findListSites,
  rewriteFile,
  scannedFiles,
  unpagedSites,
} from "../scripts/fork/page-list-sites.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { SUMMARY_RETRY_MS, registerSummaryRecoveryFunction } from "../src/functions/summary-recovery.js";
import type { SessionSummaryRepair } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const KV_MODULE = join(import.meta.dirname, "..", "src", "state", "kv.js");

function fixture(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "am-list-sites-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, source.replaceAll("<kv>", relative(dir, KV_MODULE)));
  return file;
}

describe("whole-scope lists in src/", () => {
  it("has no unpaged list of a paged-only or point-read-only scope outside the allowlist", () => {
    const found = unpagedSites().map((s) => `${s.file}:${s.line} ${s.receiver}.list${s.typeArgs}(${s.scope}) [${s.kind}]`);
    expect(found).toEqual([]);
  });

  it("keeps every allowlist entry live and explained", () => {
    const sites = findListSites(scannedFiles());
    for (const entry of ALLOWED_SITES) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(sites.some((s) => allowedReason(s) === entry.reason && s.scope === entry.scope)).toBe(true);
    }
  });
});

describe("page-list-sites finder and rewrite", () => {
  const source = [
    'import type { StateKV } from "<kv>";',
    'import { KV } from "./schema.js";',
    "export async function run(kv: StateKV, owner: { kv: StateKV }, id: string, scope: string) {",
    "  const a = await kv.list<Session>(KV.sessions);",
    "  const b = await owner.kv.list(KV.auditMonth(id)).catch(() => []);",
    '  const c = await kv.list<Memory>("mem:memories");',
    "  const d = await kv.list<Obs>(KV.observations(id));",
    "  const e = await kv.list<unknown>(scope);",
    "  const f = await kv.list(KV.config, 1);",
    "  return [a, b, c, d, e, f];",
    "}",
    "",
  ].join("\n");

  it("classifies a KV property, a KV call and a literal scope, and leaves the rest", () => {
    const file = fixture(source);
    expect(findListSites([file]).map((s) => [s.scope, s.kind])).toEqual([
      ["KV.sessions", "paged-only"],
      ["KV.auditMonth(id)", "paged-only"],
      ['"mem:memories"', "paged-only"],
      ["KV.observations(id)", "bounded"],
      ["scope", "unclassified"],
    ]);
  });

  it("rewrites growing sites to collectAll, keeps type arguments and chains, and adds the import once", () => {
    const file = fixture(source);
    expect(rewriteFile(file)).toBe(3);
    const out = readFileSync(file, "utf-8");
    expect(out).toContain("collectAll<Session>(kv, KV.sessions)");
    expect(out).toContain("collectAll(owner.kv, KV.auditMonth(id)).catch(() => [])");
    expect(out).toContain('collectAll<Memory>(kv, "mem:memories")');
    expect(out).toContain("kv.list<Obs>(KV.observations(id))");
    expect(out).toContain("kv.list<unknown>(scope)");
    expect(out.match(/import \{ collectAll \}/g)).toHaveLength(1);
    expect(rewriteFile(file)).toBe(0);
  });

  it("adds collectAll to an existing value import of the kv module", () => {
    const file = fixture('import { StateKV } from "<kv>";\nimport { KV } from "x";\nexport const f = (kv: StateKV) => kv.list(KV.sessions);\n');
    expect(rewriteFile(file)).toBe(1);
    expect(readFileSync(file, "utf-8")).toContain(`import { StateKV, collectAll } from "${relative(join(file, ".."), KV_MODULE)}";`);
  });
});

type Req = { function_id: string; payload: { scope: string; key: string; value?: unknown }; action?: unknown };

describe("summary recovery reads the repair scope by page", () => {
  function rig(repairs: SessionSummaryRepair[]) {
    const rows = new Map(repairs.map((r) => [r.sessionId, r]));
    const calls: string[] = [];
    const scheduled: string[] = [];
    const state = {
      trigger: async (req: Req) => {
        calls.push(req.function_id);
        const p = req.payload;
        switch (req.function_id) {
          case "state::get": return structuredClone(rows.get(p.key) ?? null);
          case "state::list_keys": return { keys: p.scope === KV.summaryRepairs ? [...rows.keys()] : [] };
          case "state::list": throw new Error("whole-scope list");
        }
        return null;
      },
    };
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: (id: string, fn: (input: unknown) => Promise<unknown>) => handlers.set(id, fn),
      trigger: async (req: { function_id: string; payload: SessionSummaryRepair }) => {
        scheduled.push(req.payload.sessionId);
      },
    };
    registerSummaryRecoveryFunction(sdk as never, new StateKV(state as never, { backend: "redis" }), () => true);
    const recover = (now: number) => handlers.get("mem::summary-recover")!({ now }) as Promise<{ scheduled: number }>;
    return { recover, calls, scheduled };
  }

  const repair = (sessionId: string, dueAt: number): SessionSummaryRepair =>
    ({ sessionId, token: `t_${sessionId}`, dueAt, attempts: 0, lastError: "pending" }) as SessionSummaryRepair;

  it("schedules the due repairs, earliest first, without a whole-scope list", async () => {
    const now = 1_000_000;
    const { recover, scheduled, calls } = rig([repair("late", now - 10), repair("future", now + SUMMARY_RETRY_MS), repair("early", now - 500)]);
    expect(await recover(now)).toEqual({ scheduled: 2 });
    expect(scheduled).toEqual(["early", "late"]);
    expect(calls).not.toContain("state::list");
  });

  it("reads only the key listing when no repair is pending", async () => {
    const { recover, calls } = rig([]);
    expect(await recover(1_000_000)).toEqual({ scheduled: 0 });
    expect(calls).toEqual(["state::list_keys"]);
  });
});

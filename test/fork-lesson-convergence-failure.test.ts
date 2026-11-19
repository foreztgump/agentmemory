// TEE-1167: in disk mode a replay or an import converges the lessons collection
// after the lesson rows are committed to KV. A failed convergence must not fail
// the caller: KV is the authority and convergence is idempotent.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KV } from "../src/state/schema.js";
import { VERSION } from "../src/version.js";
import type { ExportData } from "../src/types.js";
import type { resetLessonIndex } from "../src/functions/lessons.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../src/logger.js", () => ({ logger }));

async function diskModeStack() {
  vi.resetModules();
  const ports = await import("../src/state/search-ports.js");
  const { registerLessonsFunctions } = await import("../src/functions/lessons.js");
  const { registerReplayFunctions } = await import("../src/functions/replay.js");
  const { registerExportImportFunction } = await import("../src/functions/export-import.js");
  const base = mockKV();
  const kv = { ...base, getMany: vi.fn(async () => { throw new Error("state worker unreachable"); }) };
  const runtime = ports.getSearchRuntime() as unknown as Record<string, unknown>;
  runtime.lessons = { add: vi.fn(), addIfChanged: vi.fn(), remove: vi.fn(), search: vi.fn(async () => []) };
  const sdk = mockSdk({ looseTrigger: true });
  registerLessonsFunctions(sdk as never, kv as never);
  registerReplayFunctions(sdk as never, kv as never);
  registerExportImportFunction(sdk as never, kv as never);
  return { sdk, base, kv };
}

const lesson = { id: "les_1", content: "Always pin the image digest before a deploy." };

function convergenceWarnings() {
  return logger.warn.mock.calls.filter(([message]) => /lesson index not converged/.test(String(message)));
}

describe("a failed lesson convergence in disk mode", () => {
  beforeEach(() => logger.warn.mockClear());

  let folder: string | undefined;
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = undefined;
    delete process.env.AGENTMEMORY_IMPORT_ROOT;
  });

  it("does not fail a replay, and logs a warning", async () => {
    const { sdk, base, kv } = await diskModeStack();
    folder = mkdtempSync(join(__dirname, "lesson-convergence-"));
    process.env.AGENTMEMORY_IMPORT_ROOT = folder;
    const path = join(folder, "session.jsonl");
    writeFileSync(path, JSON.stringify({
      type: "user", uuid: "entry-0", sessionId: "ses_converge", timestamp: "2026-11-19T00:00:00Z",
      message: { role: "user", content: "Always run the schema migration before you deploy the app." },
    }));

    const result = await sdk.trigger("mem::replay::import-jsonl", { path });

    expect(result).toMatchObject({ success: true, observations: 1 });
    expect(await base.list(KV.lessons)).toHaveLength(1);
    expect(kv.getMany).toHaveBeenCalled();
    expect(convergenceWarnings()).toHaveLength(1);
  });

  it.each(["merge", "replace"] as const)("does not fail a %s import, and logs a warning", async (strategy) => {
    const { sdk, base, kv } = await diskModeStack();
    await base.set(KV.lessons, "les_old", { id: "les_old", content: "Never skip the review." });
    const exportData = {
      version: VERSION, exportedAt: new Date().toISOString(),
      sessions: [], observations: {}, memories: [], summaries: [], lessons: [lesson],
    } as unknown as ExportData;

    const result = await sdk.trigger("mem::import", { exportData, strategy });

    expect(result).toMatchObject({ success: true });
    expect(await base.get(KV.lessons, lesson.id)).toEqual(lesson);
    expect(kv.getMany).toHaveBeenCalled();
    expect(convergenceWarnings().length).toBeGreaterThanOrEqual(1);
  });
});

describe("resetLessonIndex", () => {
  it("requires the changed ids, so no caller can skip disk-mode convergence", () => {
    expectTypeOf<Parameters<typeof resetLessonIndex>>().toEqualTypeOf<[readonly string[]]>();
  });
});

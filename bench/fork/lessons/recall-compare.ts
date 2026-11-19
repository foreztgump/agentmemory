// TEE-1167 AC1: lesson recall on the disk backend against the memory backend.
// Loads a replica's lessons (a private JSON array, outside the repo) into KV,
// indexes them for disk mode through resetLessonIndex(ids), the path import
// takes, and runs mem::lesson-recall for every case in --cases (built by
// collection-choice.ts) three ways: defaults, a project filter and
// minConfidence 0.5. Prints agreement counts only, no content.
//
//   node --import tsx bench/fork/lessons/recall-compare.ts --lessons /home/cownose/am-staging/eval-private/lessons-buddy-records.json \
//     --cases /home/cownose/am-staging/eval-private/lessons-buddy.json [--qdrant http://127.0.0.1:16341]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import "../../../src/fork/search/runtime.js";
import { collectionName } from "../../../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../../../src/fork/search/settings.js";
import { SearchEngine } from "../../../src/fork/worker/engine.js";
import { ImageEngine } from "../../../src/fork/worker/image-engine.js";
import { Qdrant } from "../../../src/fork/worker/qdrant.js";
import { registerLessonsFunctions, resetLessonIndex } from "../../../src/functions/lessons.js";
import { StateKV } from "../../../src/state/kv.js";
import { createSearchRuntime } from "../../../src/state/search-ports.js";
import type { Lesson } from "../../../src/types.js";
import { stateSdk, workerSdk } from "../lib/state-sdk.js";
import type { LessonCase } from "./lib.js";

const { values: args } = parseArgs({
  options: {
    lessons: { type: "string" },
    cases: { type: "string" },
    qdrant: { type: "string", default: "http://127.0.0.1:16341" },
    "qdrant-key": { type: "string" },
  },
});
if (!args.lessons || !args.cases) throw new Error("--lessons and --cases are required");
const lessons = JSON.parse(readFileSync(args.lessons, "utf8")) as Lesson[];
const cases = (JSON.parse(readFileSync(args.cases, "utf8")) as { cases: LessonCase[] }).cases;

const projectCounts = new Map<string, number>();
for (const l of lessons) if (l.project && !l.deleted) projectCounts.set(l.project, (projectCounts.get(l.project) ?? 0) + 1);
const project = [...projectCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
const variants: Array<{ name: string; extra: Record<string, unknown> }> = [
  { name: "default", extra: {} },
  ...(project ? [{ name: "project", extra: { project } }] : []),
  { name: "minConfidence0.5", extra: { minConfidence: 0.5 } },
];

const sdk = stateSdk();
const kv = new StateKV(sdk as never, { backend: "file" });
for (const l of lessons) await kv.set("mem:lessons", l.id, l);
registerLessonsFunctions(sdk as never, kv);

type Recall = { success: boolean; error?: string; lessons: Array<{ id: string; score: number }> };
async function runAll(): Promise<Recall[]> {
  const out: Recall[] = [];
  for (const c of cases) for (const v of variants) out.push((await sdk.trigger({ function_id: "mem::lesson-recall", payload: { query: c.query, ...v.extra } })) as Recall);
  return out;
}

createSearchRuntime({ kv, embeddingProvider: null }, "memory");
const memory = await runAll();

const base = `tee1167_recall_${process.pid}`;
const qdrantOf = (id: "docs" | "lessons" | "images") =>
  new Qdrant({ url: args.qdrant!, apiKey: args["qdrant-key"], collection: collectionName(base, id), dimensions: id === "images" ? 512 : 16, oversampling: 6, timeoutMs: 60_000, ...(id === "images" ? { layout: "image" as const } : {}) });
const qdrants = { docs: qdrantOf("docs"), lessons: qdrantOf("lessons"), images: qdrantOf("images") };
try {
  const lessonsEngine = new SearchEngine(qdrants.lessons, DEFAULT_AVGDL);
  const runtime = createSearchRuntime(
    { kv, embeddingProvider: null, sdk: workerSdk({ docs: new SearchEngine(qdrants.docs, DEFAULT_AVGDL), lessons: lessonsEngine, images: new ImageEngine(qdrants.images) }) as never },
    "disk",
  );
  await resetLessonIndex(lessons.map((l) => l.id));
  await runtime.openPersistence().save();
  await lessonsEngine.settled();
  const disk = await runAll();
  (runtime as unknown as { stats?: { stop(): void } }).stats?.stop();

  const byVariant: Record<string, { cases: number; identicalTop10: number; identicalTop3: number; sameTop1: number; nonEmpty: number }> = {};
  let i = 0;
  let maxScoreDelta = 0;
  for (const c of cases) {
    for (const v of variants) {
      const want = memory[i]!;
      const got = disk[i++]!;
      if (!got.success) throw new Error(`disk recall failed for ${c.id}: ${got.error}`);
      const t = (byVariant[v.name] ??= { cases: 0, identicalTop10: 0, identicalTop3: 0, sameTop1: 0, nonEmpty: 0 });
      const w = want.lessons.map((l) => l.id);
      const g = got.lessons.map((l) => l.id);
      t.cases++;
      if (w.length > 0) t.nonEmpty++;
      if (w.join() === g.join()) t.identicalTop10++;
      if (w.slice(0, 3).join() === g.slice(0, 3).join()) t.identicalTop3++;
      if (w[0] === g[0]) t.sameTop1++;
      got.lessons.forEach((l, j) => { if (want.lessons[j]?.id === l.id) maxScoreDelta = Math.max(maxScoreDelta, Math.abs(l.score - want.lessons[j]!.score)); });
    }
  }
  console.log(JSON.stringify({ lessons: lessons.length, liveLessons: lessons.filter((l) => !l.deleted).length, cases: cases.length, byKind: Object.fromEntries(["rare", "topic"].map((k) => [k, cases.filter((c) => c.kind === k).length])), byVariant, maxScoreDeltaOnSameIds: maxScoreDelta }, null, 1));
} finally {
  await Promise.all(Object.values(qdrants).map((q) => q.drop()));
}

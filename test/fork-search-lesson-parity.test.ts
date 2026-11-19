// TEE-1167: the lessons collection ranks exactly as the in-process lesson index
// (SearchIndex), prefix expansion included, so lesson recall in disk mode returns
// the same top results as memory mode. Live Qdrant only:
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run test/fork-search-lesson-parity.test.ts
import { afterAll, describe, expect, it, vi } from "vitest";
import { contentRev, type DocOp, type Op } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { lessonToObservation } from "../src/state/memory-utils.js";
import { SearchIndex } from "../src/state/search-index.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import type { Lesson } from "../src/types.js";
import { mulberry32 } from "../bench/fork/lib/stats.js";
import { DIMS, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Word families whose stems are prefixes of each other, as real lesson text has.
const FAMILIES = [
  ["config", "configure", "configuration", "configs", "configured"],
  ["deploy", "deployment", "deployments", "deployed", "deployer"],
  ["test", "tests", "testing", "tested", "testable"],
  ["migrate", "migration", "migrations", "migrated"],
  ["cache", "cached", "caching", "caches"],
  ["index", "indexes", "indexing", "indexed", "indexer"],
  ["run", "runner", "running", "runtime", "runs"],
  ["port", "ports", "portable", "porting"],
  ["log", "logs", "logger", "logging", "login"],
  ["build", "builds", "builder", "building"],
  ["docker", "dockerfile", "dockerized"],
  ["auth", "author", "authority", "authentication", "authorize"],
  ["sync", "synced", "syncing", "synchronous"],
  ["queue", "queued", "queues", "queueing"],
  ["schema", "schemas", "schematic"],
  ["retry", "retries", "retried"],
  ["timeout", "timeouts", "time", "timer", "timestamp"],
  ["vector", "vectors", "vectorize"],
  ["lesson", "lessons"],
  ["worker", "workers", "work", "working", "workspace"],
];
const WORDS = FAMILIES.flat();
const PROMPTS = ["config", "deploy", "test", "migr", "cach", "index", "run", "port", "log", "build", "docker", "auth", "sync", "queu", "schema", "retr", "time", "vector", "lesson", "work"];

function lessons(count: number, rand: () => number): Lesson[] {
  const pick = () => WORDS[Math.floor(rand() ** 1.6 * WORDS.length)]!;
  const sentence = (n: number) => Array.from({ length: n }, pick).join(" ");
  return Array.from({ length: count }, (_, i) => ({
    id: `lsn_${String(i).padStart(4, "0")}`,
    content: sentence(6 + Math.floor(rand() * 18)),
    context: rand() < 0.6 ? sentence(3 + Math.floor(rand() * 8)) : "",
    confidence: 0.5,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    tags: rand() < 0.3 ? [pick()] : [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    decayRate: 0.05,
  }));
}

function docOp(l: Lesson): DocOp {
  const obs = lessonToObservation(l);
  const fields = termSourceOf(obs);
  return { k: "doc", id: l.id, sessionId: "lesson", layer: "lesson", ts: Date.parse(l.createdAt), rev: contentRev(fields), fields };
}

const ranked = (hits: Array<{ id: string; score: number }>) =>
  hits.map((h) => ({ id: h.id, score: Math.round(h.score * 1e6) / 1e6 })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

describe.skipIf(!QDRANT_URL)("lessons collection ranks as SearchIndex", () => {
  const rand = mulberry32(1167);
  const qdrant = qdrantFor(`t1167parity_${process.pid}`, DIMS, "lessons" as never);
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  const memory = new SearchIndex();
  const corpus = lessons(160, rand);
  const queries = [
    ...PROMPTS,
    ...Array.from({ length: 30 }, () => [WORDS[Math.floor(rand() * WORDS.length)]!, PROMPTS[Math.floor(rand() * PROMPTS.length)]!].join(" ")),
    "deployment configuration", "testing migrations", "authentication timeout retries",
  ];

  afterAll(() => qdrant.drop(), 30_000);

  async function compareAll(): Promise<void> {
    await engine.settled();
    for (const query of queries) {
      const want = ranked(memory.search(query, 50).map((h) => ({ id: h.obsId, score: h.score })));
      const got = ranked(await engine.keyword(query, 50, "all"));
      expect(got.map((h) => h.id), query).toEqual(want.map((h) => h.id));
      got.forEach((h, i) => expect(h.score, `${query} ${h.id}`).toBeCloseTo(want[i]!.score, 4));
    }
  }

  async function apply(ops: Op[]): Promise<void> {
    const result = await engine.apply(ops);
    expect(result.failed).toEqual([]);
  }

  it("matches on a fresh corpus whose terms are prefixes of each other", async () => {
    for (const l of corpus) memory.add(lessonToObservation(l), "lesson");
    await apply(corpus.map(docOp));
    await compareAll();
  }, 120_000);

  it("still matches after updates and deletes", async () => {
    const updated = corpus.slice(0, 20).map((l) => ({ ...l, content: `${l.content} deployment configuration retries` }));
    const deleted = corpus.slice(20, 45).map((l) => l.id);
    for (const l of updated) memory.add(lessonToObservation(l), "lesson");
    for (const id of deleted) memory.remove(id);
    await apply([...updated.map(docOp), ...deleted.map((id) => ({ k: "del" as const, id }))]);
    await compareAll();
  }, 120_000);
});

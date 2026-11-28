// TEE-1450: the worker keeps its collection's counts (stats, observations per
// session, the BM25 mean document length, the live point count) from one read
// of Qdrant plus the deltas of its own writes. Count and facet calls were half
// of all Qdrant traffic: a 15 s stats poll, the reconcile pass, status, a dl
// facet after every capture and three reads per lesson search.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { contentRev, type DocOp, type Op } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { COUNTS_RESYNC_MS, readTally, type Tally } from "../src/fork/worker/corpus-counts.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { Qdrant } from "../src/fork/worker/qdrant.js";
import type { SearchResultLayer } from "../src/state/search-layer.js";
import { termSourceOf } from "../src/state/term-extraction.js";
import { float32ToBase64 } from "../src/state/vector-index.js";
import type { CompressedObservation } from "../src/types.js";
import { DIMS, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const WORDS = ["redis", "qdrant", "kvrocks", "worker", "facet", "count", "search", "lesson", "memory", "hook", "vector", "sparse"];

function doc(id: string, sessionId: string, layer: SearchResultLayer, words: number, seed: number): DocOp {
  const title = Array.from({ length: words }, (_, i) => WORDS[(seed + i * 7) % WORDS.length]).join(" ");
  const obs: CompressedObservation = {
    id, sessionId, timestamp: "2026-11-27T00:00:00Z", title, narrative: `${title} ${seed}`, type: "discovery", facts: [], concepts: [], files: [], importance: 5,
  };
  const fields = termSourceOf(obs);
  return { k: "doc", id, sessionId, ts: 1, layer, fields, rev: contentRev(fields) };
}
const vec = (op: DocOp, seed: number): Op => ({ k: "vec", id: op.id, rev: op.rev, f32b64: float32ToBase64(Float32Array.from({ length: DIMS }, (_, i) => Math.cos(seed + i))) });

const countOrFacet = (call: { mock: { calls: unknown[][] } }) =>
  call.mock.calls.filter(([, path]) => typeof path === "string" && (path.endsWith("/points/count") || path.endsWith("/facet"))).length;

function mockedEngine(layout?: "lessons") {
  const qdrant = new Qdrant({ url: "http://qdrant.test", collection: `t1450_${layout ?? "docs"}`, dimensions: DIMS, timeoutMs: 1000, oversampling: 6, layout });
  vi.spyOn(qdrant, "ensure").mockResolvedValue();
  vi.spyOn(qdrant, "drop").mockResolvedValue();
  const call = vi.spyOn(qdrant, "call").mockImplementation(async (_method, path, body) => {
    if (path.endsWith("/points/count")) return { count: 3 };
    if (path.endsWith("/facet")) {
      const key = (body as { key?: string }).key;
      return { hits: key === "dl" ? [{ value: 4, count: 3 }] : key === "terms" ? [{ value: "redis", count: 3 }] : [{ value: "ses_a", count: 3 }] };
    }
    if (path.endsWith("/points/scroll")) return { points: [], next_page_offset: null };
    if (path.endsWith("/points/query")) return { points: [] };
    if (path.endsWith("/points")) return [];
    return {};
  });
  return { qdrant, call, engine: new SearchEngine(qdrant, DEFAULT_AVGDL) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("count and facet calls per capture and per search (guard)", () => {
  // The ceiling: once the worker has read its counts, a capture, a stats or
  // session-count read, a docs search and a lesson search add no count or
  // facet call until the resync interval. Raise one only with a measured reason.
  const PRIME_CEILING = 8;
  const PER_CAPTURE_CEILING = 0;
  const PER_READ_CEILING = 0;

  it("docs: captures, stats, session counts and keyword searches read the kept counts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { engine, call } = mockedEngine();
    await engine.stats();
    await engine.sessionCounts();
    await engine.settled();
    const primed = countOrFacet(call);
    expect(primed).toBeGreaterThan(0);
    expect(primed).toBeLessThanOrEqual(PRIME_CEILING);

    const captures = 25;
    for (let i = 0; i < captures; i++) {
      await engine.apply([doc(`obs_${i}`, `ses_${i % 3}`, "observation", 3 + (i % 4), i)], 1_000 + i);
      await engine.settled();
    }
    expect(countOrFacet(call) - primed).toBeLessThanOrEqual(PER_CAPTURE_CEILING * captures);

    const reads = 25;
    for (let i = 0; i < reads; i++) {
      await engine.stats();
      await engine.sessionCounts();
      await engine.keyword("redis qdrant", 10, "all");
    }
    await engine.settled();
    expect(countOrFacet(call) - primed).toBeLessThanOrEqual(PER_READ_CEILING * reads);
  });

  it("lessons: a lesson search reads the vocabulary once and the kept count and mean after that", async () => {
    const { engine, call } = mockedEngine("lessons");
    await engine.keyword("redis", 10, "all");
    const primed = countOrFacet(call);
    // The counts, plus the terms facet the lesson vocabulary is read with.
    expect(primed).toBeLessThanOrEqual(PRIME_CEILING + 1);
    for (let i = 0; i < 20; i++) await engine.keyword(i % 2 ? "redis" : "qdrant worker", 10, "all");
    expect(countOrFacet(call) - primed).toBeLessThanOrEqual(PER_READ_CEILING * 20);
  });

  it("re-reads the counts from Qdrant once the resync interval has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { engine, call } = mockedEngine();
    await engine.stats();
    const primed = countOrFacet(call);
    await engine.stats();
    expect(countOrFacet(call)).toBe(primed);
    vi.setSystemTime(Date.now() + COUNTS_RESYNC_MS + 1);
    await engine.stats();
    expect(countOrFacet(call)).toBeGreaterThan(primed);
  });

  it("drops the kept counts when a batch write fails, and when two writes overlap", async () => {
    const { qdrant, engine, call } = mockedEngine();
    await engine.stats();
    let reads = countOrFacet(call);

    const original = call.getMockImplementation()!;
    call.mockImplementation(async (method, path, body) => {
      if (path.includes("/points/batch")) throw new Error("qdrant down");
      return original(method, path, body);
    });
    await expect(engine.apply([doc("obs_fail", "ses_a", "observation", 3, 1)], 2_000)).rejects.toThrow("qdrant down");
    await engine.stats();
    expect(countOrFacet(call)).toBeGreaterThan(reads);
    reads = countOrFacet(call);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    call.mockImplementation(async (method, path, body) => {
      if (path.includes("/points/batch") && !held) {
        held = true;
        await gate;
      }
      return original(method, path, body);
    });
    const first = engine.apply([doc("obs_x", "ses_a", "observation", 3, 2)], 3_000);
    await vi.waitFor(() => expect(held).toBe(true));
    const second = engine.apply([doc("obs_x", "ses_b", "memory", 4, 3)], 3_001);
    release();
    await Promise.all([first, second]);
    await engine.stats();
    expect(countOrFacet(call)).toBeGreaterThan(reads);
    expect(qdrant).toBeDefined();
  });
});

const tallyOf = (t: Tally) => ({ ...t, sessions: [...t.sessions].sort(([a], [b]) => (a < b ? -1 : 1)) });

describe.skipIf(!QDRANT_URL)("kept counts equal Qdrant's after every write (live)", () => {
  const collections: Qdrant[] = [];
  afterAll(async () => {
    for (const q of collections) await q.drop();
  }, 30_000);

  for (const layout of [undefined, "lessons"] as const) {
    it(`${layout ?? "docs"}: a random write sequence, clears and a bulk load`, async () => {
      const q = qdrantFor(`t1450_parity_${layout ?? "docs"}_${process.pid}_${Math.floor(Math.random() * 1e9)}`, DIMS, layout);
      await q.ensure();
      collections.push(q);
      const engine = new SearchEngine(q, DEFAULT_AVGDL);
      const live = new Map<string, DocOp>();
      let seed = 7;
      const rand = (n: number) => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed % n;
      };
      const layers: SearchResultLayer[] = layout === "lessons" ? ["lesson"] : ["observation", "observation", "memory", "lesson", "insight"];
      let version = 10_000;
      const check = async (label: string) => {
        await engine.settled();
        expect(tallyOf(await engine.counts.read()), label).toEqual(tallyOf(await readTally(q)));
        const stats = await engine.stats();
        const fresh = await readTally(q);
        expect({ docs: stats.docs, vectors: stats.vectors, memories: stats.memories, lessons: stats.lessons, missingVectors: stats.missingVectors }, label)
          .toEqual({ docs: fresh.docs, vectors: fresh.vectors, memories: fresh.memories, lessons: fresh.lessons, missingVectors: fresh.missingVectors });
        expect(new Map(await engine.sessionCounts()), label).toEqual(fresh.sessions);
      };
      await check("empty");
      for (let step = 0; step < 60; step++) {
        const ops: Op[] = [];
        for (let n = 1 + rand(4); n > 0; n--) {
          const id = `doc_${rand(25)}`;
          const kind = rand(10);
          if (kind < 4) {
            const op = doc(id, `ses_${rand(4)}`, layers[rand(layers.length)]!, 1 + rand(9), rand(1000));
            ops.push(op);
            live.set(id, op);
            if (rand(2) === 0) ops.push(vec(op, rand(100)));
          } else if (kind < 6) {
            ops.push({ k: "del", id });
            live.delete(id);
          } else if (kind < 8 && live.has(id)) {
            ops.push(vec(live.get(id)!, rand(100)));
          } else if (kind < 9) {
            ops.push({ k: "vec-del", id });
          } else {
            const stale = live.get(id);
            if (stale) ops.push(vec({ ...stale, rev: contentRev({ ...stale.fields, title: "stale" }) }, 1));
          }
        }
        // Every fifth batch is stamped older than the last, so the version fence drops part of it.
        version += step % 5 === 4 ? -3 : 10;
        await engine.apply(ops, version);
        await check(`step ${step}`);
        if (step === 20) {
          await engine.clear("vectors");
          await check("after clear vectors");
        }
        if (step === 40) {
          await engine.load([...live.values()].slice(0, 5).map((d) => ({ doc: d })), version + 1);
          version += 2;
          await check("after load");
        }
      }
      await engine.clear("all");
      live.clear();
      await check("after clear all");
      await engine.apply([doc("doc_again", "ses_0", layers[0]!, 4, 1)], version + 100);
      await check("write after clear all");
    }, 120_000);
  }
});

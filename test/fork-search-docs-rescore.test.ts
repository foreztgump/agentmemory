import { afterAll, describe, expect, it } from "vitest";
import { contentRev, type DocOp } from "../src/fork/search/protocol.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { SearchIndex } from "../src/state/search-index.js";
import { extractTerms, termSourceOf } from "../src/state/term-extraction.js";
import type { CompressedObservation } from "../src/types.js";
import { QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";

const observation = (id: string, title: string): CompressedObservation => ({
  id, sessionId: "ses_rescore", title, narrative: "", facts: [], concepts: [], files: [],
  type: "discovery", importance: 5, timestamp: "2026-11-01T00:00:00.000Z",
});

function docOp(obs: CompressedObservation): DocOp {
  const fields = termSourceOf(obs);
  return { k: "doc", id: obs.id, sessionId: obs.sessionId, layer: "observation", ts: 1, fields, rev: contentRev(fields) };
}

describe.skipIf(!QDRANT_URL)("docs rescoring after vocabulary fill", () => {
  const qdrant = qdrantFor(`docs_rescore_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
  const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
  const memory = new SearchIndex();
  const corpus = new Map<string, CompressedObservation>();

  afterAll(async () => {
    await engine.settled();
    await qdrant.drop();
  });

  const check = async () => {
    const frequencies = new Map<string, number>();
    let length = 0;
    for (const doc of corpus.values()) {
      const terms = extractTerms(doc);
      length += terms.length;
      for (const term of new Set(terms)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    expect(engine.prefixes!.documentCount).toBe(corpus.size);
    expect(engine.prefixes!.averageLength).toBe(corpus.size > 0 ? length / corpus.size : 0);
    expect(new Map([...engine.prefixes!.frequencies].filter(([, df]) => df > 0))).toEqual(frequencies);
    for (const query of ["redis", "red", "cache", "cache redis", "red redisproxy"]) {
      expect(await engine.keyword(query, 10, "all"), query).toEqual(
        memory.search(query, 10).map(({ obsId, sessionId, score }) => ({ id: obsId, sessionId, score })),
      );
    }
  };

  const write = async (doc: CompressedObservation, version: number) => {
    await engine.apply([docOp(doc)], version);
    corpus.set(doc.id, doc);
    memory.add(doc);
  };

  it("keeps scores and posting order exact across rewrites, duplicates, fenced writes, deletes and restart", async () => {
    await write(observation("later-id", "redisproxy rediscache redisserver"), 1000);
    await write(observation("earlier-id", "redisproxy rediscache redisserver"), 1001);
    await write(observation("exact", "redis cache"), 1002);
    await engine.keyword("red", 10, "all");
    await engine.settled();
    await check();

    const replacement = observation("later-id", "redis cache cache");
    await write(replacement, 2000);
    await check();
    await engine.apply([docOp(replacement)], 2000);
    await check();
    await engine.apply([docOp(observation("later-id", "stale")), { k: "del", id: "exact" }], 1500);
    corpus.delete("exact");
    memory.remove("exact");
    await check();

    await engine.apply([{ k: "del", id: "later-id" }, { k: "del", id: "absent" }], 3000);
    corpus.delete("later-id");
    memory.remove("later-id");
    await check();
    await engine.apply([docOp(replacement)], 2500);
    await check();
    await write(observation("later-id", "redisproxy rediscache redisserver"), 4000);
    await check();

    const restarted = new SearchEngine(qdrant, DEFAULT_AVGDL);
    await restarted.keyword("redis", 10, "all");
    await restarted.settled();
    expect(await restarted.keyword("redis", 10, "all")).toEqual(await engine.keyword("redis", 10, "all"));
  }, 60_000);
});

describe.skipIf(!QDRANT_URL)("a write that lands while the vocabulary fill scrolls", () => {
  it("is counted, so the exact re-score still finds it", async () => {
    const qdrant = qdrantFor(`docs_fill_race_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    try {
      await engine.stats();
      await engine.settled();
      await qdrant.drop();
      engine.prefixes!.clear();
      await qdrant.ensure();
      let release!: () => void;
      const open = new Promise<void>((resolve) => { release = resolve; });
      let reached!: () => void;
      const held = new Promise<void>((resolve) => { reached = resolve; });
      const call = qdrant.call.bind(qdrant);
      let holding = true;
      qdrant.call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const result = await call<T>(method, path, body);
        if (holding && path.endsWith("/points/scroll")) {
          holding = false;
          reached();
          await open;
        }
        return result;
      };
      engine.prefixes!.fillInBackground();
      await held;
      expect((await engine.apply([docOp(observation("obs_race", "racecontent"))])).failed).toEqual([]);
      release();
      await engine.settled();
      expect(engine.prefixes!.documentCount).toBe(1);
      expect((await engine.keyword("racecontent", 10, "all")).map((h) => h.id)).toEqual(["obs_race"]);
    } finally {
      await qdrant.drop();
    }
  }, 60_000);
});

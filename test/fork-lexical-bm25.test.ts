import { describe, expect, it } from "vitest";
import { mulberry32 } from "../bench/fork/lib/stats.js";
import { expandLexicalTerms, lexicalBm25, type LexicalDocument } from "../src/fork/worker/lexical-bm25.js";
import { SearchIndex } from "../src/state/search-index.js";
import { extractTerms, queryTerms } from "../src/state/term-extraction.js";
import type { CompressedObservation } from "../src/types.js";

function observation(id: string, title: string): CompressedObservation {
  return { id, sessionId: "lesson", title, narrative: "", facts: [], concepts: [], files: [], type: "discovery", importance: 5, timestamp: "2026-11-01T00:00:00.000Z" };
}

function compare(corpus: Map<string, CompressedObservation>, memory: SearchIndex, queries: string[]): void {
  const documents: LexicalDocument[] = [...corpus.values()].map((obs) => {
    const terms = extractTerms(obs);
    return { id: obs.id, sessionId: obs.sessionId, terms, dl: terms.length };
  });
  const frequencies = new Map<string, number>();
  for (const { terms } of documents) {
    for (const term of new Set(terms)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  const averageLength = documents.reduce((total, doc) => total + doc.dl, 0) / documents.length;
  for (const query of queries) {
    const expanded = expandLexicalTerms(queryTerms(query), frequencies);
    const candidates = documents.filter((doc) => expanded.some(({ term, prefixes }) => doc.terms.includes(term) || prefixes.some((prefix) => doc.terms.includes(prefix))));
    for (const limit of [1, 7, 50, 1000]) {
      const actual = lexicalBm25(candidates, expanded, frequencies, documents.length, averageLength, limit);
      const expected = memory.search(query, limit).map(({ obsId, sessionId, score }) => ({ id: obsId, sessionId, score }));
      expect(actual, query).toEqual(expected);
    }
  }
}

describe("lexical BM25 parity with SearchIndex", () => {
  it.each([1, 7, 1167, 20261119])("matches seeded random corpora, updates and deletes (seed %i)", (seed) => {
    const random = mulberry32(seed);
    const vocabulary = ["config", "configuration", "configure", "configs", "setup", "deploy", "deployed", "deployment", "deployer", "deploy.", "test", "tests", "testable", "authentication", "auth", "authority", "database", "db", "cache", "cached", "runner", "runtime", "run", "ports", "portable", "log", "logger", "logging", "login", "time", "timer", "timestamp", "postgres", "postgresql", "redis", "rediscache", "redisproxy", "redisserver"];
    const pick = () => vocabulary[Math.floor(random() * vocabulary.length)]!;
    const title = () => Array.from({ length: Math.floor(random() * 45) }, pick).join(" ");
    const memory = new SearchIndex();
    const corpus = new Map<string, CompressedObservation>();
    const add = (obs: CompressedObservation) => {
      corpus.delete(obs.id);
      corpus.set(obs.id, obs);
      memory.add(obs, "lesson");
    };
    for (let i = 0; i < 100; i++) add(observation(`lsn_${i}`, title()));
    const queries = ["", "missing", "redis", "red", "conf", "auth", "db", "run", "time", "config configuration", "deployment config auth", ...Array.from({ length: 25 }, () => `${pick()} ${pick()}`)];
    compare(corpus, memory, queries);
    for (let i = 0; i < 20; i++) add(observation(`lsn_${i}`, title()));
    for (let i = 20; i < 40; i++) {
      corpus.delete(`lsn_${i}`);
      memory.remove(`lsn_${i}`);
    }
    compare(corpus, memory, queries);
    corpus.clear();
    memory.clear();
    compare(corpus, memory, queries);
  });

  it("uses only the best prefix and skips prefixes when the exact term is present", () => {
    const corpus = new Map([
      ["exact", observation("exact", "redis redisproxy rediscache redisserver")],
      ["prefix", observation("prefix", "redisproxy redisproxy rediscache redisserver")],
      ["other", observation("other", "rediscache rediscache")],
    ]);
    const memory = new SearchIndex();
    for (const obs of corpus.values()) memory.add(obs, "lesson");
    compare(corpus, memory, ["redis", "red", "redisproxy", "redis rediscache"]);
  });

  it("scores a candidate whose term the vocabulary lacks, as a document written after the vocabulary was read", () => {
    const doc: LexicalDocument = { id: "late", sessionId: "lesson", terms: ["fresh"], dl: 1 };
    const hits = lexicalBm25([doc], [{ term: "fresh", weight: 1, prefixes: [] }], new Map(), 3, 1, 10);
    expect(hits).toHaveLength(1);
    expect(Number.isFinite(hits[0]!.score)).toBe(true);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });
});

describe("lexical BM25 document frequency", () => {
  it("scores a term whose vocabulary count fell to zero by its candidates, not as the rarest term", () => {
    const docs: LexicalDocument[] = [
      { id: "a", sessionId: "s", terms: ["alpha"], dl: 1 },
      { id: "b", sessionId: "s", terms: ["alpha"], dl: 1 },
    ];
    const query = [{ term: "alpha", weight: 1, prefixes: [] }];
    const stale = lexicalBm25(docs, query, new Map([["alpha", 0]]), 10, 1, 2);
    const unknown = lexicalBm25(docs, query, new Map(), 10, 1, 2);
    expect(stale).toEqual(unknown);
  });
});

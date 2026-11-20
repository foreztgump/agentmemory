import { describe, expect, it } from "vitest";
import { PrefixVocabulary, type VocabularyLimits } from "../src/fork/worker/prefix-vocabulary.js";
import type { Qdrant } from "../src/fork/worker/qdrant.js";
import { querySparse, termsSparse } from "../src/fork/worker/bm25-sparse.js";
import { expandLexicalTerms, lexicalBm25 } from "../src/fork/worker/lexical-bm25.js";
import { queryTerms } from "../src/state/term-extraction.js";

type Page = { points: Array<{ payload: { terms: unknown } }>; next_page_offset: string | null };

/** A Qdrant double that serves the given documents' terms as scroll pages of two. */
function scrolling(docs: unknown[], gate?: Promise<void>) {
  const calls: unknown[] = [];
  const qdrant = {
    path: "/collections/test",
    call: async (_method: string, _path: string, body: { offset?: string }) => {
      calls.push(body);
      await gate;
      const start = Number(body.offset ?? 0);
      const page: Page = {
        points: docs.slice(start, start + 2).map((terms) => ({ payload: { terms } })),
        next_page_offset: start + 2 < docs.length ? String(start + 2) : null,
      };
      return page;
    },
  } as unknown as Qdrant;
  return { qdrant, calls };
}

function vocabulary(docs: unknown[], limits: Partial<VocabularyLimits> = {}, gate?: Promise<void>) {
  const { qdrant, calls } = scrolling(docs, gate);
  const vocab = new PrefixVocabulary(qdrant, async () => {}, { maxTerms: 1000, expansionsPerTerm: 64, ...limits });
  return { vocab, calls };
}

const expanded = (vocab: PrefixVocabulary, term: string, weight = 1) => vocab.expand([{ term, weight }]);
const terms = (vocab: PrefixVocabulary, term: string) => expanded(vocab, term).map((t) => t.term).sort();

describe("PrefixVocabulary", () => {
  it("bounds exact scores across prefix sums, aliases, overlapping queries and mean drift", () => {
    const docs = [["deploy", "deployment", "deploy."], ["deployment", "deployment", "deployer"], ["deploy."], ["other", "other"]];
    const { vocab } = vocabulary([]);
    for (const terms of docs) vocab.observe(terms);
    vocab.noteIndexedAverageLength(1);
    for (const text of ["deploy", "dep", "deploy deployment"]) {
      const query = queryTerms(text);
      const sparse = querySparse(text, (terms) => vocab.expand(terms, true));
      const bound = vocab.scoreUpperBound(query, sparse);
      const frequencies = new Map<number, number>();
      const vectors = docs.map((terms) => termsSparse(terms, 1));
      for (const vector of vectors) for (const id of vector.indices) frequencies.set(id, (frequencies.get(id) ?? 0) + 1);
      const hits = lexicalBm25(docs.map((terms, i) => ({ id: String(i), sessionId: "s", terms, dl: terms.length })), expandLexicalTerms(query, vocab.frequencies), vocab.frequencies, docs.length, vocab.averageLength, 10);
      for (const hit of hits) {
        const vector = vectors[Number(hit.id)]!;
        const raw = sparse.indices.reduce((sum, id, i) => {
          const df = frequencies.get(id) ?? 0;
          const idf = Math.log((docs.length - df + 0.5) / (df + 0.5) + 1);
          const index = vector.indices.indexOf(id);
          return sum + (index < 0 ? 0 : vector.values[index]!) * sparse.values[i]! * idf;
        }, 0);
        expect(raw * bound).toBeGreaterThanOrEqual(hit.score);
      }
    }
    expect(vocab.scoreUpperBound(queryTerms("dep"), { indices: [], values: [] })).toBe(Infinity);
    vocab.clear();
    expect(vocab.scoreUpperBound([], { indices: [], values: [] })).toBe(Infinity);
  });

  it("covers every known prefix for pruning while retaining the default expansion cap", () => {
    const { vocab } = vocabulary([], { expansionsPerTerm: 2 });
    for (const term of ["redis0", "redis1", "redis2", "redis."]) vocab.observe([term]);
    vocab.noteIndexedAverageLength(1);
    expect(vocab.expand([{ term: "redis", weight: 1 }])).toHaveLength(2);
    expect(vocab.expand([{ term: "redis", weight: 1 }], true)).toHaveLength(4);
    const query = queryTerms("redis");
    expect(vocab.scoreUpperBound(query, querySparse("redis", (terms) => vocab.expand(terms)))).toBe(Infinity);
    expect(Number.isFinite(vocab.scoreUpperBound(query, querySparse("redis", (terms) => vocab.expand(terms, true))))).toBe(true);
  });

  it("keeps its score bound when a point carries no stored mean length", () => {
    const { vocab } = vocabulary([]);
    vocab.observe(["redis1"]);
    vocab.noteIndexedAverageLength(1);
    vocab.noteIndexedAverageLength(0);
    const query = queryTerms("redis");
    expect(Number.isFinite(vocab.scoreUpperBound(query, querySparse("redis", (terms) => vocab.expand(terms, true))))).toBe(true);
  });

  it("bounds a complete expansion: past its ceiling a term expands as usual and the score bound is off", () => {
    const { vocab } = vocabulary([], { maxTerms: 10_000, expansionsPerTerm: 4 });
    for (let i = 0; i < 3000; i++) vocab.observe([`redis${i}`]);
    vocab.noteIndexedAverageLength(1);
    expect(vocab.expand([{ term: "redis", weight: 1 }], true)).toHaveLength(4);
    const query = queryTerms("redis");
    expect(vocab.scoreUpperBound(query, querySparse("redis", (terms) => vocab.expand(terms, true)))).toBe(Infinity);
  });

  it("expands a query term into the longer terms it prefixes, at half its weight, after one scroll", async () => {
    const { vocab, calls } = vocabulary([["deploy", "deployment"], ["deployer", "other"], ["dep"], ["deploy."]]);
    expect(expanded(vocab, "deploy")).toEqual([]);
    vocab.fillInBackground();
    await vocab.settled();
    expect(calls).toHaveLength(2);
    // Not itself, and not "deploy.", whose bare form the stored vector already scores.
    expect(terms(vocab, "deploy")).toEqual(["deployer", "deployment"]);
    expect(expanded(vocab, "deploy", 0.7).map((t) => t.weight)).toEqual([0.35, 0.35]);
    expect(terms(vocab, "zzz")).toEqual([]);
    vocab.fillInBackground();
    await vocab.settled();
    expect(calls).toHaveLength(2);
  });

  it("keeps the rarest prefix terms when a query term has more than the cap", async () => {
    const docs = [["auth", "authz", "authn"], ["authz", "authn"], ["authz"], ["authority"]];
    const { vocab } = vocabulary(docs, { expansionsPerTerm: 2 });
    vocab.fillInBackground();
    await vocab.settled();
    expect(terms(vocab, "auth")).toEqual(["authn", "authority"]);
  });

  it("reserves candidate expansion slots for common prefixes that can win on short documents", async () => {
    const docs = Array.from({ length: 128 }, (_, i) => [`prefix${String(i).padStart(3, "0")}`]);
    docs.push(...Array.from({ length: 10 }, () => ["prefixcommon"]));
    const { vocab } = vocabulary(docs);
    vocab.fillInBackground();
    await vocab.settled();
    const candidates = terms(vocab, "prefix");
    expect(candidates).toHaveLength(64);
    expect(candidates).toContain("prefixcommon");
    expect(candidates).toContain("prefix000");
  });

  it("learns the terms of later writes without another scroll, before and after they fold into the sorted array", async () => {
    const { vocab, calls } = vocabulary([["alpha"]], { maxTerms: 10_000 });
    vocab.fillInBackground();
    await vocab.settled();
    vocab.observe(["kubernetes", "kubectl"]);
    expect(terms(vocab, "kube")).toEqual(["kubectl", "kubernetes"]);
    vocab.observe(Array.from({ length: 3000 }, (_, i) => `bulk${i}`));
    expect(terms(vocab, "kube")).toEqual(["kubectl", "kubernetes"]);
    expect(terms(vocab, "bulk299")).toEqual(["bulk2990", "bulk2991", "bulk2992", "bulk2993", "bulk2994", "bulk2995", "bulk2996", "bulk2997", "bulk2998", "bulk2999"]);
    expect(calls).toHaveLength(1);
  });

  it("stops learning at its bound, and counts what it refused", async () => {
    const { vocab } = vocabulary([], { maxTerms: 100 });
    vocab.fillInBackground();
    await vocab.settled();
    vocab.observe(Array.from({ length: 1000 }, (_, i) => `term${i}`));
    expect(vocab.size).toBe(100);
    expect(vocab.refusals).toBe(900);
  });

  it("tracks live corpus statistics through replacements, deletes and revivals", async () => {
    const { vocab, calls } = vocabulary([["alpha", "alpha", "alpine"], [], ["alpine", "beta"]]);
    expect(vocab.isReady).toBe(false);
    vocab.fillInBackground();
    await vocab.settled();
    expect(vocab.isReady).toBe(true);
    expect(vocab.documentCount).toBe(3);
    expect(vocab.averageLength).toBe(5 / 3);
    expect([...vocab.frequencies]).toEqual([["alpha", 1], ["alpine", 2], ["beta", 1]]);
    const previous = { terms: ["alpha", "alpha", "alpine"], dl: 3 };
    const next = { terms: ["beta", "beta", "algebra", "algebra"], dl: 4 };
    vocab.replace(previous, next);
    expect(vocab.documentCount).toBe(3);
    expect(vocab.averageLength).toBe(2);
    expect(vocab.frequencies.get("alpha")).toBe(0);
    expect(vocab.frequencies.get("alpine")).toBe(1);
    expect(vocab.frequencies.get("beta")).toBe(2);
    expect(vocab.frequencies.get("algebra")).toBe(1);
    expect(terms(vocab, "al")).toEqual(["algebra", "alpine"]);
    vocab.replace(next, undefined);
    expect(vocab.documentCount).toBe(2);
    expect(vocab.averageLength).toBe(1);
    expect(vocab.frequencies.get("beta")).toBe(1);
    expect(terms(vocab, "al")).toEqual(["alpine"]);
    vocab.observe(previous.terms);
    expect(vocab.documentCount).toBe(3);
    expect(vocab.averageLength).toBe(5 / 3);
    expect(vocab.frequencies.get("alpha")).toBe(1);
    expect(vocab.frequencies.get("alpine")).toBe(2);
    expect(calls).toHaveLength(2);
    vocab.clear();
    expect(vocab.isReady).toBe(false);
    expect(vocab.documentCount).toBe(0);
    expect(vocab.averageLength).toBe(0);
    expect(vocab.frequencies.size).toBe(0);
  });

  it("holds no more than its bound after scrolling a collection with more distinct terms", async () => {
    const { vocab } = vocabulary([["a1", "a2"], ["a3", "a4"], ["a5", "a1"]], { maxTerms: 3 });
    vocab.fillInBackground();
    await vocab.settled();
    expect(vocab.size).toBe(3);
    expect(vocab.refusals).toBe(2);
  });

  it("serves searches without expansion while the first scroll runs", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const { vocab } = vocabulary([["deployment"]], {}, gate);
    vocab.fillInBackground();
    expect(expanded(vocab, "deploy")).toEqual([]);
    open();
    await vocab.settled();
    expect(terms(vocab, "deploy")).toEqual(["deployment"]);
  });

  it("discards a scroll that was running when the collection was cleared", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const { vocab } = vocabulary([["deployment"]], {}, gate);
    vocab.fillInBackground();
    vocab.clear();
    open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vocab.size).toBe(0);
    expect(expanded(vocab, "deploy")).toEqual([]);
  });

  it("retries the scroll on the next search after a failure", async () => {
    let fail = true;
    const qdrant = {
      path: "/collections/test",
      call: async () => {
        if (fail) throw new Error("qdrant down");
        return { points: [{ payload: { terms: ["deployment"] } }], next_page_offset: null };
      },
    } as unknown as Qdrant;
    const vocab = new PrefixVocabulary(qdrant, async () => {});
    vocab.fillInBackground();
    await vocab.settled();
    expect(expanded(vocab, "deploy")).toEqual([]);
    fail = false;
    vocab.fillInBackground();
    await vocab.settled();
    expect(terms(vocab, "deploy")).toEqual(["deployment"]);
  });
});

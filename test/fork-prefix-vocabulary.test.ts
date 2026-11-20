import { describe, expect, it } from "vitest";
import { PrefixVocabulary, type VocabularyLimits } from "../src/fork/worker/prefix-vocabulary.js";
import type { Qdrant } from "../src/fork/worker/qdrant.js";

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

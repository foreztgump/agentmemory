// One set of search-port cases, run against the in-memory implementation
// (SearchIndex + VectorIndex) and against the am-search engine on a live
// Qdrant. The Qdrant leg is skipped unless QDRANT_URL is set:
//   QDRANT_URL=http://127.0.0.1:6333 [QDRANT_API_KEY=...] npx vitest run test/fork-search-contract.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompressedObservation } from "../src/types.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { KeywordIndexPort, ScoredId, VectorStorePort } from "../src/state/search-ports.js";
import type { SearchLayer, SearchResultLayer } from "../src/state/search-layer.js";
import { createDiskSearchRuntime, type DiskSearchRuntime } from "../src/fork/search/runtime.js";
import { SearchEngine } from "../src/fork/worker/engine.js";
import { DEFAULT_AVGDL } from "../src/fork/search/settings.js";
import { DIMS, engineClient, QDRANT_URL, qdrantFor } from "./helpers/search-engine.js";
import { extractTerms } from "../src/state/term-extraction.js";
import { Generator, type Profile } from "../bench/fork/lib/synthetic.js";
import { mulberry32 } from "../bench/fork/lib/stats.js";
import profile from "../bench/fork/profiles/buddy-2026-11-16.json" with { type: "json" };


interface Backend {
  keyword: KeywordIndexPort;
  vector: VectorStorePort;
  /** Waits until every write so far is searchable. */
  settle(): Promise<void>;
  teardown(): Promise<void>;
}

function obs(id: string, title: string, narrative = "", sessionId = "ses_1"): CompressedObservation {
  return {
    id, sessionId, timestamp: "2026-11-01T00:00:00.000Z", type: "discovery", title, narrative,
    facts: [], concepts: [], files: [], importance: 5,
  } as CompressedObservation;
}

function unit(seed: number): Float32Array {
  const v = new Float32Array(DIMS);
  let n = 0;
  for (let i = 0; i < DIMS; i++) {
    v[i] = Math.sin(seed * 7.31 + i * 1.7);
    n += v[i]! * v[i]!;
  }
  for (let i = 0; i < DIMS; i++) v[i]! /= Math.sqrt(n);
  return v;
}

const ids = (hits: ScoredId[]) => hits.map((h) => h.obsId);

const backends: Array<[string, () => Promise<Backend>, boolean]> = [
  ["in-memory", async () => {
    const keyword = new SearchIndex();
    const vector = new VectorIndex();
    return { keyword, vector, settle: async () => {}, teardown: async () => {} };
  }, false],
  ["qdrant", async () => {
    const qdrant = qdrantFor(`contract_${process.pid}_${Math.floor(Math.random() * 1e9)}`);
    await qdrant.ensure();
    const engine = new SearchEngine(qdrant, DEFAULT_AVGDL);
    const runtime: DiskSearchRuntime = createDiskSearchRuntime(engineClient(engine), true, DIMS);
    return {
      keyword: runtime.keyword,
      vector: runtime.vector!,
      settle: async () => {
        await runtime.outbox.drainFor(10_000);
        engine.prefixes?.fillInBackground();
        await engine.settled();
      },
      teardown: async () => {
        runtime.stats.stop();
        await runtime.outbox.stop(10_000);
        await qdrant.drop();
      },
    };
  }, !QDRANT_URL],
];

describe.each(backends)("search port contract: %s", (_name, make, skip) => {
  let b: Backend;
  const add = (o: CompressedObservation, layer?: SearchResultLayer) => b.keyword.add(o, layer);

  beforeAll(async () => {
    if (skip) return;
    b = await make();
    add(obs("obs_alpha", "kubernetes ingress timeout", "the ingress controller dropped requests"));
    add(obs("obs_beta", "postgres vacuum stalled", "autovacuum blocked by a long transaction"));
    add(obs("mem_gamma", "kubernetes deploy checklist", "always pin the image digest", "memory"), "memory");
    add(obs("lsn_delta", "kubernetes lesson", "drain nodes before upgrades", "lesson"), "lesson");
    add(obs("obs_auth", "authentication token refresh", "the refresh loop retried forever"));
    b.vector.add("obs_alpha", "ses_1", unit(1));
    b.vector.add("obs_beta", "ses_1", unit(2));
    b.vector.add("mem_gamma", "memory", unit(3));
    await b.settle();
  }, 60_000);

  afterAll(async () => {
    if (!skip) await b.teardown();
  }, 60_000);

  it.skipIf(skip)("finds a document by keyword and ranks the matching document first", async () => {
    const hits = await b.keyword.search("vacuum", 10);
    expect(ids(hits)).toEqual(["obs_beta"]);
    expect(hits[0]!.sessionId).toBe("ses_1");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it.skipIf(skip)("filters keyword results by layer", async () => {
    expect(new Set(ids(await b.keyword.search("kubernetes", 10, "all")))).toEqual(new Set(["obs_alpha", "mem_gamma", "lsn_delta"]));
    expect(ids(await b.keyword.search("kubernetes", 10, "memory"))).toEqual(["mem_gamma"]);
    expect(ids(await b.keyword.search("kubernetes", 10, "observation"))).toEqual(["obs_alpha"]);
  });

  it.skipIf(skip)("expands synonyms", async () => {
    expect(ids(await b.keyword.search("auth", 10))).toContain("obs_auth");
  });

  it.skipIf(skip)("matches a word that ends a sentence or a path", async () => {
    add(obs("obs_punct", "rollout notes", "the canary moved to kafka. logs went to tmp/"));
    await b.settle();
    try {
      expect(ids(await b.keyword.search("kafka", 10))).toEqual(["obs_punct"]);
      expect(ids(await b.keyword.search("tmp", 10))).toEqual(["obs_punct"]);
    } finally {
      b.keyword.remove("obs_punct");
      await b.settle();
    }
  });

  it.skipIf(skip)("returns nothing for a query with no indexable terms", async () => {
    expect(await b.keyword.search("a", 10)).toEqual([]);
  });

  it.skipIf(skip)("finds the nearest vector, filtered by layer", async () => {
    expect(ids(await b.vector.search(unit(2), 1))[0]).toBe("obs_beta");
    expect(ids(await b.vector.search(unit(2), 10, "memory"))).toEqual(["mem_gamma"]);
    expect(ids(await b.vector.search(unit(3), 10, "observation"))).not.toContain("mem_gamma");
  });

  it.skipIf(skip)("re-adding a changed document replaces its terms", async () => {
    add(obs("obs_beta", "postgres replication lag", "a replica fell behind"));
    await b.settle();
    expect(ids(await b.keyword.search("vacuum", 10))).toEqual([]);
    expect(ids(await b.keyword.search("replication", 10))).toEqual(["obs_beta"]);
  });

  it.skipIf(skip)("removing a vector keeps the document findable by keyword", async () => {
    b.vector.remove("obs_alpha");
    await b.settle();
    expect(ids(await b.vector.search(unit(1), 10))).not.toContain("obs_alpha");
    expect(ids(await b.keyword.search("ingress", 10))).toEqual(["obs_alpha"]);
  });

  it.skipIf(skip)("a removed document disappears from keyword and vector search", async () => {
    b.keyword.remove("mem_gamma");
    b.vector.remove("mem_gamma");
    await b.settle();
    expect(ids(await b.keyword.search("checklist", 10))).toEqual([]);
    expect(ids(await b.vector.search(unit(3), 10))).not.toContain("mem_gamma");
    expect(b.keyword.has("mem_gamma")).toBe(false);
    expect(b.keyword.layerOf("mem_gamma")).toBeUndefined();
  });

  it.skipIf(skip)("a new document is searchable by the next search without an explicit flush", async () => {
    add(obs("obs_fresh", "zeppelin hangar inventory"));
    b.vector.add("obs_fresh", "ses_1", unit(9));
    expect(ids(await b.keyword.search("zeppelin", 10))).toEqual(["obs_fresh"]);
    expect(ids(await b.vector.search(unit(9), 1))).toEqual(["obs_fresh"]);
  });

  it.skipIf(skip)("counts observations by session and document kinds", async () => {
    await b.settle();
    expect((await b.keyword.observationCountsBySession()).get("ses_1")).toBe(4);
    expect(await b.keyword.documentKindCounts()).toEqual({ memories: 0, lessons: 1 });
  });
});

// A query term also matches every indexed term it is a prefix of, at half
// its idf. Each case's ranking is asserted on both implementations.
describe.each(backends)("prefix expansion contract: %s", (_name, make, skip) => {
  let b: Backend;
  const search = async (query: string, layer?: SearchLayer) => ids(await b.keyword.search(query, 10, layer));

  beforeAll(async () => {
    if (skip) return;
    b = await make();
    b.keyword.add(obs("obs_tron", "zorbtron rollout", "pods restarted after the rollout"));
    b.keyword.add(obs("obs_zorb", "zorb proxy rules", "iptables rules for the service"));
    b.keyword.add(obs("obs_quellcraft", "quellcraft drift", "the staging quellcraft drifted from prod"));
    b.keyword.add(obs("obs_quell", "quell file moved", "nginx quell moved to sites"));
    b.keyword.add(obs("obs_nginx_end", "pipeline finished", "the release went out after restarting nginx."));
    b.keyword.add(obs("mem_zorbmax", "zorbmax contexts", "switch contexts before applying", "memory"), "memory");
    b.keyword.add(obs("obs_unrelated", "postgres vacuum", "autovacuum blocked by a long transaction"));
    await b.settle();
  }, 60_000);

  afterAll(async () => {
    if (!skip) await b.teardown();
  }, 60_000);

  it.skipIf(skip)("finds a document only through a longer indexed term", async () => {
    expect(await search("rollo")).toEqual(["obs_tron"]);
    expect(await search("iptab")).toEqual(["obs_zorb"]);
  });

  it.skipIf(skip)("ranks an exact match above documents reached only through a prefix", async () => {
    const hits = await search("zorb");
    expect(hits[0]).toBe("obs_zorb");
    expect(new Set(hits)).toEqual(new Set(["obs_zorb", "obs_tron", "mem_zorbmax"]));
    expect(await search("quell")).toEqual(["obs_quell", "obs_quellcraft"]);
  });

  it.skipIf(skip)("matches a sentence-final word through its bare form, below the exact match", async () => {
    expect(await search("nginx")).toEqual(["obs_quell", "obs_nginx_end"]);
  });

  it.skipIf(skip)("keeps the layer filter for prefix matches", async () => {
    expect(await search("zorbma", "memory")).toEqual(["mem_zorbmax"]);
    expect(await search("zorbma", "observation")).toEqual([]);
  });

  it.skipIf(skip)("adds the prefix score of one query term to the exact score of another", async () => {
    expect(await search("zorb rollout")).toEqual(["obs_tron", "obs_zorb", "mem_zorbmax"]);
  });

  it.skipIf(skip)("adds a query term's prefix score to another query term's exact score for the same indexed term", async () => {
    const scoreOf = async (query: string) => (await b.keyword.search(query, 10)).find((h) => h.obsId === "obs_tron")!.score;
    const exactOnly = await scoreOf("zorbtron");
    const both = await scoreOf("zorb zorbtron");
    expect(both / exactOnly).toBeGreaterThan(1.3);
  });

  it.skipIf(skip)("drops a deleted document reached through a prefix", async () => {
    b.keyword.remove("obs_quell");
    await b.settle();
    expect(await search("quell")).toEqual(["obs_quellcraft"]);
  });
});

// Top-k agreement of keyword search between the two implementations on a
// synthetic corpus shaped like buddy's store. Qdrant scores a document that
// holds several prefix matches of one query term by their sum (SearchIndex
// takes the best) and uses a frozen avgdl, so the rankings differ slightly.
const KEYWORD_TOP10_OVERLAP_MIN = 0.9;
// Every word cut to 60% of its length, so each query term matches only through
// prefixes. Measured 0.880 at 64 expansions per term, 0.222 with none.
const PREFIX_TOP10_OVERLAP_MIN = 0.85;

describe.skipIf(!QDRANT_URL)("keyword parity on a synthetic corpus", () => {
  const DOCS = 2000;
  const QUERIES = 200;
  let disk: Awaited<ReturnType<(typeof backends)[1][1]>>;
  const memory = new SearchIndex();
  const queries: string[] = [];
  const prefixQueries: string[] = [];

  beforeAll(async () => {
    disk = await backends[1]![1]();
    const gen = new Generator(profile as unknown as Profile, DOCS, 1164);
    const rand = mulberry32(7);
    let termTotal = 0;
    for (let s = 0; memory.size < DOCS; s++) {
      const session = gen.session(s);
      for (let i = 0; i < 20 && memory.size < DOCS; i++) {
        const o = gen.observation(session, i * 1000) as unknown as CompressedObservation;
        if (!o.title || !o.narrative) continue;
        memory.add(o);
        disk.keyword.add(o);
        termTotal += extractTerms(o).length;
        if (queries.length < QUERIES && rand() < 0.2) {
          const words = `${o.title} ${o.narrative}`.split(/\s+/).filter((w) => w.length > 3);
          const picked = [0, 1].map(() => words[Math.floor(rand() * words.length)]!);
          queries.push(picked.join(" "));
          prefixQueries.push(picked.map((w) => w.slice(0, Math.max(3, Math.ceil(w.length * 0.6)))).join(" "));
        }
      }
    }
    console.log(`parity corpus: ${DOCS} docs, mean ${(termTotal / DOCS).toFixed(1)} terms per doc, ${queries.length} queries`);
    await disk.settle();
  }, 120_000);

  afterAll(async () => {
    await disk?.teardown();
  }, 60_000);

  it.each([
    ["whole-word", queries, KEYWORD_TOP10_OVERLAP_MIN],
    ["truncated-word", prefixQueries, PREFIX_TOP10_OVERLAP_MIN],
  ] as const)("agrees on the top 10 for %s queries (at least %s)", async (_kind, queries, min) => {
    let overlap = 0;
    let exactTop1 = 0;
    for (const q of queries) {
      const want = ids(memory.search(q, 10));
      const got = ids(await disk.keyword.search(q, 10));
      if (want.length === 0) {
        overlap += got.length === 0 ? 1 : 0;
        continue;
      }
      overlap += got.filter((id) => want.includes(id)).length / want.length;
      if (got[0] === want[0]) exactTop1++;
    }
    const mean = overlap / queries.length;
    console.log(`keyword top-10 overlap ${mean.toFixed(3)}, top-1 agreement ${(exactTop1 / queries.length).toFixed(3)} over ${queries.length} queries`);
    expect(mean).toBeGreaterThanOrEqual(min);
  }, 120_000);
});

// The same agreement for vector search at the production dimension: clustered
// vectors (noisy copies of shared centroids), exact cosine in memory against
// Qdrant's 1-bit codes with float rescoring.
const VECTOR_TOP10_OVERLAP_MIN = 0.95;

describe.skipIf(!QDRANT_URL)("vector parity at 1024 dimensions", () => {
  const D = 1024;
  const qdrant = qdrantFor(`parity_vec_${process.pid}`, D);
  let runtime: DiskSearchRuntime;
  const memory = new VectorIndex();
  const rand = mulberry32(11);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const noisy = (c: Float32Array, sigma: number) => {
    const v = new Float32Array(D);
    let n = 0;
    for (let i = 0; i < D; i++) n += (v[i] = c[i]! + sigma * gauss()) ** 2;
    for (let i = 0; i < D; i++) v[i]! /= Math.sqrt(n);
    return v;
  };
  const centroids = Array.from({ length: 200 }, () => noisy(new Float32Array(D), 1));

  beforeAll(async () => {
    await qdrant.ensure();
    runtime = createDiskSearchRuntime(engineClient(new SearchEngine(qdrant, DEFAULT_AVGDL)), true, D);
    centroids.forEach((c, k) => {
      for (let j = 0; j < 10; j++) {
        const id = `obs_${k}_${j}`;
        const v = noisy(c, 0.03);
        runtime.keyword.add(obs(id, `doc ${k}`));
        runtime.vector!.add(id, "ses_1", v);
        memory.add(id, "ses_1", v);
      }
    });
    await runtime.outbox.drainFor(60_000);
  }, 120_000);

  afterAll(async () => {
    runtime.stats.stop();
    await runtime.outbox.stop(10_000);
    await qdrant.drop();
  }, 60_000);

  it(`agrees on at least ${VECTOR_TOP10_OVERLAP_MIN} of the top 10`, async () => {
    let overlap = 0;
    for (const c of centroids.slice(0, 100)) {
      const q = noisy(c, 0.03);
      const want = ids(memory.search(q, 10));
      const got = ids(await runtime.vector!.search(q, 10));
      overlap += got.filter((id) => want.includes(id)).length / want.length;
    }
    console.log(`vector top-10 overlap ${(overlap / 100).toFixed(3)} over 100 queries`);
    expect(overlap / 100).toBeGreaterThanOrEqual(VECTOR_TOP10_OVERLAP_MIN);
  }, 120_000);
});

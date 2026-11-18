// recall@10 at scale, with Qdrant's own exact search (full-precision originals, no
// HNSW, no codes) as ground truth: a check that the S2 setting found on buddy's
// 249k real vectors still holds on the 1M and 3M synthetic collections. Queries are
// fresh noisy copies of real vectors. `--oversampling float` searches the HNSW
// graph on the originals without the codes, to separate graph misses from code misses. A hit is a returned point whose score is
// within 1e-3 of the 10th exact score (ann-benchmarks' k-nn recall).
//
//   QDRANT_URL=http://127.0.0.1:16333 node --import tsx bench/fork/qdrant/recall-exact.ts \
//     --vectors /home/cownose/am-staging/qdrant-spike/buddy --collection s1_1m --oversampling 2,3,4
import { parseArgs } from "node:util";
import { mulberry32 } from "../lib/stats.js";
import { DIMS, noisyCopy, qdrant, readVectors, wireVector } from "./lib.js";

const { values: args } = parseArgs({
  options: {
    vectors: { type: "string" },
    collection: { type: "string" },
    queries: { type: "string", default: "200" },
    oversampling: { type: "string", default: "2,3,4" },
    filters: { type: "string" },
  },
});
if (!args.vectors || !args.collection) throw new Error("--vectors and --collection are required");
const set = readVectors(args.vectors);
const rand = mulberry32(9161);
const K = 10;
const EPSILON = 1e-3;
const queries = Array.from({ length: Number(args.queries) }, () => {
  const src = Math.floor(rand() * set.size);
  return wireVector(noisyCopy(set.data.subarray(src * DIMS, (src + 1) * DIMS), 0.0151, rand));
});

type Hit = { score: number };
const search = (query: number[], params: unknown, layer?: string) =>
  qdrant<{ points: Hit[] }>("POST", `/collections/${args.collection}/points/query`, {
    query, using: "dense", limit: K, params,
    ...(layer ? { filter: { must: [{ key: "layer", match: { value: layer } }] } } : {}),
  }).then((r) => r.points.map((p) => p.score));

for (const layer of (args.filters ?? "all,observation,memory,lesson").split(",").map((f) => (f === "all" ? undefined : f))) {
  const exact = await Promise.all(queries.map((q) => search(q, { exact: true, quantization: { ignore: true } }, layer)));
  for (const o of args.oversampling!.split(",")) {
    let sum = 0;
    for (let n = 0; n < queries.length; n++) {
      const kth = exact[n]!.at(-1)!;
      const params = o === "float" ? { quantization: { ignore: true } } : { quantization: { rescore: true, oversampling: Number(o) } };
      const got = await search(queries[n]!, params, layer);
      sum += Math.min(got.filter((s) => s >= kth - EPSILON).length, exact[n]!.length) / exact[n]!.length;
    }
    console.log(JSON.stringify({ collection: args.collection, filter: layer ?? "all", oversampling: o === "float" ? "hnsw on originals, no codes" : Number(o), recallAt10: +(sum / queries.length).toFixed(4) }));
  }
}

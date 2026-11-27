// Prints one JSON snapshot: record counts per KV scope family, and exact Qdrant point counts per collection.
//   stage.sh run bench/fork/retention/snapshot.ts > snap.json
import { qdrantCounts, scopeCounts } from "./lib.js";

const started = Date.now();
const [kv, search] = await Promise.all([scopeCounts(), qdrantCounts()]);
console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - started, kv, search }, null, 1));

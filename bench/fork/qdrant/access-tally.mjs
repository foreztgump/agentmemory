// TEE-1450: tallies Qdrant's access log (its default INFO actix logger lines) by
// collection and endpoint: requests, per hour, mean and max seconds, and how many
// took 500 ms or more. Reads the log on stdin.
//
//   docker logs --since <iso> --until <iso> <qdrant-container> 2>&1 | node bench/fork/qdrant/access-tally.mjs --minutes 30
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { minutes: { type: "string" } } });
const LINE = /"(GET|POST|PUT|DELETE|PATCH) \/collections\/([^/\s?]+)([^\s?]*)[^"]*" (\d{3}) .* ([0-9.]+)$/;
const endpoint = (rest) => {
  if (rest === "" || rest === "/") return "collection";
  if (rest.startsWith("/points/")) return `points/${rest.slice(8).split("/")[0]}`;
  return rest.slice(1);
};

let input = "";
for await (const chunk of process.stdin) input += chunk;
const rows = new Map();
for (const line of input.split("\n")) {
  const m = LINE.exec(line.trim());
  if (!m) continue;
  const key = `${m[2]} ${m[1]} ${endpoint(m[3])}`;
  const s = Number(m[5]);
  const r = rows.get(key) ?? { n: 0, total: 0, max: 0, slow: 0 };
  r.n++;
  r.total += s;
  r.max = Math.max(r.max, s);
  if (s >= 0.5) r.slow++;
  rows.set(key, r);
}
const hours = args.minutes ? Number(args.minutes) / 60 : null;
const out = [...rows].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, r]) => ({
  key, n: r.n, ...(hours ? { perHour: Math.round(r.n / hours) } : {}), avgMs: Math.round((r.total / r.n) * 1000), maxMs: Math.round(r.max * 1000), slow500: r.slow,
}));
const countFacet = out.filter((r) => / (points\/count|facet)$/.test(r.key)).reduce((n, r) => n + r.n, 0);
const all = out.reduce((n, r) => n + r.n, 0);
console.log(JSON.stringify({ rows: out, countFacet, all, ...(hours ? { countFacetPerHour: Math.round(countFacet / hours), allPerHour: Math.round(all / hours) } : {}) }, null, 2));

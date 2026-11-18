// Builds the knowledge-graph edges for the synthetic tier's graph cases through
// the real write path (POST /agentmemory/graph/extract, heuristic extraction, no
// LLM), then builds the graph retrieval index. Runs on the replica network
// (replica.sh client) after generate.ts loaded the same seed.
//
//   node --import tsx bench/fork/seed-graph.ts --profile <file> [--seed 1155]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Generator, plant, type Profile } from "./lib/synthetic.js";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    seed: { type: "string", default: "1155" },
    url: { type: "string", default: "http://agentmemory:3111" },
    secret: { type: "string", default: "replica-dummy-secret" },
  },
});
if (!args.profile) throw new Error("--profile is required");
const profile = JSON.parse(readFileSync(args.profile, "utf8")) as Profile;
const { graphSeeds } = plant(new Generator(profile, profile.indexable, Number(args.seed)));

let nodes = 0;
let edges = 0;
for (const observations of graphSeeds) {
  const res = await fetch(`${args.url}/agentmemory/graph/extract`, {
    method: "POST",
    headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ observations }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as { success?: boolean; nodesAdded?: number; edgesAdded?: number; nodes?: number; edges?: number; error?: string };
  if (!res.ok || body.success === false) throw new Error(`graph/extract ${res.status}: ${JSON.stringify(body)}`);
  nodes += body.nodesAdded ?? body.nodes ?? 0;
  edges += body.edgesAdded ?? body.edges ?? 0;
}
// graph/extract writes nodes and edges; graph retrieval reads a separate index
// that a fresh store has not built yet.
const migrate = await fetch(`${args.url}/agentmemory/graph/index/migrate`, {
  method: "POST",
  headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
  body: JSON.stringify({ allowLegacyScan: true }),
  signal: AbortSignal.timeout(60_000),
});
if (migrate.status >= 400) throw new Error(`graph/index/migrate ${migrate.status}: ${await migrate.text()}`);
let index: { ready?: boolean; state?: string } = {};
for (let i = 0; i < 300 && !index.ready; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    index = await (await fetch(`${args.url}/agentmemory/graph/index`, {
      headers: { authorization: `Bearer ${args.secret}` },
      signal: AbortSignal.timeout(30_000),
    })).json();
  } catch (error) {
    console.error(`graph index poll ${i + 1}/300 failed: ${(error as Error).message}`);
  }
}
if (!index.ready) throw new Error(`graph index not ready: ${JSON.stringify(index)}`);
console.log(JSON.stringify({ seeds: graphSeeds.length, nodes, edges, graphIndex: index.state }));

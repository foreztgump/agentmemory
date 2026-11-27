// TEE-1450: compares the index counts /agentmemory/status reports with Qdrant's own
// exact counts of the docs collection, read at the same moment. Runs on the replica
// network (replica.sh client); exits 1 when they differ.
//
//   node bench/fork/qdrant/status-parity.mjs [--collection agentmemory]
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://agentmemory:3111" },
    secret: { type: "string", default: "replica-dummy-secret" },
    qdrant: { type: "string", default: "http://qdrant:6333" },
    "qdrant-key": { type: "string", default: "replica-dummy-qdrant-key" },
    collection: { type: "string", default: "agentmemory" },
  },
});
const count = async (filter) => {
  const res = await fetch(`${args.qdrant}/collections/${args.collection}/points/count`, {
    method: "POST", headers: { "api-key": args["qdrant-key"], "content-type": "application/json" }, body: JSON.stringify({ exact: true, filter }),
  });
  return (await res.json()).result.count;
};
const layer = (value) => ({ must: [{ key: "layer", match: { value } }] });
const status = await (await fetch(`${args.url}/agentmemory/status`, { headers: { authorization: `Bearer ${args.secret}` } })).json();
const [observations, memories, lessons] = await Promise.all([count(layer("observation")), count(layer("memory")), count(layer("lesson"))]);
const reported = { observationsIndexed: status.index?.observationsIndexed, memoriesIndexed: status.index?.memoriesIndexed, lessonsIndexed: status.index?.lessonsIndexed };
const qdrant = { observationsIndexed: observations, memoriesIndexed: memories, lessonsIndexed: lessons };
const same = Object.keys(qdrant).every((k) => reported[k] === qdrant[k]);
console.log(JSON.stringify({ same, reported, qdrant }));
process.exit(same ? 0 : 1);

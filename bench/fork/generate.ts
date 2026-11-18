// Writes N synthetic observations in agentmemory's Valkey layout (one hash per
// scope, "state:<scope>", JSON values) as a RESP stream for `valkey-cli --pipe`.
// Shapes follow a measured profile (bench/fork/profile.ts). The planted eval facts
// come first from their own seed, so the committed cases match every N.
//
//   node --import tsx bench/fork/generate.ts --count 250000 --profile bench/fork/profiles/buddy-2026-11-16.json \
//     --graph-seeds /tmp/seeds.json [--cases bench/fork/eval/synthetic-cases.json] | docker exec -i <valkey> valkey-cli --pipe
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Generator, obsIndexShard, plant, resp, type Observation, type Profile, type Session } from "./lib/synthetic.js";

const { values: args } = parseArgs({
  options: {
    count: { type: "string" },
    seed: { type: "string", default: "1155" },
    profile: { type: "string" },
    cases: { type: "string" },
    "graph-seeds": { type: "string" },
    "plant-only": { type: "boolean", default: false },
  },
});
const count = Number(args.count);
if (!args.profile || !Number.isInteger(count) || count <= 0) throw new Error("--count N and --profile are required");
const profile = JSON.parse(readFileSync(args.profile, "utf8")) as Profile;
const seed = Number(args.seed);

const planted = plant(new Generator(profile, profile.indexable, seed));
if (args.cases) writeFileSync(args.cases, JSON.stringify({ seed, cases: planted.cases }, null, 2) + "\n");
if (args["graph-seeds"]) writeFileSync(args["graph-seeds"], JSON.stringify(planted.graphSeeds) + "\n");
if (args["plant-only"]) process.exit(0);

const out = process.stdout;
let buffered = "";
async function emit(cmd: string): Promise<void> {
  buffered += cmd;
  if (buffered.length < 1 << 20) return;
  const chunk = buffered;
  buffered = "";
  if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
}

async function writeSession(session: Session, observations: Observation[]): Promise<void> {
  session.observationCount = observations.length;
  await emit(resp(["HSET", "state:mem:sessions", session.id, JSON.stringify(session)]));
  const fields: string[] = [];
  for (const obs of observations) fields.push(obs.id, JSON.stringify(obs));
  await emit(resp(["HSET", `state:mem:obs:${session.id}`, ...fields]));
  for (const obs of observations) {
    await emit(resp(["HSET", `state:mem:idx:obs:${obsIndexShard(obs.id)}`, obs.id, JSON.stringify(session.id)]));
  }
}

for (const session of planted.sessions) {
  await writeSession(session, planted.observations.filter((o) => o.sessionId === session.id));
}
if (count < planted.observations.length) throw new Error(`--count ${count} is below the ${planted.observations.length} planted observations the eval cases need`);
const gen = new Generator(profile, count, seed + 1);
let written = planted.observations.length;
for (let s = 0; written < count; s++) {
  const session = gen.session(s);
  const size = Math.min(gen.sessionSize(), count - written);
  const observations: Observation[] = [];
  for (let i = 0; i < size; i++) observations.push(gen.observation(session, i * 30_000));
  await writeSession(session, observations);
  written += size;
}
out.write(buffered);

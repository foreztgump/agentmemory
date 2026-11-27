// Scores a recall-cases file the way the retention recall check does (loadRecallCases + scoreCases), with mem::smart-search
// sent through the REST route. Prints counts only, never queries.
//   stage.sh run bench/fork/retention/score-cases.ts --cases /private/cases.json
import { loadRecallCases, scoreCases } from "../../../src/fork/retention/recall-check.js";
import { am, requireArg } from "./lib.js";

const cases = await loadRecallCases(requireArg("cases", "stage.sh run bench/fork/retention/score-cases.ts --cases /private/cases.json"));
const sdk = {
  trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
    if (function_id !== "mem::smart-search") throw new Error(`unexpected ${function_id}`);
    const res = await am("POST", "/agentmemory/smart-search", payload);
    if (res.status !== 200) throw new Error(`smart-search ${res.status}`);
    return res.body;
  },
} as unknown as Parameters<typeof scoreCases>[0];
if (cases.length === 0) {
  console.error("no cases in the file: a recall of 100 over nothing proves nothing");
  process.exit(1);
}
const score = await scoreCases(sdk, cases);
const golden = cases.filter((c) => c.golden).map((c) => c.id);
const missed = golden.filter((id) => !score.goldenHit.has(id));
console.log(JSON.stringify({ cases: cases.length, golden: golden.length, goldenHit: score.goldenHit.size, missed, recallAt10: score.recallAt10 }));
process.exit(missed.length === 0 && score.recallAt10 === 100 ? 0 : 1);

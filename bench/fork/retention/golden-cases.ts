// Builds the golden recall-cases file from rows a dry-run report lists as planned, and keeps only the cases whose query
// puts the evidence id in the top 10 on this keyword-only replica (the same smart-search call the recall check makes).
//   stage.sh run bench/fork/retention/golden-cases.ts --report /private/dry2-report.json [--count 8] > out.json   (the cases are the `cases` key)
// The report is the JSON that report.ts --samples (or sweep.ts --out) printed. Each case's evidence is one row from `samples`, so the run plans it.
// Queries are the row's title words; a longer query is tried when the title alone misses. The rows are read from Kvrocks.
import { readFileSync } from "node:fs";
import { am, arg, redis, requireArg, text } from "./lib.js";

const file = JSON.parse(readFileSync(requireArg("report", "stage.sh run bench/fork/retention/golden-cases.ts --report /private/<file>.json [--count 8]"), "utf8"));
const report = file.report?.perStage ? file.report : file.report.report;
const want = Number(arg("count", "8"));
const r = await redis();
// --mix O:7,T:1 overrides the per-stage take, for a stack whose report has no samples in some stages.
const kinds: Array<{ stage: string; take: number }> = arg("mix")
  ? arg("mix")!.split(",").map((part) => { const [stage, take] = part.split(":"); return { stage: stage!, take: Number(take) }; })
  : [{ stage: "O", take: 3 }, { stage: "T", take: 1 }, { stage: "S", take: 1 }, { stage: "C", take: 4 }, { stage: "X", take: 1 }];
// --max-rank 1 keeps only cases whose evidence ranks at or above it, so a case has margin before it leaves the top 10.
const maxRank = Number(arg("max-rank", "10"));
const cases: unknown[] = [];
const tried: string[] = [];
async function titleOf(stage: string, id: string): Promise<{ title: string; narrative: string } | null> {
  const [scope, field] = stage === "O" || stage === "T"
    ? [`state:mem:obs:${id.split("/")[0]}`, id.split("/")[1]!]
    : ["state:mem:memories", id];
  const raw = await r.call("HGET", scope, field);
  if (!raw) return null;
  const row = JSON.parse(text(raw));
  // A demote is vetoed by memory type and by a deliberate save (protect.ts), so a stage C case needs a memory with neither.
  if (stage === "C" && (row.type === "architecture" || row.type === "preference" || row.origin?.channel === "user" || row.origin?.channel === "agent")) return null;
  return { title: String(row.title ?? ""), narrative: String(row.narrative ?? row.content ?? "") };
}
const words = (s: string, n: number): string => s.replace(/[^\p{L}\p{N}_ -]+/gu, " ").split(/\s+/).filter(Boolean).slice(0, n).join(" ");
for (const { stage, take } of kinds) {
  let got = 0;
  for (const sample of report.samples?.[stage] ?? []) {
    if (got >= take || cases.length >= want) break;
    const id: string = sample.id;
    const row = await titleOf(stage, id);
    if (!row?.title) continue;
    const evidenceId = id.includes("/") ? id.split("/")[1]! : id;
    for (const query of [words(row.title, 12), `${words(row.title, 12)} ${words(row.narrative, 12)}`]) {
      if (query.split(" ").length < 3) continue;
      const res = await am("POST", "/agentmemory/smart-search", { query, limit: 10, includeLessons: false });
      const rank = (res.body?.results ?? []).findIndex((hit: { obsId: string }) => hit.obsId === evidenceId);
      tried.push(`${stage} ${id} rank=${rank}`);
      if (rank >= 0 && rank < maxRank) {
        cases.push({ id: `g-${stage}-${cases.length + 1}`, query, evidence: [evidenceId], golden: true, stage, rank: rank + 1 });
        got++;
        break;
      }
    }
  }
}
r.close();
console.log(JSON.stringify({ written: cases.length, cases, tried }, null, 1));
process.exit(cases.length >= 5 ? 0 : 1);

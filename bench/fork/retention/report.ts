// Prints a run's report (the newest run without --run) as JSON: the run row summary and the report, samples left out unless --samples.
//   stage.sh run bench/fork/retention/report.ts [--run ret_...] [--samples]
import { am, arg, flag } from "./lib.js";

const runId = arg("run");
const res = await am("GET", `/agentmemory/retention/report${runId ? `?runId=${runId}` : ""}`);
const body = res.body;
if (body?.report && !flag("samples")) {
  delete body.report.samples;
  delete body.report.protectedSamples;
}
console.log(JSON.stringify(body, null, 1));

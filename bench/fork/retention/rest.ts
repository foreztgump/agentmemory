// One authenticated REST call from the client container. Prints the status, the wall time and the body as JSON.
//   stage.sh run bench/fork/retention/rest.ts POST /agentmemory/retention/purge '{"dryRun":false}'
//   stage.sh run bench/fork/retention/rest.ts GET "/agentmemory/retention/report?runId=ret_..."
import { am } from "./lib.js";

const [method, path, body] = process.argv.slice(2);
const res = await am(method as "GET" | "POST", path!, body ? JSON.parse(body) : undefined);
console.log(JSON.stringify({ status: res.status, ms: res.ms, body: res.body }, null, 1));

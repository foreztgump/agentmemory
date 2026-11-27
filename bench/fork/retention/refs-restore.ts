// Restores one group of a grace file's refs through the REST route (part 2 at 23 h), then prints where each ref is.
//   stage.sh run bench/fork/retention/refs-restore.ts --file /private/grace.json --group A
import { readFileSync } from "node:fs";
import { am, arg } from "./lib.js";

const file = JSON.parse(readFileSync(arg("file")!, "utf8")) as { refs: Array<{ group: string; ref: unknown }> };
const refs = file.refs.filter((x) => x.group === arg("group", "A")).map((x) => x.ref);
const res = await am("POST", "/agentmemory/retention/restore", { refs });
console.log(JSON.stringify({ status: res.status, refs: refs.length, body: res.body }, null, 1));

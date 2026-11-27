// Where is each ref of a grace-check file? Used when the grace run is started (--stage start) and by part 2
// (docs/fork/retention-staging.md): at 23 h the refs must still be vaulted, and at 25 h gone everywhere.
//   stage.sh run bench/fork/retention/refs-check.ts --file /private/grace.json [--group A|B]
// The file holds { runId, closedAt, refs: [{ group, ref }] } (grace-sample.ts writes it). Prints, per ref: the vault entry,
// the locator, the live row, the Qdrant point (live, tombstoned or absent) and the purge tombstone.
import { readFileSync } from "node:fs";
import { pointId } from "../../../src/fork/worker/qdrant.js";
import { itemKey } from "../../../src/fork/retention/scopes.js";
import type { ItemRef } from "../../../src/fork/retention/types.js";
import { arg, qdrant, redis, requireArg } from "./lib.js";

const file = JSON.parse(readFileSync(requireArg("file", "stage.sh run bench/fork/retention/refs-check.ts --file /private/grace.json [--group A|B]"), "utf8")) as { runId: string; refs: Array<{ group: string; ref: ItemRef }> };
const group = arg("group");
const r = await redis();
const rows = [];
for (const { group: g, ref } of file.refs.filter((x) => !group || x.group === group)) {
  const key = itemKey(ref);
  const live = await r.call("HEXISTS", ref.kind === "memory" ? "state:mem:memories" : `state:mem:obs:${ref.sessionId}`, ref.id);
  const vaulted = await r.call("HEXISTS", `state:mem:retention:vault:${file.runId}`, key);
  const located = await r.call("HEXISTS", "state:mem:retention:items", key);
  const tomb = await r.call("HEXISTS", "state:mem:retention:tombstones", key);
  const points = await qdrant<Array<{ payload?: { deleted?: boolean } }>>("POST", "/collections/agentmemory/points", { ids: [pointId(ref.id)], with_payload: ["deleted"], with_vector: false });
  const point = points[0] ? (points[0].payload?.deleted === true ? "tombstoned" : "live") : "absent";
  rows.push({ group: g, ref: key, liveRow: live === 1, inVault: vaulted === 1, locator: located === 1, purgeTombstone: tomb === 1, qdrantPoint: point });
}
r.close();
const runHeld = rows.filter((x) => x.inVault).length;
console.log(JSON.stringify({ runId: file.runId, checkedAt: new Date().toISOString(), inVault: runHeld, of: rows.length, rows }, null, 1));

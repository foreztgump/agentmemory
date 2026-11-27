// Pin on a real demoted memory (stage C), through the REST route. There is no embedding provider on this replica, so an
// embed attempt would fail loudly; the check is that the pin brings the memory back into Qdrant with its stored vector.
//   stage.sh run bench/fork/retention/pin.ts [--id mem_...] [--out /private/pin.json]
// Without --id it takes the first memory in mem:retention:demoted. Prints the memory's state before and after.
import { writeFileSync } from "node:fs";
import { pointId } from "../../../src/fork/worker/qdrant.js";
import { am, arg, qdrant, redis, text } from "./lib.js";

const r = await redis();
const demoted = (await r.call("HLEN", "state:mem:retention:demoted")) as number;
let id = arg("id");
if (!id) {
  const reply = (await r.call("HSCAN", "state:mem:retention:demoted", "0", "COUNT", "10")) as Array<any>;
  id = text(reply[1][0]);
}
const readMemory = async () => JSON.parse(text((await r.call("HGET", "state:mem:memories", id!)) as Buffer));
const point = async () => {
  const found = await qdrant<Array<{ payload?: { deleted?: boolean; dense?: boolean }; vector?: number[] }>>("POST", "/collections/agentmemory/points", {
    ids: [pointId(id!)], with_payload: ["deleted", "dense"], with_vector: true,
  });
  const p = found[0];
  return p ? { exists: true, deleted: p.payload?.deleted === true, dense: p.payload?.dense, vectorLength: Array.isArray(p.vector) ? p.vector.length : null, vector: p.vector } : { exists: false };
};
const recordRaw = await r.call("HGET", "state:mem:retention:demoted", id);
const record = recordRaw ? JSON.parse(text(recordRaw as Buffer)) : null;
const before = { memory: (({ id, title, retention }) => ({ id, title, retention }))(await readMemory()), qdrant: await point(), demoteRecord: record && { runId: record.runId, demotedAt: record.demotedAt, hasVector: Boolean(record.vector) } };
const res = await am("POST", "/agentmemory/retention/pin", { ref: { kind: "memory", id }, reason: "TEE-1158 slice 12 staging pin on a demoted memory", who: "staging" });
const afterPoint = await point();
const afterMemory = await readMemory();
const recordAfter = await r.call("HGET", "state:mem:retention:demoted", id);
// The stored vector (base64 float32) against the point's vector, which Qdrant keeps as normalised float16.
let vectorMatches: boolean | null = null;
if (record?.vector && afterPoint.exists && afterPoint.vector) {
  const buf = Buffer.from(record.vector, "base64");
  const stored = Array.from({ length: buf.length / 4 }, (_, i) => buf.readFloatLE(i * 4));
  const norm = Math.sqrt(stored.reduce((s, x) => s + x * x, 0)) || 1;
  const maxDiff = Math.max(...stored.map((x, i) => Math.abs(x / norm - afterPoint.vector![i]!)));
  vectorMatches = maxDiff < 1e-3;
}
const search = await am("POST", "/agentmemory/smart-search", { query: String(afterMemory.title).split(/\s+/).slice(0, 10).join(" "), limit: 10, includeLessons: false });
const found = (search.body?.results ?? []).findIndex((hit: { obsId: string }) => hit.obsId === id);
r.close();
const { vector: _b, ...afterQ } = afterPoint as Record<string, unknown>;
const { vector: _a, ...beforeQ } = before.qdrant as Record<string, unknown>;
const result = {
  demotedMemoriesBefore: demoted, id, pinStatus: res.status, pinResponse: res.body && { kind: res.body.kind, vaulted: res.body.vaulted, undemoted: res.body.undemoted },
  before: { ...before, qdrant: beforeQ },
  after: { retention: afterMemory.retention ?? null, qdrant: afterQ, demoteRecordGone: recordAfter === null, vectorMatchesStored: vectorMatches, searchRank: found >= 0 ? found + 1 : null },
  pass: res.status === 200 && res.body?.undemoted === true && afterPoint.exists && !(afterPoint as { deleted?: boolean }).deleted && recordAfter === null,
};
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
process.exit(result.pass ? 0 : 1);

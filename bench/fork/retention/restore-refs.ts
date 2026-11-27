// Restore by ref on a few items: takes N indexable stage O observations (a title and a narrative) from a run's vault, restores them by ref
// through the REST route, and reads each Qdrant point before and after. A restored row must be a live point again. When the vault
// entry kept a vector (it does only when the app has a vector store, which a keyword-only replica does not), the point must also be dense,
// with a vector equal to the stored one; no embedding provider is configured, so a vector can only come from the vault.
//   stage.sh run bench/fork/retention/restore-refs.ts --run ret_... [--n 3]
import { pointId } from "../../../src/fork/worker/qdrant.js";
import type { VaultEntry } from "../../../src/fork/retention/types.js";
import { am, arg, qdrant, redis, requireArg, sleep, text } from "./lib.js";

const runId = requireArg("run", "stage.sh run bench/fork/retention/restore-refs.ts --run ret_... [--n 3]");
const want = Number(arg("n", "3"));
const r = await redis();
const picked: VaultEntry[] = [];
let cursor = "0";
do {
  const reply = (await r.call("HSCAN", `state:mem:retention:vault:${runId}`, cursor, "COUNT", "500")) as Array<any>;
  cursor = text(reply[0]);
  const flat = reply[1] as Buffer[];
  for (let i = 0; i < flat.length && picked.length < want; i += 2) {
    const entry = JSON.parse(text(flat[i + 1]!)) as VaultEntry;
    if (entry.stage === "O" && entry.row.title && entry.row.narrative) picked.push(entry);
  }
} while (cursor !== "0" && picked.length < want);
r.close();
const point = async (id: string) => {
  const [p] = await qdrant<any[]>("POST", "/collections/agentmemory/points", { ids: [pointId(id)], with_payload: ["deleted", "dense"], with_vector: true });
  if (!p) return { exists: false };
  const dense = Array.isArray(p.vector) ? p.vector : p.vector?.[""] ?? p.vector?.dense;
  return { exists: true, deleted: p.payload?.deleted === true, dense: p.payload?.dense, vectorKeys: p.vector && !Array.isArray(p.vector) ? Object.keys(p.vector) : undefined, denseLength: dense?.length ?? null, vector: dense as number[] | undefined };
};
const before = await Promise.all(picked.map((e) => point(e.ref.id)));
const res = await am("POST", "/agentmemory/retention/restore", { refs: picked.map((e) => e.ref) });
await sleep(10_000);
const after = await Promise.all(picked.map((e) => point(e.ref.id)));
const rows = picked.map((entry, i) => {
  const buf = Buffer.from(entry.satellites?.vector ?? "", "base64");
  const stored = Array.from({ length: buf.length / 4 }, (_, k) => buf.readFloatLE(k * 4));
  const norm = Math.sqrt(stored.reduce((s, x) => s + x * x, 0)) || 1;
  const keptVector = Boolean(entry.satellites?.vector);
  const v = after[i]!.vector;
  const maxDiff = v && keptVector ? Math.max(...stored.map((x, k) => Math.abs(x / norm - v[k]!))) : null;
  const { vector: _b, ...b } = before[i]!;
  const { vector: _a, ...a } = after[i]!;
  return { ref: `${entry.ref.kind === "observation" ? entry.ref.sessionId + "/" : ""}${entry.ref.id}`, vaultKeptVector: keptVector, before: b, after: a, maxAbsDiffToStoredNormalised: maxDiff };
});
console.log(JSON.stringify({ restoreStatus: res.status, restore: res.body, rows, pass: rows.length > 0 && rows.every((x) => x.after.exists && !(x.after as { deleted?: boolean }).deleted && (!x.vaultKeptVector || ((x.after as { dense?: boolean }).dense === true && typeof x.maxAbsDiffToStoredNormalised === "number" && x.maxAbsDiffToStoredNormalised < 1e-3))) }, null, 1));

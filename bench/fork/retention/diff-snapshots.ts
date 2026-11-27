// Compares two snapshot.ts files: user scope families, bookkeeping families (mem:retention:*, mem:audit:*) and Qdrant counts.
//   stage.sh run bench/fork/retention/diff-snapshots.ts /private/before.json /private/after.json
import { readFileSync } from "node:fs";
import { isBookkeeping } from "./lib.js";

const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p!, "utf8")));
const user: Record<string, [number, number]> = {};
const book: Record<string, [number, number]> = {};
for (const family of new Set([...Object.keys(a.kv.records), ...Object.keys(b.kv.records)])) {
  const was = a.kv.records[family] ?? 0;
  const now = b.kv.records[family] ?? 0;
  if (was !== now) (isBookkeeping(family) ? book : user)[family] = [was, now];
}
const index: Record<string, unknown> = {};
for (const name of new Set([...Object.keys(a.search), ...Object.keys(b.search)])) {
  if (JSON.stringify(a.search[name]) !== JSON.stringify(b.search[name])) index[name] = { before: a.search[name], after: b.search[name] };
}
console.log(JSON.stringify({ userScopesChanged: user, bookkeepingChanged: book, indexChanged: index, identical: Object.keys(user).length === 0 && Object.keys(index).length === 0 }, null, 1));

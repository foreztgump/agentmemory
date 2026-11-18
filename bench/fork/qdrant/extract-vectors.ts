// Copies the stored vectors out of a Valkey restore into a private directory:
// `vectors.f32` (rows of float32) and `meta.jsonl` (one {id, layer} per row, same order).
// The output holds private embeddings: it refuses a path inside the repo.
//
//   node --import tsx bench/fork/qdrant/extract-vectors.ts --container <valkey> --out /home/cownose/am-staging/qdrant-spike/buddy
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { jsonValues } from "../lib/valkey.js";
import { assertOutsideRepo, DIMS, layerOfId } from "./lib.js";

const { values: args } = parseArgs({ options: { container: { type: "string" }, out: { type: "string" } } });
if (!args.container || !args.out) throw new Error("--container and --out are required");
const out = assertOutsideRepo(args.out);
mkdirSync(out, { recursive: true, mode: 0o700 });

const SCAN = 'valkey-cli --scan --pattern "state:mem:index:bm25:vec:*" | while read -r k; do valkey-cli --raw hvals "$k"; done';
const files = ["vectors.f32", "meta.jsonl"].map((name) => ({ tmp: `${out}/${name}.tmp`, final: `${out}/${name}` }));
const [vectors, meta] = files.map((f) => createWriteStream(f.tmp, { mode: 0o600 }));
const layers = new Map<string, number>();
let skipped = 0;
let rows = 0;
const closed = (stream: NodeJS.WritableStream) => new Promise<void>((r) => stream.end(r));
try {
  for await (const row of jsonValues(args.container, SCAN)) {
    const bytes = typeof row.e === "string" ? Buffer.from(row.e, "base64") : null;
    if (typeof row.id !== "string" || !bytes || bytes.byteLength !== DIMS * 4) {
      skipped++;
      continue;
    }
    const layer = layerOfId(row.id, typeof row.s === "string" ? row.s : "");
    layers.set(layer, (layers.get(layer) ?? 0) + 1);
    rows++;
    if (!vectors!.write(bytes)) await new Promise((r) => vectors!.once("drain", r));
    if (!meta!.write(JSON.stringify({ id: row.id, layer }) + "\n")) await new Promise((r) => meta!.once("drain", r));
  }
  await Promise.all([closed(vectors!), closed(meta!)]);
  if (rows === 0) throw new Error(`no vectors read from ${args.container}: is the store still loading?`);
  if (statSync(files[0]!.tmp).size !== rows * DIMS * 4) throw new Error(`vectors.f32 holds ${statSync(files[0]!.tmp).size} bytes, expected ${rows * DIMS * 4}`);
} catch (error) {
  vectors!.destroy();
  meta!.destroy();
  for (const f of files) rmSync(f.tmp, { force: true });
  throw error;
}
for (const f of files) renameSync(f.tmp, f.final);
console.log(JSON.stringify({ rows, layers: Object.fromEntries(layers), skipped }));

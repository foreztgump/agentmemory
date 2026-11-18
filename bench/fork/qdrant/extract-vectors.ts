// Copies the stored vectors out of a Valkey restore into a private directory:
// `vectors.f32` (rows of float32) and `meta.jsonl` (one {id, layer} per row, same order).
// The output holds private embeddings: it refuses a path inside the repo.
//
//   node --import tsx bench/fork/qdrant/extract-vectors.ts --container <valkey> --out /home/cownose/am-staging/qdrant-spike/buddy
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { jsonValues } from "../lib/valkey.js";
import { DIMS, layerOfId } from "./lib.js";

const { values: args } = parseArgs({ options: { container: { type: "string" }, out: { type: "string" } } });
if (!args.container || !args.out) throw new Error("--container and --out are required");
const out = resolve(args.out);
if (out.startsWith(resolve(import.meta.dirname, "../../.."))) throw new Error("--out must be outside the repo: the vectors are private");
mkdirSync(out, { recursive: true, mode: 0o700 });

const SCAN = 'valkey-cli --scan --pattern "state:mem:index:bm25:vec:*" | while read -r k; do valkey-cli --raw hvals "$k"; done';
const vectors = createWriteStream(`${out}/vectors.f32`, { mode: 0o600 });
const meta = createWriteStream(`${out}/meta.jsonl`, { mode: 0o600 });
const layers = new Map<string, number>();
let skipped = 0;
for await (const row of jsonValues(args.container, SCAN)) {
  const bytes = typeof row.e === "string" ? Buffer.from(row.e, "base64") : null;
  if (typeof row.id !== "string" || !bytes || bytes.byteLength !== DIMS * 4) {
    skipped++;
    continue;
  }
  const layer = layerOfId(row.id);
  layers.set(layer, (layers.get(layer) ?? 0) + 1);
  if (!vectors.write(bytes)) await new Promise((r) => vectors.once("drain", r));
  meta.write(JSON.stringify({ id: row.id, layer }) + "\n");
}
await Promise.all([new Promise((r) => vectors.end(r)), new Promise((r) => meta.end(r))]);
if (layers.size === 0) throw new Error(`no vectors read from ${args.container}: is the store still loading?`);
console.log(JSON.stringify({ rows: [...layers.values()].reduce((a, b) => a + b, 0), layers: Object.fromEntries(layers), skipped }));

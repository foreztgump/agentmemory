// Grows a replica's store in place so read timings can be taken at a multiple of today's size.
// Every state hash with at least --min fields gets (factor - 1) copies of each field, keyed
// "<field>~x<n>" with the same value. The copies are for timing reads only: the app must not
// write to a scaled store, and the replica is thrown away afterwards.
//
//   node --import tsx bench/fork/scale-store.ts --url redis://... --factor 3 [--min 1000]
import { parseArgs } from "node:util";
import { connectRedis, type Reply } from "../../scripts/fork/lib/resp.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    factor: { type: "string", default: "3" },
    min: { type: "string", default: "1000" },
  },
});
if (!args.url) throw new Error("--url is required");
const factor = Number(args.factor);
const min = Number(args.min);
if (!Number.isInteger(min) || min < 1) throw new Error("--min must be a positive integer");
if (!Number.isInteger(factor) || factor < 2) throw new Error("--factor must be an integer of at least 2");

const redis = await connectRedis(args.url);
const text = (reply: Reply) => (Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply));

const hashes: string[] = [];
let cursor = "0";
do {
  const [next, keys] = (await redis.call("SCAN", cursor, "MATCH", "state:*", "COUNT", "1000")) as [Buffer, Buffer[]];
  cursor = text(next);
  for (const key of keys) hashes.push(text(key));
} while (cursor !== "0");

for (const hash of hashes) {
  const fields = Number(await redis.call("HLEN", hash));
  if (fields < min) continue;
  let scan = "0";
  let written = 0;
  do {
    const [next, flat] = (await redis.call("HSCAN", hash, scan, "COUNT", "500")) as [Buffer, Buffer[]];
    scan = text(next);
    const originals: Buffer[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      if (!/~x\d+$/.test(text(flat[i]!))) originals.push(flat[i]!, flat[i + 1]!);
    }
    if (!originals.length) continue;
    const args: Array<string | Buffer> = ["HSET", hash];
    for (let copy = 2; copy <= factor; copy++) {
      for (let i = 0; i < originals.length; i += 2) args.push(`${text(originals[i]!)}~x${copy}`, originals[i + 1]!);
    }
    await redis.call(...args);
    written += (args.length - 2) / 2;
  } while (scan !== "0");
  console.log(`${hash} ${fields} -> ${Number(await redis.call("HLEN", hash))} (+${written})`);
}
redis.close();

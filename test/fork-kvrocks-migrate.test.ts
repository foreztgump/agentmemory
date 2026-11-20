import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { batches, copy, family, isSampled, MARKER_KEY, MigrateError, verify } from "../scripts/fork/kvrocks-migrate.js";
import { connectRedis, encodeCommand, parseReply, RespError, type Arg, type Redis, type Reply } from "../scripts/fork/lib/resp.js";
import { FakeRedis, k, type Store } from "./helpers/fake-redis.js";

function sourceStore(): Store {
  const store: Store = new Map();
  const obs = new Map<string, Buffer>();
  for (let i = 0; i < 523; i++) obs.set(`obs_${i}`, Buffer.from(JSON.stringify({ id: `obs_${i}`, narrative: `n${i} ü 🦀` })));
  store.set("state:mem:obs:ses_1", obs);
  store.set("state:mem:index:bm25:vec:0000", new Map([["obs_1", Buffer.from([0, 255, 13, 10, 0x80, 0xfe])], ["obs_2", Buffer.alloc(5 * 1024 * 1024, 7)]]));
  store.set("state:mem:graph:nodes", new Map([["n1", Buffer.from("{\"a\":[]}")]]));
  store.set("stream:mem-live:viewer", new Map([["x", Buffer.from("1")]]));
  return store;
}

const options = { page: 50, batchBytes: 64 * 1024, log: () => {} };
const snapshot = (s: Store) => [...s.entries()].filter(([key]) => key !== MARKER_KEY).map(([key, h]) => [key, [...h.entries()].map(([f, v]) => [f, v.toString("hex")]).sort()]).sort();

describe("kvrocks migration", () => {
  it("copies every hash byte for byte in pages, never reading a whole hash", async () => {
    const source = new FakeRedis(sourceStore());
    const target = new FakeRedis(new Map(), "kv");
    const result = await copy(source, target, options);
    expect(result).toMatchObject({ collections: 4, fields: 523 + 2 + 1 + 1, skipped: 0 });
    expect(snapshot(target.data)).toEqual(snapshot(source.data));
    for (const log of [source.log, target.log]) expect(log.filter((c) => ["HGETALL", "HKEYS", "HVALS", "KEYS", "DUMP"].includes(c))).toEqual([]);
    expect((await verify(source, target, { page: 50, rate: 4, full: false })).ok).toBe(true);
  });

  it("converges to the same end state after a kill at any write, with no duplicates", async () => {
    const expected = snapshot(sourceStore());
    const clean = new FakeRedis(new Map(), "kv");
    await copy(new FakeRedis(sourceStore()), clean, options);
    const writes = clean.log.filter((c) => c === "HSET").length;
    expect(writes).toBeGreaterThan(20);
    for (let killAt = 0; killAt < writes; killAt++) {
      const source = new FakeRedis(sourceStore());
      const target = new FakeRedis(new Map(), "kv");
      target.writesBeforeKill = killAt;
      await expect(copy(source, target, options)).rejects.toThrow("killed");
      target.writesBeforeKill = 5;
      await copy(source, target, options).catch((e) => expect(e.message).toBe("killed"));
      target.writesBeforeKill = Infinity;
      await copy(source, target, options);
      expect(snapshot(target.data)).toEqual(expected);
      expect((await verify(source, target, { page: 50, rate: 1, full: true })).ok).toBe(true);
    }
  });

  it("restarts unfinished hashes from cursor 0 when the source restarted", async () => {
    const source = new FakeRedis(sourceStore());
    const target = new FakeRedis(new Map(), "kv");
    target.writesBeforeKill = 4;
    await expect(copy(source, target, options)).rejects.toThrow("killed");
    target.writesBeforeKill = Infinity;
    source.runId = "run-b";
    const logs: string[] = [];
    await copy(source, target, { ...options, log: (l) => logs.push(l) });
    expect(logs.join("\n")).toContain("cursor 0");
    expect(snapshot(target.data)).toEqual(snapshot(source.data));
  });

  // Kvrocks 2.17.0 INFO has no run_id (checked live); Valkey, the source, does. If the source ever
  // lacked it, a wiped target must still be copied in full, since resume state lives in the target.
  it("copies everything into a wiped target even when INFO has no run_id", async () => {
    const source = new FakeRedis(sourceStore(), "");
    const target = new FakeRedis(new Map(), "");
    target.writesBeforeKill = 6;
    await expect(copy(source, target, options)).rejects.toThrow("killed");
    const wiped = new FakeRedis(new Map(), "");
    const result = await copy(source, wiped, options);
    expect(result.skipped).toBe(0);
    expect(snapshot(wiped.data)).toEqual(snapshot(source.data));
    expect((await verify(source, wiped, { page: 50, rate: 1, full: true })).ok).toBe(true);
  });

  it("refuses a target that holds data but no migration marker", async () => {
    const target = new FakeRedis(new Map([["state:mem:sessions", new Map([["s", Buffer.from("{}")]])]]));
    const error = await copy(new FakeRedis(sourceStore()), target, options).catch((e) => e);
    expect(error).toBeInstanceOf(MigrateError);
    expect(error.exitCode).toBe(3);
  });

  it("refuses a source key that is not a hash", async () => {
    const source = new FakeRedis(sourceStore(), "run-a", new Map([["stream:mem-live:viewer", "stream"]]));
    await expect(copy(source, new FakeRedis(), options)).rejects.toThrow(/not a hash/);
  });

  it("reports a flipped byte, a missing record and an extra collection", async () => {
    const source = new FakeRedis(sourceStore());
    const target = new FakeRedis(new Map(), "kv");
    await copy(source, target, options);
    const clean = await verify(source, target, { page: 50, rate: 1, full: true });
    expect(clean.families.every((f) => f.sourceChecksum === f.targetChecksum)).toBe(true);

    target.data.get("state:mem:index:bm25:vec:0000")!.get("obs_1")![0] = 1;
    const flipped = await verify(source, target, { page: 50, rate: 1, full: true });
    expect(flipped.ok).toBe(false);
    expect(flipped.valueMismatches).toBe(1);
    expect(flipped.families.find((f) => f.family === "mem:index:bm25:vec:<bucket>")!.ok).toBe(false);

    target.data.get("state:mem:index:bm25:vec:0000")!.get("obs_1")![0] = 0;
    target.data.get("state:mem:obs:ses_1")!.delete("obs_7");
    target.data.set("state:mem:extra", new Map([["a", Buffer.from("1")]]));
    const broken = await verify(source, target, { page: 50, rate: 1, full: true });
    expect(broken.ok).toBe(false);
    expect(broken.countMismatches).toEqual(["state:mem:obs:ses_1: source 523, target 522"]);
    expect(broken.extraKeys).toEqual(["state:mem:extra"]);
  });

  it("fails verify while copy has not finished, even when the copied part matches", async () => {
    const source = new FakeRedis(sourceStore());
    const target = new FakeRedis(new Map(), "kv");
    await copy(source, target, options);
    const [someKey] = [...target.data.keys()].filter((key) => key !== MARKER_KEY);
    target.data.get(MARKER_KEY)!.set(`cursor:${someKey}`, Buffer.from("0"));
    const result = await verify(source, target, { page: 50, rate: 1, full: true });
    expect(result.incomplete).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("samples the same fields on every run", () => {
    const fields = Array.from({ length: 2000 }, (_, i) => Buffer.from(`obs_${i}`));
    const picked = fields.filter((f) => isSampled("state:mem:obs:s", f, 32));
    expect(picked.length).toBeGreaterThan(30);
    expect(picked.length).toBeLessThan(100);
    expect(fields.filter((f) => isSampled("state:mem:obs:s", f, 32))).toEqual(picked);
  });

  it("splits HSET pages by bytes and sends an oversized value alone", () => {
    const b = (n: number) => Buffer.alloc(n);
    const out = batches([b(1), b(10), b(1), b(10), b(1), b(100), b(1), b(5)], 30);
    expect(out.map((x) => x.length / 2)).toEqual([2, 1, 1]);
  });

  it("names collection families like replica.sh counts", () => {
    expect(family("state:mem:obs:ses_9")).toBe("mem:obs:<session>");
    expect(family("state:mem:index:bm25:vec:0042")).toBe("mem:index:bm25:vec:<bucket>");
    expect(family("state:mem:audit:2026-11")).toBe("mem:audit:<month>");
    expect(family("state:mem:memories")).toBe("mem:memories");
    expect(family("stream:mem-live:viewer")).toBe("stream:mem-live:viewer");
    expect(family("state:mem:enriched:ses_9")).toBe("mem:enriched:<session>");
    expect(family("state:mem:latent:obs_9")).toBe("mem:latent:<obs>");
    expect(family("state:mem:team:t1:shared")).toBe("mem:team:<team>:shared");
    expect(family("state:mem:team:t1:users:u7")).toBe("mem:team:<team>:users:<user>");
  });
});

describe("RESP client", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("parses binary bulk strings, nulls, integers, nested arrays and partial frames", () => {
    const frame = Buffer.concat([Buffer.from("*4\r\n$3\r\n"), Buffer.from([0, 0xff, 10]), Buffer.from("\r\n$-1\r\n:42\r\n*1\r\n+OK\r\n")]);
    for (let cut = 1; cut < frame.length; cut++) expect(parseReply(frame.subarray(0, cut), 0)).toBeNull();
    const parsed = parseReply(frame, 0)!;
    expect(parsed.end).toBe(frame.length);
    expect(parsed.value).toEqual([Buffer.from([0, 0xff, 10]), null, 42, [Buffer.from("OK")]]);
    expect(parseReply(Buffer.from("-ERR nope\r\n"), 0)!.value).toBeInstanceOf(RespError);
    expect(() => parseReply(Buffer.from("$x\r\nabc\r\n"), 0)).toThrow(/malformed/);
    expect(() => parseReply(Buffer.from("*?\r\n"), 0)).toThrow(/malformed/);
  });

  it("authenticates, pipelines over split chunks and rejects server errors", async () => {
    const seen: string[] = [];
    server = createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const parsed = parseReply(pending, 0);
          if (!parsed) break;
          pending = pending.subarray(parsed.end);
          const [cmd, ...rest] = (parsed.value as Buffer[]).map((b) => b.toString("latin1"));
          seen.push([cmd, ...rest].join(" "));
          const reply = cmd === "BAD" ? Buffer.from("-ERR bad\r\n") : encodeCommand([Buffer.from(rest[0] ?? "OK", "latin1")]);
          for (const byte of reply) socket.write(Buffer.from([byte]));
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const redis = await connectRedis(`redis://:p%40ss@127.0.0.1:${port}`);
    const replies = await redis.pipeline([["ECHO", Buffer.from([0xfe, 0, 13, 10])], ["ECHO", "two"]]);
    expect(replies).toEqual([[Buffer.from([0xfe, 0, 13, 10])], [Buffer.from("two")]]);
    await expect(redis.call("BAD")).rejects.toThrow("ERR bad");
    redis.close();
    expect(seen[0]).toBe("AUTH p@ss");
  });
});

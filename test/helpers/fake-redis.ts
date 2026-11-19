import type { Arg, Redis, Reply } from "../../scripts/fork/lib/resp.js";

export type Store = Map<string, Map<string, Buffer>>;
export const k = (b: Arg) => (typeof b === "string" ? b : b.toString("latin1"));

/** An in-memory stand-in for the commands the fork migration tools send. */
export class FakeRedis implements Redis {
  log: string[] = [];
  writesBeforeKill = Infinity;
  constructor(public data: Store = new Map(), public runId = "run-a", public types = new Map<string, string>()) {}

  async call(...args: Arg[]): Promise<Reply> {
    const [cmd, ...rest] = args.map(k);
    const name = cmd!.toUpperCase();
    this.log.push(name);
    const hash = (key: string) => this.data.get(key);
    switch (name) {
      case "SCAN": {
        const m = rest.indexOf("MATCH");
        const pattern = m >= 0 ? new RegExp(`^${rest[m + 1]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`) : null;
        const keys = [...this.data.keys()].filter((key) => !pattern || pattern.test(key)).sort();
        const at = Number(rest[0]);
        const count = countOf(rest);
        const next = at + count >= keys.length ? 0 : at + count;
        return [Buffer.from(String(next)), keys.slice(at, at + count).map((x) => Buffer.from(x, "latin1"))];
      }
      case "TYPE": return Buffer.from(this.types.get(rest[0]!) ?? (this.data.has(rest[0]!) ? "hash" : "none"));
      case "PTTL": return this.data.has(rest[0]!) ? -1 : -2;
      case "INFO": return Buffer.from(`# Server\r\nrun_id:${this.runId}\r\n`);
      case "HLEN": return hash(rest[0]!)?.size ?? 0;
      case "HEXISTS": return hash(rest[0]!)?.has(rest[1]!) ? 1 : 0;
      case "HGET": return hash(rest[0]!)?.get(rest[1]!) ?? null;
      case "HMGET": return rest.slice(1).map((f) => hash(rest[0]!)?.get(f) ?? null);
      case "HSET": {
        if (this.writesBeforeKill-- <= 0) throw new Error("killed");
        let h = hash(rest[0]!);
        if (!h) this.data.set(rest[0]!, (h = new Map()));
        for (let i = 2; i < args.length; i += 2) h.set(k(args[i]!), Buffer.from(args[i + 1] as Buffer));
        return 1;
      }
      case "HSCAN": {
        const fields = [...(hash(rest[0]!)?.entries() ?? [])];
        const at = Number(rest[1]);
        const count = countOf(rest);
        const next = at + count >= fields.length ? 0 : at + count;
        return [Buffer.from(String(next)), fields.slice(at, at + count).flatMap(([f, v]) => [Buffer.from(f, "latin1"), v])];
      }
      default: throw new Error(`fake does not implement ${name}`);
    }
  }

  async pipeline(commands: Arg[][]): Promise<Reply[]> {
    const out: Reply[] = [];
    for (const c of commands) out.push(await this.call(...c));
    return out;
  }

  close(): void {}
}

function countOf(args: string[]): number {
  const at = args.indexOf("COUNT");
  const count = at >= 0 ? Number(args[at + 1]) : NaN;
  if (!Number.isInteger(count) || count < 1) throw new Error("fake redis: SCAN and HSCAN need COUNT <positive integer>");
  return count;
}

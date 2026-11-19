// A byte-safe RESP2 client over node:net, for fork tools that read or copy the
// iii redis adapter's store directly. Bulk strings come back as Buffers and are
// never decoded, so a copy is byte for byte. Server errors reject the call.
import { connect as netConnect, type Socket } from "node:net";

export type Arg = string | Buffer;
export type Reply = Buffer | number | null | Reply[];

export class RespError extends Error {}

export interface Redis {
  call(...args: Arg[]): Promise<Reply>;
  pipeline(commands: Arg[][]): Promise<Reply[]>;
  close(): void;
}

type Parsed = { value: Reply | RespError; end: number } | null;

export function parseReply(buffer: Buffer, start: number): Parsed {
  const lineEnd = buffer.indexOf("\r\n", start);
  if (lineEnd < 0) return null;
  const type = buffer[start];
  const line = buffer.toString("latin1", start + 1, lineEnd);
  const next = lineEnd + 2;
  switch (type) {
    case 0x2b: return { value: Buffer.from(line, "latin1"), end: next };
    case 0x2d: return { value: new RespError(line), end: next };
    case 0x3a: return { value: Number(line), end: next };
    case 0x24: {
      const length = Number(line);
      if (!Number.isInteger(length)) throw new Error(`malformed RESP bulk length ${JSON.stringify(line)}`);
      if (length < 0) return { value: null, end: next };
      if (buffer.length < next + length + 2) return null;
      return { value: buffer.subarray(next, next + length), end: next + length + 2 };
    }
    case 0x2a: {
      const count = Number(line);
      if (!Number.isInteger(count)) throw new Error(`malformed RESP array length ${JSON.stringify(line)}`);
      if (count < 0) return { value: null, end: next };
      const items: Reply[] = [];
      let at = next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buffer, at);
        if (!item) return null;
        if (item.value instanceof RespError) throw item.value;
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    default:
      throw new Error(`unexpected RESP type byte ${type}`);
  }
}

export function encodeCommand(args: Arg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = typeof arg === "string" ? Buffer.from(arg) : arg;
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

class Connection implements Redis {
  private chunks: Buffer[] = [];
  private waiting: Array<(reply: Reply | Error) => void> = [];
  private failure: Error | null = null;

  constructor(private socket: Socket, timeoutMs: number) {
    const fail = (error: Error) => {
      this.failure ??= error;
      for (const settle of this.waiting.splice(0)) settle(this.failure);
    };
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`redis reply timed out after ${timeoutMs} ms`)));
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("redis connection closed")));
    socket.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      let buffer = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
      let at = 0;
      for (;;) {
        let parsed: Parsed;
        try {
          parsed = parseReply(buffer, at);
        } catch (error) {
          if (error instanceof RespError) {
            fail(new Error(`redis error inside a reply: ${error.message}`));
          } else {
            fail(error as Error);
          }
          socket.destroy();
          return;
        }
        if (!parsed) break;
        at = parsed.end;
        this.waiting.shift()?.(parsed.value);
      }
      buffer = buffer.subarray(at);
      this.chunks = buffer.length ? [buffer] : [];
    });
  }

  call(...args: Arg[]): Promise<Reply> {
    return this.pipeline([args]).then((replies) => replies[0]!);
  }

  pipeline(commands: Arg[][]): Promise<Reply[]> {
    if (this.failure) return Promise.reject(this.failure);
    const replies = commands.map(() => new Promise<Reply>((resolve, reject) => {
      this.waiting.push((reply) => (reply instanceof Error ? reject(reply) : resolve(reply)));
    }));
    this.socket.write(Buffer.concat(commands.map(encodeCommand)));
    return Promise.all(replies);
  }

  close(): void {
    this.socket.end();
  }
}

export async function connectRedis(url: string, timeoutMs = 60_000): Promise<Redis> {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:") throw new Error(`only redis:// URLs are supported, got ${parsed.protocol}`);
  if (parsed.pathname && parsed.pathname !== "/" && parsed.pathname !== "/0") throw new Error("only database 0 is supported");
  const socket = netConnect(Number(parsed.port || 6379), parsed.hostname.replace(/^\[|\]$/g, ""));
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const client = new Connection(socket, timeoutMs);
  if (parsed.password) {
    await client.call(...(parsed.username
      ? ["AUTH", decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)]
      : ["AUTH", decodeURIComponent(parsed.password)]));
  }
  return client;
}

/** The URL with any password replaced, for log lines. */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "***";
  return parsed.toString();
}

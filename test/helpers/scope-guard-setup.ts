import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

// Does nothing unless AGENTMEMORY_SCOPE_GUARD is throw or refuse (npm run test:scope-guard). Then a
// whole read reached from src/ code is checked by assertWholeReadAllowed. A read from a test, which
// lists its own fixtures, is not. Inline KV doubles that a test file defines for itself are not covered.

const mode = (process.env.AGENTMEMORY_SCOPE_GUARD ?? "").trim().toLowerCase();

if (mode === "throw" || mode === "refuse") {
  const [{ StateKV }, { assertWholeReadAllowed }, { onMockKvList }] = await Promise.all([
    import("../../src/state/kv.js"),
    import("../../src/fork/scope-guard.js"),
    import("./mocks.js"),
  ]);
  type Op = "list" | "listKeys" | "iterate" | "listPage";

  const here = fileURLToPath(import.meta.url);
  const root = dirname(dirname(dirname(here)));
  const srcDir = join(root, "src") + sep;
  const kvLayer = new Set([
    here,
    join(root, "src/state/kv.ts"),
    join(root, "src/fork/scope-guard.ts"),
    join(root, "src/fork/kv/paged-scan.ts"),
    join(root, "test/helpers/mocks.ts"),
  ]);
  const refusals: string[] = [];

  const frameFile = (line: string) => line.match(/\(?(?:file:\/\/)?(\/[^():]+):\d+:\d+\)?$/)?.[1];

  function readFromSrc(): { fromSrc: boolean; viaCollectAll: boolean } {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    const stack = new Error().stack ?? "";
    Error.stackTraceLimit = limit;
    let viaCollectAll = false;
    for (const line of stack.split("\n").slice(1)) {
      const file = frameFile(line);
      if (!file || file.includes(`${sep}node_modules${sep}`)) continue;
      if (kvLayer.has(file)) {
        viaCollectAll ||= /\b(collectAll|scanRows|countRows|collectWhere)\b/.test(line);
        continue;
      }
      return { fromSrc: file.startsWith(srcDir), viaCollectAll };
    }
    return { fromSrc: false, viaCollectAll };
  }

  // collectAll and the paged-scan helpers page through iterate. They fall back to list or listKeys only
  // on a double that has no iterate, which the real StateKV never is, so that fallback counts as a paged read.
  function refusalFor(scope: string, op: Op): Error | undefined {
    const { fromSrc, viaCollectAll } = readFromSrc();
    if (!fromSrc) return undefined;
    try {
      assertWholeReadAllowed(scope, viaCollectAll ? "iterate" : op);
    } catch (error) {
      refusals.push((error as Error).message);
      return error as Error;
    }
    return undefined;
  }

  for (const op of ["list", "listKeys", "iterate", "listPage"] as const) {
    const original = StateKV.prototype[op] as (this: unknown, ...args: unknown[]) => unknown;
    Object.defineProperty(StateKV.prototype, op, {
      configurable: true,
      writable: true,
      value: function (this: unknown, scope: string, ...rest: unknown[]) {
        const refused = refusalFor(scope, op);
        if (refused) {
          return op === "iterate"
            ? (async function* () {
                throw refused;
              })()
            : Promise.reject(refused);
        }
        return original.call(this, scope, ...rest);
      },
    });
  }

  onMockKvList((scope) => {
    const refused = refusalFor(scope, "list");
    if (refused) throw refused;
  });

  afterEach(() => {
    if (refusals.length === 0) return;
    const seen = [...new Set(refusals)];
    refusals.length = 0;
    throw new Error(`the scope guard refused a whole read from src/ during this test, even if the code swallowed it:\n${seen.join("\n")}`);
  });
}

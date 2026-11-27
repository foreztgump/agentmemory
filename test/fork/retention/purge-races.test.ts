// Slice 7: purge against a concurrent restore and a concurrent sweep. Each race is forced with a KV proxy that pauses or acts at one read.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { restoreRun } from "../../../src/fork/retention/restore.js";
import { RETENTION_KV } from "../../../src/fork/retention/scopes.js";
import type { ItemRef, RunId } from "../../../src/fork/retention/types.js";
import { resetSummarizeVeto } from "../../../src/fork/retention/veto.js";
import type { StateKV } from "../../../src/state/kv.js";
import { KV } from "../../../src/state/schema.js";
import { candidate, observation, rig, seedObservation, seedSeal, type Rig } from "./move-fixtures.js";
import { at, clocked, closedRun, done, purge } from "./purge-fixtures.js";

const A = "ret_a" as RunId;
const obs = (sessionId: string, id: string): ItemRef => ({ kind: "observation", sessionId, id });

afterEach(() => {
  resetSummarizeVeto();
  vi.restoreAllMocks();
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** The same KV, except that `method` runs `hook` first. */
function hooked(kv: StateKV, method: "get" | "iterate", hook: (scope: string, keyOrOpts: unknown) => Promise<void> | void): StateKV {
  return new Proxy(kv, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== method) return typeof value === "function" ? value.bind(target) : value;
      if (method === "get") {
        return async (scope: string, key: string) => {
          await hook(scope, key);
          return target.get(scope, key);
        };
      }
      return async function* (scope: string, opts: unknown) {
        for await (const page of (target.iterate as (s: string, o: unknown) => AsyncIterable<unknown>)(scope, opts)) {
          await hook(scope, opts);
          yield page;
        }
      };
    },
  }) as StateKV;
}

async function moved(r: Rig, ids: readonly string[], session: string): Promise<void> {
  const rows = [];
  for (const [n, id] of ids.entries()) rows.push(await seedObservation(r, observation(id, session), { seed: n + 1 }));
  const seal = await seedSeal(r, session, rows.length);
  await closedRun(r, A, await Promise.all(rows.map((row) => candidate(r, "O", row, seal))));
}

describe("a restore by run that read its page before a purge finished the entry", () => {
  it("restores nothing and leaves the purged row gone", async () => {
    const r = rig();
    const { clock, deps } = clocked(r);
    await moved(r, ["p1"], "ses_p");
    clock.now = at(25);
    const pageRead = gate();
    const resume = gate();
    const pausing = hooked(deps.kv, "iterate", async (scope) => {
      if (scope !== RETENTION_KV.vault(A)) return;
      pageRead.open();
      await resume.promise;
    });
    const restoring = restoreRun({ ...deps, kv: pausing }, A, "owner asked");
    await pageRead.promise;
    expect(done(await purge(deps))).toMatchObject({ purged: 1, runsEmptied: 1 });
    resume.open();

    expect(await restoring).toEqual({ restored: 0, keptLive: 0, reembedNeeded: 0, deferred: 0 });
    expect(await r.kv.get(KV.observations("ses_p"), "p1")).toBeNull();
    expect(r.runtime.keyword.has("p1")).toBe(false);
    expect(await r.kv.listKeys(RETENTION_KV.vault(A))).toEqual([]);
    expect(await r.kv.listKeys(RETENTION_KV.items)).toEqual([]);
    expect(await r.runs.get(A)).toMatchObject({ held: 0, purgedAt: at(25).toISOString() });
  });
});

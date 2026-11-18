import { describe, expect, it } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

const refuseOn = ["throw", "refuse"].includes((process.env.AGENTMEMORY_SCOPE_GUARD ?? "").trim().toLowerCase());

describe.skipIf(!refuseOn)("suite run with the scope guard on", () => {
  it("lets a test list its own fixtures through StateKV and the shared double", async () => {
    const sdk = { trigger: async () => [] } as never;
    const kv = new StateKV(sdk);
    await expect(kv.list(KV.sessions)).resolves.toEqual([]);
    await expect(kv.list(KV.graphControl)).resolves.toEqual([]);
    await expect(kv.listPage(KV.graphControl, { limit: 1 })).resolves.toMatchObject({ items: [] });
    await expect(mockKV().list(KV.sessions)).resolves.toEqual([]);
  });
});

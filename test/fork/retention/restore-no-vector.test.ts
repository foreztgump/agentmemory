import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { displace } from "../../../src/fork/retention/move.js";
import { restoreRun } from "../../../src/fork/retention/restore.js";
import { lookupObservationSession } from "../../../src/state/obs-index.js";
import { KV } from "../../../src/state/schema.js";
import type { Session } from "../../../src/types.js";
import { candidate, observation, openRun, RUN, rig, seedObservation, seedSeal } from "./move-fixtures.js";

describe("restore of an item with no stored vector", () => {
  it("still re-attaches the observation-session index, the capture event and the session count, and reports the re-embed", async () => {
    const r = rig();
    await openRun(r);
    const row = await seedObservation(r, observation("obs_1"), { seed: undefined });
    await seedObservation(r, observation("obs_2"), { seed: undefined });
    const seal = await seedSeal(r, "ses_1", 2);
    expect((await displace(r.deps, r.vault, RUN, await candidate(r, "O", row, seal))).moved).toBe(true);
    expect(await lookupObservationSession(r.kv, "obs_1")).toBeNull();
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(1);

    const result = await restoreRun(r.deps, RUN, "test");
    expect(result).toMatchObject({ restored: 1, reembedNeeded: 1 });
    expect(await lookupObservationSession(r.kv, "obs_1")).toBe("ses_1");
    expect((await r.kv.get<Session>(KV.sessions, "ses_1"))!.observationCount).toBe(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";
import type { StatsResult } from "../src/fork/search/protocol.js";
import { DiskBackendService } from "../src/fork/search/service.js";

const stats = (rankingReady: boolean): StatsResult => ({ docs: 1, vectors: 0, memories: 0, lessons: 0, missingVectors: 0, rankingReady });

function serviceWith(statsCalls: () => Promise<StatsResult>): DiskBackendService {
  return new DiskBackendService({ client: { stats: statsCalls } } as never);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ranking readiness failures", () => {
  it("retries failed stats calls until ranking is ready without warning", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const calls = vi.fn<() => Promise<StatsResult>>()
      .mockRejectedValueOnce(new Error("worker restarting"))
      .mockResolvedValueOnce(stats(false))
      .mockResolvedValue(stats(true));
    const pending = serviceWith(calls).whenRankingReady(100, 10);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(calls).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns once and completes at the deadline when stats keeps failing", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const calls = vi.fn(async () => { throw new Error("worker unavailable"); });
    const pending = serviceWith(calls).whenRankingReady(50, 5);
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(calls.mock.calls.length).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ lastError: "worker unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unanswered stats call even when the poll interval is longer", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const calls = vi.fn(() => new Promise<StatsResult>(() => {}));
    let done = false;
    const pending = serviceWith(calls).whenRankingReady(50, 500).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

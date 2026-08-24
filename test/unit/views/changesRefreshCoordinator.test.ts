import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BootstrapPostGuard,
  ChangesRefreshCoordinator,
  type ChangesRefreshBatch,
} from "../../../src/views/changesRefreshCoordinator.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ChangesRefreshCoordinator", () => {
  it("does not rediscover for an 8-open + 18-state startup storm when the completed topology matches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runs: ChangesRefreshBatch[] = [];
    const completions: Array<ReturnType<typeof deferred>> = [];
    const coordinator = coordinatorFor(runs, completions);

    coordinator.request({ reason: "activation", rediscover: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toHaveLength(1);

    const materialStateChanged = false;
    for (let index = 0; index < 8; index += 1) {
      coordinator.request({
        reason: "repository opened",
        shouldRediscover: () => materialStateChanged,
      });
    }
    for (let index = 0; index < 18; index += 1) {
      coordinator.request({
        reason: "Git state event",
        shouldRediscover: () => materialStateChanged,
      });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.hasFollowUp()).toBe(true);

    completions[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.reason).toBe("8 repositories opened + 18 Git state events");
    expect(runs[1]?.rediscover).toBe(false);
    expect(runs.filter((run) => run.rediscover)).toHaveLength(1);

    completions[1]?.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toHaveLength(2);
    coordinator.dispose();
  });

  it("allows one bootstrap publication before the first final", () => {
    const guard = new BootstrapPostGuard();

    expect(guard.claim()).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      expect(guard.claim()).toBe(false);
    }
  });

  it("keeps overlay-only Git state batches on the cached topology", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runs: ChangesRefreshBatch[] = [];
    const completions: Array<ReturnType<typeof deferred>> = [];
    const coordinator = coordinatorFor(runs, completions);

    coordinator.request({ reason: "Git state event", rediscover: false });
    await vi.advanceTimersByTimeAsync(250);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.rediscover).toBe(false);
    completions[0]?.resolve();
    coordinator.dispose();
  });

  it("turns material events during discovery into exactly one follow-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runs: ChangesRefreshBatch[] = [];
    const completions: Array<ReturnType<typeof deferred>> = [];
    const coordinator = coordinatorFor(runs, completions);

    coordinator.request({ reason: "activation", rediscover: true });
    await vi.advanceTimersByTimeAsync(250);
    coordinator.request({ reason: "workspace folders changed", rediscover: true });
    coordinator.request({ reason: "workspace folders changed", rediscover: true });
    coordinator.request({ reason: "workspace folders changed", rediscover: true });

    completions[0]?.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.rediscover).toBe(true);
    expect(runs[1]?.inFlightWaitMs).toBeGreaterThanOrEqual(0);

    coordinator.request({ reason: "Git state event", rediscover: false });
    expect(runs[1]?.hasFollowUp()).toBe(false);
    completions[1]?.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toHaveLength(2);
    coordinator.dispose();
  });

  it("keeps stage post-action and Git events overlay-only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runs: ChangesRefreshBatch[] = [];
    const completions: Array<ReturnType<typeof deferred>> = [];
    const coordinator = coordinatorFor(runs, completions);

    coordinator.request({ reason: "Git state event", shouldRediscover: () => false });
    coordinator.request({ reason: "Git state event", shouldRediscover: () => false });
    coordinator.request({ reason: "post-action overlay", shouldRediscover: () => false });
    await vi.advanceTimersByTimeAsync(300);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.rediscover).toBe(false);
    expect(runs[0]?.reason).toBe("2 Git state events + post-action overlay");
    completions[0]?.resolve();
    coordinator.dispose();
  });

  it("coalesces checkout or unknown-repository material state into one discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runs: ChangesRefreshBatch[] = [];
    const completions: Array<ReturnType<typeof deferred>> = [];
    const coordinator = coordinatorFor(runs, completions);

    coordinator.request({ reason: "Git state event", shouldRediscover: () => true });
    coordinator.request({ reason: "repository opened", shouldRediscover: () => true });
    await vi.advanceTimersByTimeAsync(300);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.rediscover).toBe(true);
    completions[0]?.resolve();
    coordinator.dispose();
  });

  it("runs explicit refresh as one immediate discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runs: ChangesRefreshBatch[] = [];
    const completions: Array<ReturnType<typeof deferred>> = [];
    const coordinator = coordinatorFor(runs, completions);

    coordinator.request({ reason: "explicit refresh", rediscover: true, immediate: true });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.rediscover).toBe(true);
    completions[0]?.resolve();
    coordinator.dispose();
  });

  it("starts at max wait even when events never become quiet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runs: ChangesRefreshBatch[] = [];
    const completions: Array<ReturnType<typeof deferred>> = [];
    const coordinator = coordinatorFor(runs, completions);

    for (let elapsed = 0; elapsed < 1_000; elapsed += 100) {
      coordinator.request({ reason: "Git state event", rediscover: false });
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(runs).toHaveLength(1);
    expect(runs[0]?.startedAt - runs[0]!.requestedAt).toBe(1_000);
    expect(runs[0]?.eventCounts.get("Git state event")).toBe(10);
    completions[0]?.resolve();
    coordinator.dispose();
  });
});

function coordinatorFor(
  runs: ChangesRefreshBatch[],
  completions: Array<ReturnType<typeof deferred>>,
): ChangesRefreshCoordinator {
  return new ChangesRefreshCoordinator(
    async (batch) => {
      runs.push(batch);
      const completion = deferred();
      completions.push(completion);
      await completion.promise;
    },
    { now: () => Date.now() },
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

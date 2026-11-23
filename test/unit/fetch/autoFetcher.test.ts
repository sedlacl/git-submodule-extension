import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoFetcher, type AutoFetchSettings } from "../../../src/fetch/autoFetcher.js";
import type { GitRunOptions } from "../../../src/git/gitCli.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AutoFetcher", () => {
  it("waits for the startup delay, then fetches every repository once per period", async () => {
    vi.useFakeTimers();
    const fetched: string[] = [];
    const settings: AutoFetchSettings = { enabled: true, periodMs: 60_000, startupDelayMs: 120_000 };
    const fetcher = new AutoFetcher({
      cli: {
        run: async (options: GitRunOptions) => {
          fetched.push(`${options.cwd} ${options.args.join(" ")}`);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
      settings: () => settings,
      repositories: () => ["/a", "/a/sub"],
      whenFocused: async () => undefined,
      now: () => Date.now(),
    });
    fetcher.reschedule();

    await vi.advanceTimersByTimeAsync(119_000);
    expect(fetched).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetched).toEqual(["/a fetch --quiet --recurse-submodules=no", "/a/sub fetch --quiet --recurse-submodules=no"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetched).toHaveLength(4);
    fetcher.dispose();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetched).toHaveLength(4);
  });
});

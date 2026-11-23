import { describe, expect, it, vi } from "vitest";
import type { GitRunOptions } from "../../../src/git/gitCli.js";
import { cachedSuperprojectResolver, RestoreCoordinator } from "../../../src/restore/restoreCoordinator.js";
import type { RestoreRequest } from "../../../src/restore/branchRestoreService.js";
import { fetchConfirmMessage, restoreOutputLine } from "../../../src/restore/settings.js";

const request: RestoreRequest = {
  parentRootPath: "/repo",
  relativePath: "mod",
  childRootPath: "/repo/mod",
  branch: "main",
  pin: "a".repeat(40),
};

describe("RestoreCoordinator", () => {
  it("schedules auto-safe restore on repository events only when enabled", () => {
    const schedule = vi.fn();
    const retry = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => undefined);
    let enabled = true;
    const coordinator = new RestoreCoordinator({ schedule, retry }, { fetch }, () => enabled);

    coordinator.onRepositoryEvent("/repo");
    enabled = false;
    coordinator.onRepositoryEvent("/repo");

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("/repo");
    expect(fetch).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps fetch as an explicit primitive and never implies pull/push/commit", async () => {
    const fetch = vi.fn(async () => undefined);
    const coordinator = new RestoreCoordinator(
      { schedule: vi.fn(), retry: vi.fn(async () => undefined) },
      { fetch },
      () => true,
    );
    coordinator.onRepositoryEvent("/repo");
    await coordinator.fetch(request);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(request);
    expect(fetchConfirmMessage("mod", "main")).toContain("will not pull, push, commit, or discard");
    expect(restoreOutputLine({ action: "blocked", path: "mod", detail: "dirty" })).toBe("[blocked] mod: dirty");
  });

  it("also schedules the superproject of a submodule that changed, only when enabled", async () => {
    const schedule = vi.fn();
    let enabled = true;
    const superprojectOf = vi.fn(async (rootPath: string) => (rootPath === "/repo/mod" ? "/repo" : undefined));
    const coordinator = new RestoreCoordinator(
      { schedule, retry: vi.fn(async () => undefined) },
      { fetch: vi.fn(async () => undefined) },
      () => enabled,
      superprojectOf,
    );

    coordinator.onRepositoryEvent("/repo/mod");
    coordinator.onRepositoryEvent("/repo");
    await vi.waitFor(() => expect(superprojectOf).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(schedule.mock.calls).toEqual([["/repo/mod"], ["/repo"], ["/repo"]]);

    enabled = false;
    coordinator.onRepositoryEvent("/repo/mod");
    await Promise.resolve();
    expect(schedule).toHaveBeenCalledTimes(3);
  });

  it("caches the superproject lookup per repository and treats no superproject as top-level", async () => {
    const calls: GitRunOptions[] = [];
    const resolve = cachedSuperprojectResolver({
      run: async (options) => {
        calls.push(options);
        return { stdout: options.cwd === "/repo/mod" ? "/repo\n" : "\n", stderr: "", exitCode: 0 };
      },
    });

    expect(await resolve("/repo/mod")).toBe("/repo");
    expect(await resolve("/repo/mod")).toBe("/repo");
    expect(await resolve("/repo")).toBeUndefined();
    expect(calls.map((call) => [call.cwd, ...call.args])).toEqual([
      ["/repo/mod", "rev-parse", "--show-superproject-working-tree"],
      ["/repo", "rev-parse", "--show-superproject-working-tree"],
    ]);
  });
});

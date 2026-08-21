import { describe, expect, it, vi } from "vitest";
import { RestoreCoordinator } from "../../../src/restore/restoreCoordinator.js";
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
    expect(fetchConfirmMessage("mod", "main")).toContain("never done automatically");
    expect(restoreOutputLine({ action: "blocked", path: "mod", detail: "dirty" })).toBe("[blocked] mod: dirty");
  });
});

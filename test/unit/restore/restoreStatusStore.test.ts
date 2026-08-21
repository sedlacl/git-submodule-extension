import { describe, expect, it } from "vitest";
import { RestoreStatusStore } from "../../../src/restore/restoreStatusStore.js";
import type { RestoreResult } from "../../../src/restore/branchRestoreService.js";

function result(action: RestoreResult["action"], path = "mod"): RestoreResult {
  return {
    path,
    parentRootPath: "/repo",
    childRootPath: "/repo/mod",
    action,
    detail: action === "blocked" ? "working tree is dirty" : "ok",
  };
}

describe("RestoreStatusStore", () => {
  it("tracks blocked children, running count, and clears on success", () => {
    const store = new RestoreStatusStore();
    let ticks = 0;
    store.subscribe(() => {
      ticks += 1;
    });
    store.beginRun();
    store.put(result("blocked"));
    expect(store.isRunning).toBe(true);
    expect(store.get("/repo/mod")?.action).toBe("blocked");
    expect(store.blocked()).toHaveLength(1);
    store.put(result("attached"));
    expect(store.get("/repo/mod")).toBeUndefined();
    store.endRun();
    expect(store.isRunning).toBe(false);
    expect(ticks).toBeGreaterThanOrEqual(3);
  });
});

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

  it("does not re-emit an unchanged blocked result", () => {
    const store = new RestoreStatusStore();
    let ticks = 0;
    store.subscribe(() => {
      ticks += 1;
    });
    store.put(result("blocked"));
    const afterFirst = ticks;
    store.put(result("blocked"));
    expect(ticks).toBe(afterFirst);
    expect(store.blocked()).toHaveLength(1);
    store.put({ ...result("blocked"), detail: "pinned commit is not an ancestor of origin/main" });
    expect(ticks).toBe(afterFirst + 1);
    expect(store.get("/repo/mod")?.detail).toBe("pinned commit is not an ancestor of origin/main");
  });

  it("stays silent when a pass only confirms the same state", () => {
    // Every pass used to emit for each attached child and for begin/end, so the Changes view
    // redrew on every repository event.
    const store = new RestoreStatusStore();
    let ticks = 0;
    let resultTicks = 0;
    store.subscribe(() => {
      ticks += 1;
    });
    store.subscribeResults(() => {
      resultTicks += 1;
    });
    store.beginRun();
    store.beginRun();
    store.put(result("already-attached"));
    store.endRun();
    store.endRun();
    expect(ticks).toBe(2);
    expect(resultTicks).toBe(0);
    store.put(result("blocked"));
    store.put(result("attached"));
    expect(resultTicks).toBe(2);
  });
});

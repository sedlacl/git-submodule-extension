import { describe, expect, it, vi } from "vitest";
import type { APIState } from "../../../src/git/git.js";
import { waitForGitApi, type GitApiReadiness } from "../../../src/git/gitApiReady.js";

class ControllableGitApi implements GitApiReadiness {
  private readonly listeners = new Set<(state: APIState) => void>();

  constructor(public state: APIState) {}

  onDidChangeState(listener: (state: APIState) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  setState(state: APIState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

describe("waitForGitApi", () => {
  it("resolves immediately when Git is already initialized", async () => {
    await waitForGitApi(new ControllableGitApi("initialized"), 15_000);
  });

  it("resolves when the state event reports initialized", async () => {
    const api = new ControllableGitApi("uninitialized");
    const pending = waitForGitApi(api);
    api.setState("initialized");
    await pending;
  });

  it("resolves when initialization lands before the listener is attached", async () => {
    let state: APIState = "uninitialized";
    const api: GitApiReadiness = {
      get state() {
        return state;
      },
      onDidChangeState: () => {
        state = "initialized";
        return { dispose() {} };
      },
    };

    await waitForGitApi(api, 15_000);
  });

  it("keeps waiting when no timeout is set", async () => {
    const api = new ControllableGitApi("uninitialized");
    let settled = false;
    const pending = waitForGitApi(api).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    api.setState("initialized");
    await pending;
  });

  it("rejects a configured timeout only while Git is still uninitialized", async () => {
    vi.useFakeTimers();
    try {
      const api = new ControllableGitApi("uninitialized");
      const pending = waitForGitApi(api, 15_000);
      const rejected = expect(pending).rejects.toThrow("Timed out waiting for vscode.git API initialization.");
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a configured timeout as success when Git initialized without an event", async () => {
    vi.useFakeTimers();
    try {
      const api = new ControllableGitApi("uninitialized");
      const pending = waitForGitApi(api, 15_000);
      api.state = "initialized";
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

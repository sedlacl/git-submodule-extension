import { describe, expect, it, vi } from "vitest";
import type { APIState } from "../../../src/git/git.js";
import { subscribeWhenReady, waitForGitApi, type GitApiReadiness } from "../../../src/git/gitApiReady.js";

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

  it("lets callers subscribe before Git is initialized and resolves later", async () => {
    const api = new ControllableGitApi("uninitialized");
    const ready = waitForGitApi(api);
    const subscribed = vi.fn(() => ({ dispose() {} }));
    subscribeWhenReady(ready, subscribed);

    await Promise.resolve();
    expect(subscribed).not.toHaveBeenCalled();

    api.setState("initialized");
    await ready;
    await Promise.resolve();
    expect(subscribed).toHaveBeenCalledTimes(1);
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

describe("subscribeWhenReady", () => {
  it("subscribes after ready resolves and disposes the subscription with the handle", async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const dispose = vi.fn();
    const subscribe = vi.fn(() => ({ dispose }));

    const handle = subscribeWhenReady(ready, subscribe);
    await Promise.resolve();
    expect(subscribe).not.toHaveBeenCalled();

    markReady();
    await ready;
    await Promise.resolve();
    expect(subscribe).toHaveBeenCalledTimes(1);

    handle.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("never subscribes when disposed before ready resolves", async () => {
    const subscribe = vi.fn(() => ({ dispose() {} }));
    const ready = Promise.resolve();

    subscribeWhenReady(ready, subscribe).dispose();
    await ready;
    await Promise.resolve();

    expect(subscribe).not.toHaveBeenCalled();
  });

  it("never subscribes when ready rejects", async () => {
    const subscribe = vi.fn(() => ({ dispose() {} }));
    const ready = Promise.reject(new Error("no git"));

    subscribeWhenReady(ready, subscribe);
    await ready.catch(() => undefined);
    await Promise.resolve();

    expect(subscribe).not.toHaveBeenCalled();
  });
});

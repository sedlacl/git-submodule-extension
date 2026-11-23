import { canonicalizeRepoPath } from "../git/pathUtils.js";
import type { RestoreResult } from "./branchRestoreService.js";

/**
 * Blocked restore results per submodule and whether a restore pass is running. Listeners hear
 * only real changes: a pass that confirms the same state again stays silent, so views do not
 * redraw on every repository event.
 */
export class RestoreStatusStore {
  private readonly byChild = new Map<string, RestoreResult>();
  private readonly listeners = new Set<() => void>();
  private readonly resultListeners = new Set<() => void>();
  private running = 0;

  get isRunning(): boolean {
    return this.running > 0;
  }

  beginRun(): void {
    this.running += 1;
    if (this.running === 1) {
      this.emit(false);
    }
  }

  endRun(): void {
    if (this.running === 0) {
      return;
    }
    this.running -= 1;
    if (this.running === 0) {
      this.emit(false);
    }
  }

  put(result: RestoreResult): void {
    const key = canonicalizeRepoPath(result.childRootPath);
    const previous = this.byChild.get(key);
    if (result.action === "blocked") {
      if (previous?.action === "blocked" && previous.detail === result.detail && previous.path === result.path) {
        return;
      }
      this.byChild.set(key, result);
    } else {
      if (!previous) {
        return;
      }
      this.byChild.delete(key);
    }
    this.emit(true);
  }

  get(childRootPath: string): RestoreResult | undefined {
    return this.byChild.get(canonicalizeRepoPath(childRootPath));
  }

  blocked(): RestoreResult[] {
    return [...this.byChild.values()];
  }

  /** Blocked results or the running state changed. */
  subscribe(listener: () => void): { dispose(): void } {
    return add(this.listeners, listener);
  }

  /** Only the blocked results changed: what a view that shows them needs to redraw for. */
  subscribeResults(listener: () => void): { dispose(): void } {
    return add(this.resultListeners, listener);
  }

  private emit(resultsChanged: boolean): void {
    for (const listener of this.listeners) {
      listener();
    }
    if (resultsChanged) {
      for (const listener of this.resultListeners) {
        listener();
      }
    }
  }
}

function add(listeners: Set<() => void>, listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

import { canonicalizeRepoPath } from "../git/pathUtils.js";
import type { RestoreResult } from "./branchRestoreService.js";

export class RestoreStatusStore {
  private readonly byChild = new Map<string, RestoreResult>();
  private readonly listeners = new Set<() => void>();
  private running = 0;

  get isRunning(): boolean {
    return this.running > 0;
  }

  beginRun(): void {
    this.running += 1;
    this.emit();
  }

  endRun(): void {
    this.running = Math.max(0, this.running - 1);
    this.emit();
  }

  put(result: RestoreResult): void {
    const key = canonicalizeRepoPath(result.childRootPath);
    if (result.action === "blocked") {
      this.byChild.set(key, result);
    } else {
      this.byChild.delete(key);
    }
    this.emit();
  }

  get(childRootPath: string): RestoreResult | undefined {
    return this.byChild.get(canonicalizeRepoPath(childRootPath));
  }

  blocked(): RestoreResult[] {
    return [...this.byChild.values()];
  }

  subscribe(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

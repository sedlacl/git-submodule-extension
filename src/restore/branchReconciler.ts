import { parseGitmodules } from "../git/gitmodulesParser.js";
import { parseLsTreeGitlinks } from "../git/gitlinkParser.js";
import type { GitCli } from "../git/gitCli.js";
import { canonicalizeRepoPath, joinRepoPath, normalizeGitRelativePath } from "../git/pathUtils.js";
import type { GitmodulesEntry } from "../git/types.js";
import type { BranchRestoreExecutor, RestoreResult } from "./branchRestoreService.js";

export interface BranchReconcilerOptions {
  readonly debounceMs?: number | (() => number);
  readonly onResult?: (result: RestoreResult) => void;
  readonly onRunStart?: (parentRootPath: string) => void;
  readonly onRunEnd?: (parentRootPath: string) => void;
}

/**
 * Coalesces parent Git events and restores every declared child recursively.
 * All targets are read from the committed parent state at execution time, not
 * from a previously rendered SCM model.
 */
export const MAX_RESTORE_DEPTH = 32;

export class BranchReconciler {
  private readonly debounceMs: () => number;
  private readonly onResult?: (result: RestoreResult) => void;
  private readonly onRunStart?: (parentRootPath: string) => void;
  private readonly onRunEnd?: (parentRootPath: string) => void;
  private readonly generations = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly parentLocks = new Map<string, Promise<void>>();
  private readonly childLocks = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly cli: GitCli,
    private readonly restore: BranchRestoreExecutor,
    options: BranchReconcilerOptions = {},
  ) {
    const debounce = options.debounceMs;
    this.debounceMs = typeof debounce === "function" ? debounce : () => debounce ?? 250;
    this.onResult = options.onResult;
    this.onRunStart = options.onRunStart;
    this.onRunEnd = options.onRunEnd;
  }

  /** Queue an event-driven run. Repeated events for one parent are coalesced. */
  schedule(parentRootPath: string): void {
    const parent = normalize(parentRootPath);
    const generation = (this.generations.get(parent) ?? 0) + 1;
    this.generations.set(parent, generation);
    const previous = this.timers.get(parent);
    if (previous) {
      clearTimeout(previous);
    }
    this.timers.set(
      parent,
      setTimeout(() => {
        this.timers.delete(parent);
        void this.enqueueParent(parent, generation);
      }, this.debounceMs()),
    );
  }

  /** Explicit user-invoked retry. It never fetches or changes the safety rules. */
  retry(parentRootPath: string): Promise<void> {
    const parent = normalize(parentRootPath);
    const generation = (this.generations.get(parent) ?? 0) + 1;
    this.generations.set(parent, generation);
    return this.enqueueParent(parent, generation);
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private enqueueParent(parent: string, generation: number): Promise<void> {
    const previous = this.parentLocks.get(parent) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      this.onRunStart?.(parent);
      try {
        await this.reconcileParent(parent, generation, new Set(), 0);
      } finally {
        this.onRunEnd?.(parent);
      }
    });
    this.parentLocks.set(parent, next);
    void next.finally(() => {
      if (this.parentLocks.get(parent) === next) {
        this.parentLocks.delete(parent);
      }
    });
    return next;
  }

  private async reconcileParent(parent: string, generation: number, visiting: Set<string>, depth: number): Promise<void> {
    if (!this.current(parent, generation)) {
      return;
    }
    if (visiting.has(parent)) {
      return;
    }
    if (depth >= MAX_RESTORE_DEPTH) {
      this.publish(parent, generation, {
        path: parent,
        parentRootPath: parent,
        childRootPath: parent,
        action: "blocked",
        detail: "restore depth limit exceeded",
      });
      return;
    }
    visiting.add(parent);
    try {
      const children = await this.readChildren(parent, generation);
      for (const child of children) {
        if (!this.current(parent, generation)) {
          return;
        }
        if (visiting.has(child.childRootPath)) {
          continue;
        }
        await this.withChildLock(child.childRootPath, async () => {
          if (!this.current(parent, generation)) {
            return;
          }
          const result = await this.restore.reconcile(child);
          this.publish(parent, generation, result);
        });
        if (!this.current(parent, generation)) {
          return;
        }
        // Nested .gitmodules/gitlinks are committed in the child itself.
        await this.reconcileParent(
          child.childRootPath,
          this.generations.get(child.childRootPath) ?? 0,
          visiting,
          depth + 1,
        );
      }
    } finally {
      visiting.delete(parent);
    }
  }

  private async readChildren(parent: string, generation: number): Promise<RestoreChild[]> {
    const [modulesResult, treeResult] = await Promise.all([
      this.cli.run({ cwd: parent, args: ["show", "HEAD:.gitmodules"], allowedExitCodes: [0, 128] }),
      this.cli.run({ cwd: parent, args: ["ls-tree", "-r", "-z", "HEAD"], allowedExitCodes: [0, 128] }),
    ]);
    if (modulesResult.exitCode !== 0 || treeResult.exitCode !== 0) {
      return [];
    }

    const pins = new Map(parseLsTreeGitlinks(treeResult.stdout).map((entry) => [entry.path, entry.sha]));
    const children: RestoreChild[] = [];
    for (const entry of parseGitmodules(modulesResult.stdout)) {
      if (!entry.branch) {
        this.publish(parent, generation, {
          path: entry.path,
          parentRootPath: parent,
          childRootPath: joinRepoPath(parent, entry.path),
          action: "blocked",
          detail: "committed .gitmodules has no branch",
        });
        continue;
      }
      const childRootPath = safeChildPath(parent, entry);
      const pin = pins.get(entry.path);
      if (!childRootPath || !pin) {
        this.publish(parent, generation, {
          path: entry.path,
          parentRootPath: parent,
          childRootPath: childRootPath ?? joinRepoPath(parent, entry.path),
          action: "blocked",
          detail: !childRootPath ? "submodule path escapes its parent" : "committed parent gitlink is missing",
        });
        continue;
      }
      children.push({ parentRootPath: parent, relativePath: entry.path, childRootPath, branch: entry.branch, pin });
    }
    return children;
  }

  private async withChildLock(key: string, action: () => Promise<void>): Promise<void> {
    const previous = this.childLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.childLocks.set(key, next);
    try {
      await next;
    } finally {
      if (this.childLocks.get(key) === next) {
        this.childLocks.delete(key);
      }
    }
  }

  private current(parent: string, generation: number): boolean {
    return generation === 0 || this.generations.get(parent) === generation;
  }

  private publish(parent: string, generation: number, result: RestoreResult): void {
    if (!this.current(parent, generation)) {
      return;
    }
    const key = `${parent}\0${result.path}`;
    if (result.action === "blocked") {
      if (this.errors.get(key) === result.detail) {
        return;
      }
      this.errors.set(key, result.detail);
    } else {
      this.errors.delete(key);
    }
    this.onResult?.(result);
  }
}

interface RestoreChild {
  readonly parentRootPath: string;
  readonly relativePath: string;
  readonly childRootPath: string;
  readonly branch: string;
  readonly pin: string;
}

function safeChildPath(parent: string, entry: GitmodulesEntry): string | null {
  const relative = normalizeGitRelativePath(entry.path);
  return relative ? canonicalizeRepoPath(joinRepoPath(parent, relative)) : null;
}

function normalize(value: string): string {
  return canonicalizeRepoPath(value);
}

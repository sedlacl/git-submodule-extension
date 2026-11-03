import type { GitCli } from "../git/gitCli.js";
import { canonicalizeRepoPath } from "../git/pathUtils.js";
import type { RestoreRequest } from "./branchRestoreService.js";

/** Resolves the checkout that contains a submodule, or `undefined` for a top-level repository. */
export type SuperprojectResolver = (rootPath: string) => Promise<string | undefined>;

export interface RestoreScheduler {
  schedule(parentRootPath: string): void;
  retry(parentRootPath: string): Promise<void>;
}

export interface RestoreFetcher {
  fetch(request: RestoreRequest): Promise<void>;
}

/**
 * Event-driven auto-safe restore. Repository change events never fetch, pull,
 * push, commit, or discard; fetch exists only as an explicit user primitive.
 */
export class RestoreCoordinator {
  constructor(
    private readonly scheduler: RestoreScheduler,
    private readonly fetcher: RestoreFetcher,
    private readonly isAutoEnabled: () => boolean,
    private readonly superprojectOf?: SuperprojectResolver,
  ) {}

  onRepositoryEvent(rootPath: string): void {
    if (!this.isAutoEnabled()) {
      return;
    }
    this.scheduler.schedule(rootPath);
    // A detach can change only the submodule (its parent's status stays the same), and only
    // the parent's run restores it, so an event from a submodule schedules its parent too.
    void this.superprojectOf?.(rootPath).then(
      (superproject) => {
        if (superproject && this.isAutoEnabled()) {
          this.scheduler.schedule(superproject);
        }
      },
      () => undefined,
    );
  }

  retry(parentRootPath: string): Promise<void> {
    return this.scheduler.retry(parentRootPath);
  }

  async retryMany(parentRootPaths: readonly string[]): Promise<void> {
    for (const parent of parentRootPaths) {
      await this.retry(parent);
    }
  }

  fetch(request: RestoreRequest): Promise<void> {
    return this.fetcher.fetch(request);
  }
}

/**
 * `git rev-parse --show-superproject-working-tree`, cached per repository: repository events are
 * frequent, and an open submodule checkout does not move to another parent.
 */
export function cachedSuperprojectResolver(cli: GitCli): SuperprojectResolver {
  const cache = new Map<string, Promise<string | undefined>>();
  return (rootPath) => {
    const key = canonicalizeRepoPath(rootPath);
    let pending = cache.get(key);
    if (!pending) {
      pending = cli
        .run({ cwd: rootPath, args: ["rev-parse", "--show-superproject-working-tree"], allowedExitCodes: [0, 128] })
        .then((result) => (result.exitCode === 0 && result.stdout.trim()) || undefined);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  };
}

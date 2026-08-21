import type { RestoreRequest } from "./branchRestoreService.js";

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
  ) {}

  onRepositoryEvent(rootPath: string): void {
    if (!this.isAutoEnabled()) {
      return;
    }
    this.scheduler.schedule(rootPath);
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

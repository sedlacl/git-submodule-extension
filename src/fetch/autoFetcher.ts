import * as path from "node:path";
import { safeError } from "../actionDiagnostics.js";
import type { GitCli } from "../git/gitCli.js";

export interface AutoFetchSettings {
  readonly enabled: boolean;
  readonly periodMs: number;
  readonly startupDelayMs: number;
}

export interface AutoFetchHost {
  readonly cli: GitCli;
  settings(): AutoFetchSettings;
  /** Repositories to fetch, read again before every pass. Only those with a remote are listed. */
  repositories(): readonly string[];
  /** Resolves when the window has focus; a fetch pass waits for it, like `git.autofetch`. */
  whenFocused(): Promise<void>;
  onFetched?(rootPath: string): void;
  log?(line: string): void;
  now?(): number;
}

export const FETCH_TIMEOUT_MS = 120_000;

/**
 * Periodic background `git fetch` of every open repository, submodules included. Unlike
 * `git.autofetch` it waits `startupDelayMs` after activation, so opening a large workspace does
 * not start dozens of fetches at once. Repositories are fetched one at a time, without prompts
 * and without recursing into submodules (each submodule is fetched as its own repository).
 */
export class AutoFetcher {
  private readonly started: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;
  private lastPassEnd: number | undefined;

  constructor(private readonly host: AutoFetchHost) {
    this.started = this.now();
  }

  /** Arms the timer from the current settings. Call again after a settings change. */
  reschedule(): void {
    this.clearTimer();
    if (this.disposed || this.running) {
      return;
    }
    const settings = this.host.settings();
    if (!settings.enabled) {
      return;
    }
    const now = this.now();
    const notBefore = this.started + settings.startupDelayMs;
    const next = this.lastPassEnd === undefined ? notBefore : Math.max(notBefore, this.lastPassEnd + settings.periodMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pass();
    }, Math.max(0, next - now));
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** One fetch pass over all repositories; exposed for tests. */
  async pass(): Promise<void> {
    if (this.running || this.disposed) {
      return;
    }
    this.running = true;
    try {
      await this.host.whenFocused();
      if (this.disposed || !this.host.settings().enabled) {
        return;
      }
      const repositories = this.host.repositories();
      const passStart = this.now();
      let failed = 0;
      for (const rootPath of repositories) {
        if (this.disposed || !this.host.settings().enabled) {
          return;
        }
        const result = await this.host.cli
          .run({
            cwd: rootPath,
            args: ["fetch", "--quiet", "--recurse-submodules=no"],
            timeoutMs: FETCH_TIMEOUT_MS,
            allowedExitCodes: [0, 1, 128],
            // Never block on a credential dialog in the background.
            env: { GCM_INTERACTIVE: "never" },
          })
          .catch((error: unknown) => ({ exitCode: -1, stderr: error instanceof Error ? error.message : String(error) }));
        if (result.exitCode === 0) {
          this.host.onFetched?.(rootPath);
        } else {
          failed += 1;
          this.host.log?.(`[autofetch] ${path.basename(rootPath)}: ${safeError(result.stderr.trim() || `exit ${result.exitCode}`)}`);
        }
      }
      const seconds = ((this.now() - passStart) / 1000).toFixed(1);
      this.host.log?.(`[autofetch] ${repositories.length} repositories, ${failed} failed (${seconds}s)`);
    } finally {
      this.running = false;
      this.lastPassEnd = this.now();
      this.reschedule();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }
}

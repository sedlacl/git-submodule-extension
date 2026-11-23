import { execFile as execFileCallback } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface GitRunOptions {
  cwd: string;
  args: readonly string[];
  timeoutMs?: number;
  allowedExitCodes?: readonly number[];
  /** Extra environment for this call; it cannot replace the variables set for every call. */
  env?: Readonly<Record<string, string>>;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCli {
  run(options: GitRunOptions): Promise<GitRunResult>;
}

/** A finished Git call, reported to `GitCliRunner.onDidRun` listeners. */
export interface GitRunRecord {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly durationMs: number;
  readonly exitCode: number | null;
}

export interface ExecFileInvocation {
  file: string;
  args: readonly string[];
  options: ExecFileOptions & { encoding: "utf8" };
}

export type ExecFileUtf8 = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

export class GitCliError extends Error {
  constructor(
    readonly gitPath: string,
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode ?? "unknown"}`;
    super(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
    this.name = "GitCliError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

function promisifiedExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: "utf8" },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function asExecError(error: unknown): {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  killed?: boolean;
  message: string;
} {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
      message?: string;
    };
    return {
      code: candidate.code,
      stdout: candidate.stdout,
      stderr: candidate.stderr,
      killed: candidate.killed,
      message: candidate.message ?? String(error),
    };
  }
  return { message: String(error) };
}

function assertSafeArgs(args: readonly string[]): void {
  if (!Array.isArray(args)) {
    throw new Error("Git arguments must be passed as an array; shell strings are not allowed.");
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error("Git arguments must be strings.");
    }
    if (arg.includes("\0")) {
      throw new Error("Git arguments must not contain NUL bytes.");
    }
  }
}

/**
 * Runs Git via `execFile` with `shell: false`. Arguments are never concatenated
 * into a shell command, so paths with spaces, `#`, quotes, or metacharacters
 * stay literal.
 */
export class GitCliRunner implements GitCli {
  private readonly runListeners = new Set<(record: GitRunRecord) => void>();

  constructor(
    private readonly gitPath: string,
    private readonly execFileUtf8: ExecFileUtf8 = promisifiedExecFile,
  ) {
    if (!gitPath || gitPath.includes("\0")) {
      throw new Error("Git executable path is missing or invalid.");
    }
  }

  /** Lets callers observe how long Git calls take, for example to spot a slow `git status`. */
  onDidRun(listener: (record: GitRunRecord) => void): { dispose(): void } {
    this.runListeners.add(listener);
    return {
      dispose: () => {
        this.runListeners.delete(listener);
      },
    };
  }

  private report(options: GitRunOptions, started: number, exitCode: number | null): void {
    if (this.runListeners.size === 0) {
      return;
    }
    const record: GitRunRecord = { cwd: options.cwd, args: options.args, durationMs: performance.now() - started, exitCode };
    for (const listener of this.runListeners) {
      try {
        listener(record);
      } catch {
        // An observer must never break the Git call it observes.
      }
    }
  }

  async run(options: GitRunOptions): Promise<GitRunResult> {
    assertSafeArgs(options.args);
    if (!options.cwd || options.cwd.includes("\0")) {
      throw new Error("Git cwd is missing or invalid.");
    }

    const allowedExitCodes = options.allowedExitCodes ?? [0];
    const execOptions: ExecFileOptions & { encoding: "utf8" } = {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: "0",
        // Background reads must not take index.lock or rewrite the index: that fires vscode.git's
        // watchers, its status run fires a repository event, and restore would run again.
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
    };

    const started = performance.now();
    try {
      const result = await this.execFileUtf8(this.gitPath, options.args, execOptions);
      this.report(options, started, 0);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const execError = asExecError(error);
      const exitCode = typeof execError.code === "number" ? execError.code : null;
      this.report(options, started, exitCode);
      const stdout = execError.stdout ? String(execError.stdout) : "";
      const stderr = execError.stderr ? String(execError.stderr) : "";
      if (exitCode !== null && allowedExitCodes.includes(exitCode)) {
        return { stdout, stderr, exitCode };
      }
      throw new GitCliError(this.gitPath, options.args, options.cwd, exitCode, stdout, stderr || execError.message);
    }
  }
}

import { execFile as execFileCallback } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  args: readonly string[];
  timeoutMs?: number;
  allowedExitCodes?: readonly number[];
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCli {
  run(options: GitRunOptions): Promise<GitRunResult>;
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
  constructor(
    private readonly gitPath: string,
    private readonly execFileUtf8: ExecFileUtf8 = promisifiedExecFile,
  ) {
    if (!gitPath || gitPath.includes("\0")) {
      throw new Error("Git executable path is missing or invalid.");
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
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "1",
        LC_ALL: "C",
      },
    };

    try {
      const result = await this.execFileUtf8(this.gitPath, options.args, execOptions);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const execError = asExecError(error);
      const exitCode = typeof execError.code === "number" ? execError.code : null;
      const stdout = execError.stdout ? String(execError.stdout) : "";
      const stderr = execError.stderr ? String(execError.stderr) : "";
      if (exitCode !== null && allowedExitCodes.includes(exitCode)) {
        return { stdout, stderr, exitCode };
      }
      throw new GitCliError(this.gitPath, options.args, options.cwd, exitCode, stdout, stderr || execError.message);
    }
  }
}

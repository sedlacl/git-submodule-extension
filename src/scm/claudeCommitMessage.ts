import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import * as path from "node:path";
import type { GitCli } from "../git/gitCli.js";

export const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";
export const DEFAULT_CLAUDE_COMMIT_MESSAGE_MODEL = "haiku";
export const CLAUDE_COMMIT_MESSAGE_TIMEOUT_MS = 90_000;
export const MAX_COMMIT_MESSAGE_DIFF_CHARS = 60_000;
const RECENT_SUBJECT_COUNT = 10;

export const CLAUDE_COMMIT_MESSAGE_SYSTEM_PROMPT = [
  "You write git commit messages.",
  "Reply with the commit message only: a subject line of at most 72 characters,",
  "optionally followed by a blank line and a short body that explains what changed and why.",
  "Follow the style and language of the recent commit subjects when they are given (for example Conventional Commits).",
  "No code fences, no quotes, no commentary.",
].join(" ");

export interface ClaudeExecutableLookup {
  /** Install folder of the Claude Code VS Code extension, when installed. */
  extensionPath?: string;
  platform: NodeJS.Platform;
  pathEnv?: string;
  exists(filePath: string): boolean;
}

/**
 * Prefers the native CLI bundled with the Claude Code extension, then a native
 * `claude` on PATH. Windows `.cmd` shims are skipped: they need a shell.
 */
export function resolveClaudeExecutable(lookup: ClaudeExecutableLookup): string | undefined {
  const fileName = lookup.platform === "win32" ? "claude.exe" : "claude";
  const join = lookup.platform === "win32" ? path.win32.join : path.posix.join;
  const candidates: string[] = [];
  if (lookup.extensionPath) {
    candidates.push(join(lookup.extensionPath, "resources", "native-binary", fileName));
  }
  const separator = lookup.platform === "win32" ? ";" : ":";
  for (const dir of (lookup.pathEnv ?? "").split(separator)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (trimmed) {
      candidates.push(join(trimmed, fileName));
    }
  }
  return candidates.find((candidate) => lookup.exists(candidate));
}

/** Headless, tool-less run that ignores user/project settings, hooks and MCP servers. */
export function buildClaudeCommitMessageArgs(model: string): string[] {
  return [
    "-p",
    "--model",
    model.trim() || DEFAULT_CLAUDE_COMMIT_MESSAGE_MODEL,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--system-prompt",
    CLAUDE_COMMIT_MESSAGE_SYSTEM_PROMPT,
    "Write a commit message for the changes described on stdin.",
  ];
}

/**
 * Builds the stdin prompt: staged changes when anything is staged, otherwise
 * tracked working-tree changes plus untracked file names (what a smart commit
 * would include). Returns `undefined` when there is nothing to describe.
 */
export async function collectCommitMessageContext(
  cli: GitCli,
  rootPath: string,
  maxChars = MAX_COMMIT_MESSAGE_DIFF_CHARS,
): Promise<string | undefined> {
  const git = async (args: readonly string[]): Promise<string> =>
    (await cli.run({ cwd: rootPath, args })).stdout;
  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "--submodule=short"];

  let scope = "Staged changes";
  let diff = await git([...diffArgs, "--cached"]);
  let untracked = "";
  if (!diff.trim()) {
    scope = "Working tree changes (nothing is staged)";
    diff = await git(diffArgs);
    untracked = await git(["ls-files", "--others", "--exclude-standard"]);
  }
  if (!diff.trim() && !untracked.trim()) {
    return undefined;
  }

  let recentSubjects = "";
  try {
    recentSubjects = await git(["log", `-n${RECENT_SUBJECT_COUNT}`, "--format=%s"]);
  } catch {
    // A repository without commits has no history to imitate.
  }

  const sections: string[] = [];
  if (recentSubjects.trim()) {
    sections.push(`Recent commit subjects:\n${recentSubjects.trim()}`);
  }
  if (untracked.trim()) {
    sections.push(`New untracked files:\n${untracked.trim()}`);
  }
  if (diff.trim()) {
    const truncated = diff.length > maxChars;
    sections.push(
      `${scope}:\n${truncated ? diff.slice(0, maxChars) : diff.trimEnd()}${truncated ? "\n[diff truncated]" : ""}`,
    );
  }
  return sections.join("\n\n");
}

/** Strips code fences and surrounding whitespace the model may add despite the prompt. */
export function cleanClaudeCommitMessage(output: string): string {
  const trimmed = output.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface RunClaudeCommitMessageOptions {
  executable: string;
  args: readonly string[];
  input: string;
  /** Neutral folder, so the CLI does not pick up the repository's CLAUDE.md. */
  cwd: string;
  timeoutMs?: number;
  spawn?: SpawnProcess;
}

export async function runClaudeCommitMessage(options: RunClaudeCommitMessageOptions): Promise<string> {
  const spawn = options.spawn ?? ((command, args, spawnOptions) => spawnProcess(command, [...args], spawnOptions));
  const timeoutMs = options.timeoutMs ?? CLAUDE_COMMIT_MESSAGE_TIMEOUT_MS;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s.`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit ${code ?? "unknown"}`;
        reject(new Error(`Claude CLI failed: ${detail}`));
        return;
      }
      resolve(cleanClaudeCommitMessage(stdout));
    });
    child.stdin.on("error", () => {
      // The close handler reports the failure; ignore EPIPE when the CLI exits early.
    });
    child.stdin.end(options.input, "utf8");
  });
}

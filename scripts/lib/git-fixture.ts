import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly cwd: string,
    readonly status: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed in ${cwd} (exit ${status ?? "?"}): ${stderr.trim()}`);
    this.name = "GitCommandError";
  }
}

export function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "protocol.file.allow=always",
      "-c",
      "user.email=fixture@example.local",
      "-c",
      "user.name=UI Fixture Generator",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      shell: false,
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new GitCommandError(args, cwd, result.status, result.stderr || result.stdout || "");
  }
  return (result.stdout ?? "").trimEnd();
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

export function initRepo(repoDir: string, initialBranch = "main"): void {
  removeDir(repoDir);
  ensureDir(repoDir);
  runGit(repoDir, ["init", "-b", initialBranch]);
  runGit(repoDir, ["config", "user.email", "fixture@example.local"]);
  runGit(repoDir, ["config", "user.name", "UI Fixture Generator"]);
}

export function commitAll(repoDir: string, message: string): string {
  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", message]);
  return runGit(repoDir, ["rev-parse", "HEAD"]);
}

export function commitFile(repoDir: string, relativePath: string, content: string, message: string): string {
  writeFile(path.join(repoDir, relativePath), content);
  return commitAll(repoDir, message);
}

export function createBranch(repoDir: string, branch: string, startPoint = "HEAD"): void {
  runGit(repoDir, ["branch", branch, startPoint]);
}

export function checkout(repoDir: string, ref: string): void {
  runGit(repoDir, ["checkout", ref]);
}

export function addSubmodule(parentDir: string, submodulePath: string, url: string, branch: string): void {
  runGit(parentDir, ["submodule", "add", "-b", branch, url, submodulePath]);
}

export function submoduleUpdate(parentDir: string): void {
  runGit(parentDir, ["submodule", "update", "--init", "--recursive"]);
}

export function stageGitlink(parentDir: string, submodulePath: string, sha: string): void {
  runGit(parentDir, ["update-index", "--add", "--cacheinfo", `160000,${sha},${submodulePath}`]);
}

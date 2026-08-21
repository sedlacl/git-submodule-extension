import * as path from "node:path";
import { GitCliError, type GitCli } from "../git/gitCli.js";
import { type PathExistence, nodePathExistence } from "../git/gitRepositoryReader.js";
import { sameRepoPath } from "../git/pathUtils.js";
import { GIT_IN_PROGRESS_MARKERS, parsePorcelainV2 } from "../git/repoStatus.js";
import { assertSha } from "../git/sha.js";

export type RestoreAction = "attached" | "already-attached" | "blocked";

export interface RestoreResult {
  readonly path: string;
  readonly parentRootPath: string;
  readonly childRootPath: string;
  readonly action: RestoreAction;
  readonly detail: string;
}

export interface RestoreRequest {
  readonly parentRootPath: string;
  readonly relativePath: string;
  readonly childRootPath: string;
  readonly branch: string;
  readonly pin: string;
}

export interface BranchRestoreExecutor {
  reconcile(request: RestoreRequest): Promise<RestoreResult>;
  fetch(request: RestoreRequest): Promise<void>;
}

/**
 * Performs a single, fully revalidated branch attach. It intentionally has no
 * pull, push, commit, reset, checkout-discard, or implicit network operation.
 */
export class SafeBranchRestoreService implements BranchRestoreExecutor {
  constructor(
    private readonly cli: GitCli,
    private readonly paths: PathExistence = nodePathExistence,
  ) {}

  async reconcile(request: RestoreRequest): Promise<RestoreResult> {
    try {
      this.assertRequest(request);
      const already = await this.inspect(request);
      if (already) {
        return this.result(request, "already-attached", `already on ${request.branch}@${shortSha(request.pin)}`);
      }

      // Revalidate immediately before the only two automatic writes.
      await this.assertSafeToAttach(request);
      await this.cli.run({ cwd: request.childRootPath, args: ["switch", "-C", request.branch, request.pin] });
      await this.cli.run({
        cwd: request.childRootPath,
        args: ["branch", "--set-upstream-to", `origin/${request.branch}`, request.branch],
      });
      await this.assertAttached(request);
      return this.result(request, "attached", `attached ${request.branch}@${shortSha(request.pin)}`);
    } catch (error) {
      return this.result(request, "blocked", message(error));
    }
  }

  /** Explicit user-invoked primitive; the reconciler never calls this. */
  async fetch(request: RestoreRequest): Promise<void> {
    this.assertRequest(request);
    await this.cli.run({ cwd: request.childRootPath, args: ["fetch", "origin", request.branch] });
  }

  private async inspect(request: RestoreRequest): Promise<boolean> {
    await this.assertSafeToAttach(request);
    const status = await this.status(request.childRootPath);
    return (
      status.oid === request.pin &&
      status.head === request.branch &&
      status.upstream === `origin/${request.branch}`
    );
  }

  private async assertSafeToAttach(request: RestoreRequest): Promise<void> {
    const child = request.childRootPath;
    const workTree = await this.cli.run({
      cwd: child,
      args: ["rev-parse", "--is-inside-work-tree"],
      allowedExitCodes: [0, 128],
    });
    if (workTree.exitCode !== 0 || workTree.stdout.trim() !== "true") {
      throw new Error("submodule is not an initialized Git worktree");
    }

    const topLevel = await this.cli.run({ cwd: child, args: ["rev-parse", "--show-toplevel"] });
    if (!sameRepoPath(topLevel.stdout.trim(), child)) {
      throw new Error("submodule path is not its Git worktree root");
    }
    if (await this.operationInProgress(child)) {
      throw new Error("a Git operation is in progress");
    }

    const status = await this.status(child);
    if (status.dirty) {
      throw new Error("working tree is dirty");
    }

    const origin = await this.cli.run({
      cwd: child,
      args: ["remote", "get-url", "origin"],
      allowedExitCodes: [0, 2],
    });
    if (origin.exitCode !== 0 || !origin.stdout.trim()) {
      throw new Error("remote 'origin' does not exist");
    }

    await this.requireExists(child, ["cat-file", "-e", `${request.pin}^{commit}`], `pinned commit ${shortSha(request.pin)} is absent`);
    const remoteRef = `refs/remotes/origin/${request.branch}`;
    await this.requireExists(child, ["show-ref", "--verify", "--quiet", remoteRef], `missing ${remoteRef}; fetch it explicitly`);

    const onRemote = await this.cli.run({
      cwd: child,
      args: ["merge-base", "--is-ancestor", request.pin, `origin/${request.branch}`],
      allowedExitCodes: [0, 1],
    });
    if (onRemote.exitCode !== 0) {
      throw new Error(`pinned commit is not an ancestor of origin/${request.branch}`);
    }

    const localRef = `refs/heads/${request.branch}`;
    const localExists = await this.cli.run({
      cwd: child,
      args: ["show-ref", "--verify", "--quiet", localRef],
      allowedExitCodes: [0, 1],
    });
    if (localExists.exitCode === 0) {
      const local = (await this.cli.run({ cwd: child, args: ["rev-parse", localRef] })).stdout.trim();
      if (local !== request.pin) {
        const unique = await this.cli.run({
          cwd: child,
          args: ["log", "--format=%s", `origin/${request.branch}..${request.branch}`],
        });
        if (unique.stdout.trim()) {
          throw new Error(`local branch ${request.branch} has commits not on origin/${request.branch}`);
        }
      }
    }
  }

  private async assertAttached(request: RestoreRequest): Promise<void> {
    const status = await this.status(request.childRootPath);
    if (status.oid !== request.pin || status.head !== request.branch || status.upstream !== `origin/${request.branch}`) {
      throw new Error("post-switch verification failed");
    }
  }

  private async status(cwd: string) {
    const result = await this.cli.run({
      cwd,
      args: ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"],
    });
    return parsePorcelainV2(result.stdout);
  }

  private async operationInProgress(cwd: string): Promise<boolean> {
    const result = await this.cli.run({ cwd, args: ["rev-parse", "--absolute-git-dir"] });
    const gitDir = result.stdout.trim();
    return Boolean(gitDir) && GIT_IN_PROGRESS_MARKERS.some((marker) => this.paths.exists(path.join(gitDir, marker)));
  }

  private async requireExists(cwd: string, args: string[], detail: string): Promise<void> {
    const result = await this.cli.run({ cwd, args, allowedExitCodes: [0, 1, 128] });
    if (result.exitCode !== 0) {
      throw new Error(detail);
    }
  }

  private assertRequest(request: RestoreRequest): void {
    assertSha(request.pin, "pin");
    if (!request.branch || request.branch.includes("\0") || request.branch.startsWith("-")) {
      throw new Error("target branch is missing or invalid");
    }
  }

  private result(request: RestoreRequest, action: RestoreAction, detail: string): RestoreResult {
    return {
      path: request.relativePath,
      parentRootPath: request.parentRootPath,
      childRootPath: request.childRootPath,
      action,
      detail,
    };
  }
}

function message(error: unknown): string {
  if (error instanceof GitCliError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

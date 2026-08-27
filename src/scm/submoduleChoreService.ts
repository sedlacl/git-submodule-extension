import * as path from "node:path";
import { mergeDeclaredSubmodules } from "../git/declaredSubmodules.js";
import type { GitCli } from "../git/gitCli.js";
import { GitRepositoryReader } from "../git/gitRepositoryReader.js";
import { joinRepoPath, normalizeGitRelativePath } from "../git/pathUtils.js";
import { parseSha } from "../git/sha.js";
import type { DeclaredSubmodule } from "../git/types.js";
import {
  MAX_NESTED_SUBMODULE_DEPTH,
  buildSubmoduleChoreMessage,
  resolveChoreSubject,
} from "./submoduleChoreMessage.js";
import type {
  SubmoduleChorePreview,
  SubmoduleChorePreviewOptions,
  SubmoduleChoreReadService as SubmoduleChoreReadServiceInterface,
  SubmoduleCommitEntry,
  SubmodulePointerUpdate,
} from "./submoduleChoreTypes.js";

interface ChildCheckoutState {
  headSha: string | null;
  branch: string;
}

interface CommitSummary {
  sha: string;
  subject: string;
}

export class SubmoduleChoreReadService implements SubmoduleChoreReadServiceInterface {
  constructor(
    private readonly cli: GitCli,
    private readonly reader: GitRepositoryReader = new GitRepositoryReader(cli),
  ) {}

  async preview(parentRepoPath: string, options: SubmoduleChorePreviewOptions = {}): Promise<SubmoduleChorePreview | null> {
    const declared = await this.readDeclaredSubmodules(parentRepoPath);
    const updates = await this.collectPointerUpdates(parentRepoPath, declared);
    if (updates.length === 0) {
      return null;
    }

    const subject = resolveChoreSubject(updates, options.subject);
    const message = buildSubmoduleChoreMessage({ updates, subject });
    return {
      subject: message.subject,
      body: message.body,
      message: message.message,
      updates,
    };
  }

  private async readDeclaredSubmodules(parentRepoPath: string): Promise<DeclaredSubmodule[]> {
    const [indexGitmodules, headGitmodules, headGitlinks, indexGitlinks] = await Promise.all([
      this.reader.readGitmodulesFrom(parentRepoPath, ":.gitmodules"),
      this.reader.readGitmodulesFrom(parentRepoPath, "HEAD:.gitmodules"),
      this.reader.readHeadGitlinks(parentRepoPath),
      this.reader.readIndexGitlinks(parentRepoPath),
    ]);
    return mergeDeclaredSubmodules({
      indexGitmodules,
      headGitmodules,
      headGitlinks,
      indexGitlinks,
    });
  }

  private async collectPointerUpdates(
    parentRepoPath: string,
    declared: readonly DeclaredSubmodule[],
  ): Promise<SubmodulePointerUpdate[]> {
    const updates: SubmodulePointerUpdate[] = [];

    for (const entry of declared) {
      const headSha = entry.headGitlinkSha;
      if (!headSha) {
        continue;
      }

      const indexSha = entry.indexGitlinkSha ?? headSha;
      const checkout = await this.readChildCheckout(parentRepoPath, entry);
      const branch = checkout.branch;

      if (indexSha !== headSha) {
        updates.push(
          await this.buildUpdate(parentRepoPath, entry.relativePath, {
            beforeHead: headSha,
            afterHead: indexSha,
            branch,
            staged: true,
          }),
        );
      }

      if (checkout.headSha && checkout.headSha !== indexSha) {
        updates.push(
          await this.buildUpdate(parentRepoPath, entry.relativePath, {
            beforeHead: indexSha,
            afterHead: checkout.headSha,
            branch,
            staged: false,
          }),
        );
      }
    }

    return updates;
  }

  private async buildUpdate(
    rootRepoPath: string,
    relativePath: string,
    input: {
      beforeHead: string;
      afterHead: string;
      branch: string;
      staged: boolean;
    },
    depth = 0,
    visiting: Set<string> = new Set(),
  ): Promise<SubmodulePointerUpdate> {
    const checkoutPath = joinRepoPath(rootRepoPath, relativePath);
    const visitKey = `${relativePath}:${input.beforeHead}:${input.afterHead}`;
    if (visiting.has(visitKey) || depth > MAX_NESTED_SUBMODULE_DEPTH) {
      return {
        path: relativePath,
        beforeHead: input.beforeHead,
        afterHead: input.afterHead,
        branch: input.branch,
        staged: input.staged,
        commits: [],
      };
    }
    visiting.add(visitKey);

    const summaries = await this.readCommitSummaries(checkoutPath, input.beforeHead, input.afterHead);
    const commits: SubmoduleCommitEntry[] = [];
    for (const summary of summaries) {
      const nestedUpdates =
        depth < MAX_NESTED_SUBMODULE_DEPTH
          ? await this.collectNestedUpdatesForCommit(
              rootRepoPath,
              relativePath,
              checkoutPath,
              summary.sha,
              input.staged,
              depth + 1,
              visiting,
            )
          : [];
      commits.push({
        sha: summary.sha,
        subject: summary.subject,
        nestedUpdates,
      });
    }

    visiting.delete(visitKey);
    return {
      path: relativePath,
      beforeHead: input.beforeHead,
      afterHead: input.afterHead,
      branch: input.branch,
      staged: input.staged,
      commits,
    };
  }

  private async collectNestedUpdatesForCommit(
    rootRepoPath: string,
    parentRelativePath: string,
    parentCheckoutPath: string,
    commitSha: string,
    staged: boolean,
    depth: number,
    visiting: Set<string>,
  ): Promise<SubmodulePointerUpdate[]> {
    try {
      const [beforeLinks, afterLinks] = await Promise.all([
        this.readGitlinkMap(parentCheckoutPath, `${commitSha}^`),
        this.readGitlinkMap(parentCheckoutPath, commitSha),
      ]);
      const nestedUpdates: SubmodulePointerUpdate[] = [];

      for (const [gitlinkPath, afterSha] of afterLinks) {
        const beforeSha = beforeLinks.get(gitlinkPath);
        if (!beforeSha || beforeSha === afterSha) {
          continue;
        }
        const nestedRelativePath = this.joinRelativePath(parentRelativePath, gitlinkPath);
        if (!nestedRelativePath) {
          continue;
        }
        const nestedCheckoutPath = joinRepoPath(rootRepoPath, nestedRelativePath);
        const branch = await this.readBranchLabel(nestedCheckoutPath);
        nestedUpdates.push(
          await this.buildUpdate(
            rootRepoPath,
            nestedRelativePath,
            {
              beforeHead: beforeSha,
              afterHead: afterSha,
              branch,
              staged,
            },
            depth,
            visiting,
          ),
        );
      }

      return nestedUpdates;
    } catch {
      return [];
    }
  }

  private joinRelativePath(parentRelativePath: string, gitlinkPath: string): string | null {
    const parent = normalizeGitRelativePath(parentRelativePath);
    const child = normalizeGitRelativePath(gitlinkPath);
    if (!parent || !child) {
      return null;
    }
    return path.posix.join(parent, child);
  }

  private async readGitlinkMap(repoPath: string, treeish: string): Promise<Map<string, string>> {
    try {
      const links = await this.reader.readTreeGitlinks(repoPath, treeish);
      const map = new Map<string, string>();
      for (const link of links) {
        const normalized = normalizeGitRelativePath(link.path);
        if (normalized) {
          map.set(normalized, link.sha);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async readCommitSummaries(
    childRepoPath: string,
    fromHead: string,
    toHead: string,
  ): Promise<CommitSummary[]> {
    const rangeSummaries = await this.tryReadLogRange(childRepoPath, fromHead, toHead);
    if (rangeSummaries.length > 0) {
      return rangeSummaries;
    }
    if (fromHead === toHead) {
      return [];
    }
    const tip = await this.tryReadSingleCommitSummary(childRepoPath, toHead);
    return tip ? [tip] : [];
  }

  private async tryReadLogRange(
    childRepoPath: string,
    fromHead: string,
    toHead: string,
  ): Promise<CommitSummary[]> {
    try {
      const result = await this.cli.run({
        cwd: childRepoPath,
        args: ["log", "--format=%H%x00%s", "--reverse", `${fromHead}..${toHead}`],
      });
      return this.parseCommitLogOutput(result.stdout);
    } catch {
      return [];
    }
  }

  private async tryReadSingleCommitSummary(childRepoPath: string, commitSha: string): Promise<CommitSummary | null> {
    try {
      const result = await this.cli.run({
        cwd: childRepoPath,
        args: ["log", "-1", "--format=%H%x00%s", commitSha],
      });
      return this.parseCommitLogOutput(result.stdout)[0] ?? null;
    } catch {
      return null;
    }
  }

  private parseCommitLogOutput(stdout: string): CommitSummary[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const splitAt = line.indexOf("\0");
        if (splitAt === -1) {
          return null;
        }
        const sha = parseSha(line.slice(0, splitAt));
        const subject = line.slice(splitAt + 1).trim();
        if (!sha || !subject) {
          return null;
        }
        return { sha, subject };
      })
      .filter((entry): entry is CommitSummary => entry !== null);
  }

  private async readChildCheckout(parentRepoPath: string, entry: DeclaredSubmodule): Promise<ChildCheckoutState> {
    const childRepoPath = path.join(parentRepoPath, entry.relativePath);
    const initialized = await this.reader.isWorkTreeRoot(childRepoPath);
    if (!initialized) {
      return { headSha: null, branch: entry.configuredBranch ?? "detached HEAD" };
    }

    const [headResult, branchResult] = await Promise.all([
      this.cli.run({ cwd: childRepoPath, args: ["rev-parse", "HEAD"] }),
      this.cli.run({ cwd: childRepoPath, args: ["branch", "--show-current"] }),
    ]);

    const headSha = parseSha(headResult.stdout.trim());
    const currentBranch = branchResult.stdout.trim();
    const branch = currentBranch || "detached HEAD";
    return { headSha, branch };
  }

  private async readBranchLabel(checkoutPath: string): Promise<string> {
    const initialized = await this.reader.isWorkTreeRoot(checkoutPath);
    if (!initialized) {
      return "detached HEAD";
    }
    try {
      const branchResult = await this.cli.run({ cwd: checkoutPath, args: ["branch", "--show-current"] });
      const currentBranch = branchResult.stdout.trim();
      return currentBranch || "detached HEAD";
    } catch {
      return "detached HEAD";
    }
  }
}

import * as path from "node:path";
import { mergeDeclaredSubmodules } from "../git/declaredSubmodules.js";
import type { GitCli } from "../git/gitCli.js";
import { GitRepositoryReader } from "../git/gitRepositoryReader.js";
import { parseSha } from "../git/sha.js";
import type { DeclaredSubmodule } from "../git/types.js";
import { buildSubmoduleChoreMessage } from "./submoduleChoreMessage.js";
import type {
  SubmoduleChorePreview,
  SubmoduleChorePreviewOptions,
  SubmoduleChoreReadService as SubmoduleChoreReadServiceInterface,
  SubmodulePointerUpdate,
} from "./submoduleChoreTypes.js";

interface ChildCheckoutState {
  headSha: string | null;
  branch: string;
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

    const message = buildSubmoduleChoreMessage({ updates, subject: options.subject });
    return {
      subject: message.subject,
      body: message.body,
      message: message.message,
      updates,
      hasUnstagedUpdates: message.hasUnstagedUpdates,
      unstagedNote: message.unstagedNote,
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
    parentRepoPath: string,
    relativePath: string,
    input: {
      beforeHead: string;
      afterHead: string;
      branch: string;
      staged: boolean;
    },
  ): Promise<SubmodulePointerUpdate> {
    const childRepoPath = path.join(parentRepoPath, relativePath);
    const subjects = await this.tryReadCommitSubjects(childRepoPath, input.beforeHead, input.afterHead);
    return {
      path: relativePath,
      beforeHead: input.beforeHead,
      afterHead: input.afterHead,
      branch: input.branch,
      subjects,
      staged: input.staged,
    };
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

  private async tryReadCommitSubjects(childRepoPath: string, fromHead: string, toHead: string): Promise<string[]> {
    try {
      const result = await this.cli.run({
        cwd: childRepoPath,
        args: ["log", "--format=%s", `${fromHead}..${toHead}`],
      });
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

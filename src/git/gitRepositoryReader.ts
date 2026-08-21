import * as path from "node:path";
import * as fs from "node:fs";
import { GitCliError, type GitCli } from "./gitCli.js";
import { parseGitmodules } from "./gitmodulesParser.js";
import { parseLsFilesGitlinks, parseLsTreeGitlinks } from "./gitlinkParser.js";
import { parseNameStatusZ } from "./nameStatusParser.js";
import { parsePorcelainV2, GIT_IN_PROGRESS_MARKERS } from "./repoStatus.js";
import { assertSha } from "./sha.js";
import { sameRepoPath } from "./pathUtils.js";
import type { GitlinkEntry, GitmodulesEntry, NameStatusEntry, PorcelainStatus } from "./types.js";

export interface PathExistence {
  exists(pathName: string): boolean;
}

export const nodePathExistence: PathExistence = {
  exists: (pathName: string) => fs.existsSync(pathName),
};

export class GitRepositoryReader {
  constructor(
    private readonly cli: GitCli,
    private readonly paths: PathExistence = nodePathExistence,
  ) {}

  async isWorkTreeRoot(folder: string): Promise<boolean> {
    try {
      const inside = await this.cli.run({
        cwd: folder,
        args: ["rev-parse", "--is-inside-work-tree"],
      });
      if (inside.stdout.trim() !== "true") {
        return false;
      }
      const toplevel = await this.cli.run({
        cwd: folder,
        args: ["rev-parse", "--show-toplevel"],
      });
      return sameRepoPath(toplevel.stdout.trim(), folder);
    } catch {
      return false;
    }
  }

  async readGitmodulesFrom(cwd: string, spec: "HEAD:.gitmodules" | ":.gitmodules"): Promise<GitmodulesEntry[]> {
    try {
      const result = await this.cli.run({
        cwd,
        args: ["show", spec],
        allowedExitCodes: [0, 128],
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        return [];
      }
      return parseGitmodules(result.stdout);
    } catch (error) {
      if (error instanceof GitCliError) {
        return [];
      }
      throw error;
    }
  }

  async readHeadGitlinks(cwd: string): Promise<GitlinkEntry[]> {
    try {
      const result = await this.cli.run({
        cwd,
        args: ["ls-tree", "-r", "-z", "HEAD"],
        allowedExitCodes: [0, 128],
      });
      if (result.exitCode !== 0) {
        return [];
      }
      return parseLsTreeGitlinks(result.stdout);
    } catch (error) {
      if (error instanceof GitCliError) {
        return [];
      }
      throw error;
    }
  }

  async readIndexGitlinks(cwd: string): Promise<GitlinkEntry[]> {
    try {
      const result = await this.cli.run({
        cwd,
        args: ["ls-files", "--stage", "-z"],
      });
      return parseLsFilesGitlinks(result.stdout);
    } catch (error) {
      if (error instanceof GitCliError) {
        return [];
      }
      throw error;
    }
  }

  async readStatus(cwd: string): Promise<PorcelainStatus> {
    const result = await this.cli.run({
      cwd,
      args: ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"],
    });
    return parsePorcelainV2(result.stdout);
  }

  async hasOperationInProgress(cwd: string): Promise<boolean> {
    try {
      const result = await this.cli.run({
        cwd,
        args: ["rev-parse", "--absolute-git-dir"],
      });
      const gitDir = result.stdout.trim();
      if (!gitDir) {
        return false;
      }
      return GIT_IN_PROGRESS_MARKERS.some((marker) => this.paths.exists(path.join(gitDir, marker)));
    } catch {
      return false;
    }
  }

  async listNameStatus(cwd: string, fromSha: string, toSha: string): Promise<NameStatusEntry[]> {
    const from = assertSha(fromSha, "fromSha");
    const to = assertSha(toSha, "toSha");
    const result = await this.cli.run({
      cwd,
      args: ["diff", "--name-status", "-z", "--find-renames", from, to],
    });
    return parseNameStatusZ(result.stdout);
  }
}

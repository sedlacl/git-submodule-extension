import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitCliRunner, type GitCli, type GitRunOptions, type GitRunResult } from "../../src/git/gitCli.js";
import {
  ResourceStatus,
  type RepositoryStateSnapshot,
  type ResourceChange,
} from "../../src/git/repositoryState.js";
import type { GitRepoNode, WorkspaceGitModel } from "../../src/git/types.js";
import {
  addSubmodule,
  commitFile,
  initRepo,
  runGit,
} from "../../scripts/lib/git-fixture.js";
import { toFileUrl } from "../../scripts/lib/paths.js";

export const GIT_PATH = "git";

export const FORBIDDEN_AUTO_GIT_VERBS = [
  "fetch",
  "pull",
  "push",
  "commit",
  "merge",
  "rebase",
  "reset",
  "clean",
  "stash",
  "checkout",
  "restore",
] as const;

export class RecordingCli implements GitCli {
  readonly calls: string[][] = [];

  constructor(private readonly inner: GitCli) {}

  async run(options: GitRunOptions): Promise<GitRunResult> {
    this.calls.push([...options.args]);
    return this.inner.run(options);
  }

  verbs(): string[] {
    return this.calls.map((args) => args[0] ?? "");
  }
}

export function createGitCli(): GitCliRunner {
  return new GitCliRunner(GIT_PATH);
}

export function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export function sha(cwd: string, spec = "HEAD"): string {
  return runGit(cwd, ["rev-parse", spec]).trim();
}

export function createRestoreRepos(root: string): {
  source: string;
  parent: string;
  childRel: string;
  child: string;
  pin: string;
} {
  const source = path.join(root, "source");
  const parent = path.join(root, "parent");
  const childRel = "modules/child";
  initRepo(source, "main");
  commitFile(source, "README.md", "# source\n", "init source");
  initRepo(parent, "main");
  commitFile(parent, "README.md", "# parent\n", "init parent");
  addSubmodule(parent, childRel, toFileUrl(source), "main");
  runGit(parent, ["add", "-A"]);
  runGit(parent, ["commit", "-m", "add child"]);
  const child = path.join(parent, childRel);
  const pin = sha(parent, `HEAD:${childRel}`);
  return { source, parent, childRel, child, pin };
}

export function collectRepositorySnapshots(model: WorkspaceGitModel): RepositoryStateSnapshot[] {
  const snapshots: RepositoryStateSnapshot[] = [];
  const visit = (node: GitRepoNode): void => {
    try {
      snapshots.push(snapshotRepositoryFromGit(node.rootPath));
    } catch {
      // Uninitialized or missing work trees stay handle-less.
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of model.roots) {
    visit(root);
  }
  return snapshots;
}

export function snapshotRepositoryFromGit(rootPath: string): RepositoryStateSnapshot {
  const porcelain = runGit(rootPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const groups: { merge: ResourceChange[]; index: ResourceChange[]; workingTree: ResourceChange[]; untracked: ResourceChange[] } = {
    merge: [],
    index: [],
    workingTree: [],
    untracked: [],
  };
  for (const line of porcelain.split("\n")) {
    if (line) {
      parsePorcelainLine(rootPath, line, groups);
    }
  }

  let name: string | undefined;
  let detached = false;
  try {
    const abbrev = runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (abbrev === "HEAD") {
      detached = true;
    } else {
      name = abbrev;
    }
  } catch {
    detached = true;
  }

  return {
    rootPath,
    head: { name, detached },
    remotes: [],
    groups,
  };
}

function parsePorcelainLine(rootPath: string, line: string, groups: MutableGroups): void {
  if (line.length < 2) {
    return;
  }
  const x = line[0]!;
  const y = line[1]!;
  const rest = line.length >= 3 && line[2] === " " ? line.slice(3) : line.slice(2);
  if (x === "?" && y === "?") {
    groups.untracked.push(toChange(rootPath, rest, ResourceStatus.UNTRACKED));
    return;
  }
  if (x === "!" && y === "!") {
    groups.untracked.push(toChange(rootPath, rest, ResourceStatus.IGNORED));
    return;
  }
  const unmerged = unmergedStatus(`${x}${y}`);
  if (unmerged !== undefined) {
    groups.merge.push(toChange(rootPath, rest, unmerged));
    return;
  }
  const { original, current } = parseRenamePath(rest);
  const indexStatus = indexStatusFrom(x);
  const workStatus = worktreeStatusFrom(y);
  if (indexStatus !== undefined) {
    groups.index.push(toChange(rootPath, current, indexStatus, original));
  }
  if (workStatus !== undefined) {
    groups.workingTree.push(toChange(rootPath, current, workStatus, original));
  }
}

function parseRenamePath(rest: string): { original: string; current: string } {
  const arrow = rest.indexOf(" -> ");
  if (arrow === -1) {
    return { original: rest, current: rest };
  }
  return { original: rest.slice(0, arrow), current: rest.slice(arrow + 4) };
}

function toChange(
  rootPath: string,
  relativePath: string,
  status: ResourceStatus,
  originalPath = relativePath,
): ResourceChange {
  const posix = relativePath.replace(/\\/g, "/");
  const originalPosix = originalPath.replace(/\\/g, "/");
  const uri = path.join(rootPath, ...posix.split("/"));
  const originalUri = path.join(rootPath, ...originalPosix.split("/"));
  return {
    uri,
    originalUri,
    renameUri: originalPosix !== posix ? uri : undefined,
    status,
    relativePath: posix,
  };
}

function indexStatusFrom(code: string): ResourceStatus | undefined {
  switch (code) {
    case "M":
      return ResourceStatus.INDEX_MODIFIED;
    case "A":
      return ResourceStatus.INDEX_ADDED;
    case "D":
      return ResourceStatus.INDEX_DELETED;
    case "R":
      return ResourceStatus.INDEX_RENAMED;
    case "C":
      return ResourceStatus.INDEX_COPIED;
    default:
      return undefined;
  }
}

function worktreeStatusFrom(code: string): ResourceStatus | undefined {
  switch (code) {
    case "M":
      return ResourceStatus.MODIFIED;
    case "D":
      return ResourceStatus.DELETED;
    case "A":
      return ResourceStatus.INTENT_TO_ADD;
    case "R":
      return ResourceStatus.INTENT_TO_RENAME;
    default:
      return undefined;
  }
}

function unmergedStatus(xy: string): ResourceStatus | undefined {
  switch (xy) {
    case "DD":
      return ResourceStatus.BOTH_DELETED;
    case "AU":
      return ResourceStatus.ADDED_BY_US;
    case "UD":
      return ResourceStatus.DELETED_BY_THEM;
    case "UA":
      return ResourceStatus.ADDED_BY_THEM;
    case "DU":
      return ResourceStatus.DELETED_BY_US;
    case "AA":
      return ResourceStatus.BOTH_ADDED;
    case "UU":
      return ResourceStatus.BOTH_MODIFIED;
    default:
      return undefined;
  }
}

type MutableGroups = {
  merge: ResourceChange[];
  index: ResourceChange[];
  workingTree: ResourceChange[];
  untracked: ResourceChange[];
};

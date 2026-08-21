import { normalizeRepoPath } from "../git/pathUtils.js";
import { CHANGE_GROUP_ORDER, type RepositoryStateSnapshot } from "../git/repositoryState.js";
import type { GitRepoNode, WorkspaceGitModel } from "../git/types.js";

/**
 * Full `discoverWorkspaceGitModel` is only required when gitlink/HEAD inputs
 * change. Ordinary staged/unstaged file moves are already in vscode.git
 * repository state and must overlay the cached graph without CLI probes.
 */
export function gitModelNeedsRediscovery(
  model: WorkspaceGitModel | undefined,
  previous: RepositoryStateSnapshot | undefined,
  next: RepositoryStateSnapshot,
): boolean {
  if (!model || !previous) {
    return true;
  }
  if ((previous.head?.commit ?? "") !== (next.head?.commit ?? "")) {
    return true;
  }
  const childPaths = childRelativePaths(model, next.rootPath);
  if (childPaths.size === 0) {
    return false;
  }
  return gitlinkSignature(previous, childPaths) !== gitlinkSignature(next, childPaths);
}

export function childRelativePaths(model: WorkspaceGitModel, rootPath: string): Set<string> {
  const node = lookupNode(model, rootPath);
  return new Set((node?.children ?? []).map((child) => child.relativePath));
}

function lookupNode(model: WorkspaceGitModel, rootPath: string): GitRepoNode | undefined {
  const direct = model.nodesByRootPath.get(rootPath);
  if (direct) {
    return direct;
  }
  const normalized = normalizeRepoPath(rootPath);
  for (const [key, node] of model.nodesByRootPath) {
    if (normalizeRepoPath(key) === normalized) {
      return node;
    }
  }
  return undefined;
}

function gitlinkSignature(snapshot: RepositoryStateSnapshot, childPaths: ReadonlySet<string>): string {
  const parts: string[] = [];
  for (const group of CHANGE_GROUP_ORDER) {
    for (const change of snapshot.groups[group]) {
      if (childPaths.has(change.relativePath)) {
        parts.push(`${group}:${change.relativePath}:${change.status}`);
      }
    }
  }
  return parts.sort().join("|");
}

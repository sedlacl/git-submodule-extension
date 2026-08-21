import { computeAdoptedPointers, hasPointerMismatch } from "./adoptedPointers.js";
import { mergeDeclaredSubmodules } from "./declaredSubmodules.js";
import type { GitRepositoryReader } from "./gitRepositoryReader.js";
import {
  canonicalizeRepoPath,
  displayNameFromRepoPath,
  joinRepoPath,
} from "./pathUtils.js";
import { classifyWorkingState } from "./repoStatus.js";
import type {
  DeclaredSubmodule,
  DiscoveryInput,
  GitRepoNode,
  SubmoduleNode,
  WorkspaceGitModel,
  WorkspaceRootNode,
} from "./types.js";

export async function discoverWorkspaceGitModel(
  reader: GitRepositoryReader,
  input: DiscoveryInput,
): Promise<WorkspaceGitModel> {
  const workspaceFolders = uniqueNormalized(input.workspaceFolderPaths);
  const workTreeRoots: string[] = [];
  for (const folder of workspaceFolders) {
    if (await reader.isWorkTreeRoot(folder)) {
      workTreeRoots.push(folder);
    }
  }

  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, SubmoduleNode[]>();
  const loadingParents = new Set<string>();
  const visiting = new Set<string>();

  const loadChildren = async (parentRoot: string): Promise<SubmoduleNode[]> => {
    const cached = childrenByParent.get(parentRoot);
    if (cached) {
      return cached;
    }

    const children: SubmoduleNode[] = [];
    childrenByParent.set(parentRoot, children);
    loadingParents.add(parentRoot);

    try {
      const declared = await readDeclared(reader, parentRoot);
      for (const entry of declared) {
        const childRoot = canonicalizeRepoPath(joinRepoPath(parentRoot, entry.relativePath));
        if (childRoot === parentRoot || visiting.has(childRoot) || loadingParents.has(childRoot)) {
          continue;
        }

        const existingParent = parentByChild.get(childRoot);
        if (existingParent && existingParent !== parentRoot) {
          continue;
        }
        parentByChild.set(childRoot, parentRoot);

        visiting.add(childRoot);
        const node = await buildSubmoduleNode(reader, parentRoot, childRoot, entry, loadChildren);
        visiting.delete(childRoot);
        children.push(node);
      }
    } finally {
      loadingParents.delete(parentRoot);
    }

    return children;
  };

  for (const root of workTreeRoots) {
    await loadChildren(root);
  }

  const roots: WorkspaceRootNode[] = [];
  for (const folder of workTreeRoots) {
    if (parentByChild.has(folder)) {
      continue;
    }
    roots.push({
      id: folder,
      kind: "workspace-root",
      rootPath: folder,
      workspaceFolderPath: folder,
      displayName: displayNameFromRepoPath(folder),
      children: childrenByParent.get(folder) ?? [],
    });
  }

  const nodesByRootPath = new Map<string, GitRepoNode>();
  const indexNode = (node: GitRepoNode): void => {
    nodesByRootPath.set(node.rootPath, node);
    for (const child of node.children) {
      indexNode(child);
    }
  };
  for (const root of roots) {
    indexNode(root);
  }

  return { roots, nodesByRootPath };
}

async function readDeclared(reader: GitRepositoryReader, parentRoot: string): Promise<DeclaredSubmodule[]> {
  const [indexGitmodules, headGitmodules, headGitlinks, indexGitlinks] = await Promise.all([
    reader.readGitmodulesFrom(parentRoot, ":.gitmodules"),
    reader.readGitmodulesFrom(parentRoot, "HEAD:.gitmodules"),
    reader.readHeadGitlinks(parentRoot),
    reader.readIndexGitlinks(parentRoot),
  ]);
  return mergeDeclaredSubmodules({
    indexGitmodules,
    headGitmodules,
    headGitlinks,
    indexGitlinks,
  });
}

async function buildSubmoduleNode(
  reader: GitRepositoryReader,
  parentRoot: string,
  childRoot: string,
  entry: DeclaredSubmodule,
  loadChildren: (parentRoot: string) => Promise<SubmoduleNode[]>,
): Promise<SubmoduleNode> {
  const initialized = await reader.isWorkTreeRoot(childRoot);
  let checkoutHeadSha: string | null = null;
  let branchName: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let detached = false;
  let dirty = false;
  let operationInProgress = false;
  let probeFailed = false;
  let nested: SubmoduleNode[] = [];

  if (initialized) {
    try {
      const [status, inProgress] = await Promise.all([
        reader.readStatus(childRoot),
        reader.hasOperationInProgress(childRoot),
      ]);
      checkoutHeadSha = status.oid;
      branchName = status.head;
      upstream = status.upstream;
      ahead = status.ahead;
      behind = status.behind;
      detached = status.detached;
      dirty = status.dirty;
      operationInProgress = inProgress;
      nested = await loadChildren(childRoot);
    } catch {
      probeFailed = true;
    }
  }

  const pins = {
    headGitlinkSha: entry.headGitlinkSha,
    indexGitlinkSha: entry.indexGitlinkSha,
    checkoutHeadSha,
  };

  return {
    id: childRoot,
    kind: "submodule",
    rootPath: childRoot,
    displayName: displayNameFromRepoPath(childRoot),
    parentRootPath: parentRoot,
    relativePath: entry.relativePath,
    name: entry.name,
    url: entry.url,
    pins,
    branch: {
      name: branchName,
      upstream,
      ahead,
      behind,
      detached,
      configuredBranch: entry.configuredBranch,
      committedConfiguredBranch: entry.committedConfiguredBranch,
    },
    workingState: classifyWorkingState({
      uninitialized: !initialized,
      probeFailed,
      detached,
      dirty,
      ahead,
      behind,
      pointerMismatch: initialized && hasPointerMismatch(pins),
      operationInProgress,
    }),
    adoptedChanges: computeAdoptedPointers(pins),
    children: nested,
  };
}

function uniqueNormalized(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of paths) {
    const normalized = canonicalizeRepoPath(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

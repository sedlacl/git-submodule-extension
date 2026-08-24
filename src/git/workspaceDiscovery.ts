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
  const runGit = createLimiter(4);
  const workspaceFolders = uniqueNormalized(input.workspaceFolderPaths);
  const workTreeChecks = await Promise.all(
    workspaceFolders.map(async (folder) => ({
      folder,
      isRoot: await runGit(() => reader.isWorkTreeRoot(folder)),
    })),
  );
  const workTreeRoots = workTreeChecks.filter((check) => check.isRoot).map((check) => check.folder);

  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, SubmoduleNode[]>();

  const loadChildren = async (
    parentRoot: string,
    ancestors: ReadonlySet<string> = new Set(),
  ): Promise<SubmoduleNode[]> => {
    const cached = childrenByParent.get(parentRoot);
    if (cached) {
      return cached;
    }

    const children: SubmoduleNode[] = [];
    childrenByParent.set(parentRoot, children);
    const declared = await readDeclared(reader, parentRoot, runGit);
    const entries: Array<{ childRoot: string; entry: DeclaredSubmodule }> = [];
    for (const entry of declared) {
      const childRoot = canonicalizeRepoPath(joinRepoPath(parentRoot, entry.relativePath));
      if (childRoot === parentRoot || ancestors.has(childRoot)) {
        continue;
      }

      const existingParent = parentByChild.get(childRoot);
      if (existingParent && existingParent !== parentRoot) {
        continue;
      }
      parentByChild.set(childRoot, parentRoot);
      entries.push({ childRoot, entry });
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(parentRoot);
    const loaded = await Promise.all(
      entries.map(({ childRoot, entry }) =>
        buildSubmoduleNode(
          reader,
          parentRoot,
          childRoot,
          entry,
          (root) => loadChildren(root, nextAncestors),
          runGit,
        ),
      ),
    );
    children.push(...loaded);

    return children;
  };

  await Promise.all(workTreeRoots.map((root) => loadChildren(root)));

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

async function readDeclared(
  reader: GitRepositoryReader,
  parentRoot: string,
  runGit: Limiter,
): Promise<DeclaredSubmodule[]> {
  const [indexGitmodules, headGitmodules, headGitlinks, indexGitlinks] = await Promise.all([
    runGit(() => reader.readGitmodulesFrom(parentRoot, ":.gitmodules")),
    runGit(() => reader.readGitmodulesFrom(parentRoot, "HEAD:.gitmodules")),
    runGit(() => reader.readHeadGitlinks(parentRoot)),
    runGit(() => reader.readIndexGitlinks(parentRoot)),
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
  runGit: Limiter,
): Promise<SubmoduleNode> {
  const initialized = await runGit(() => reader.isWorkTreeRoot(childRoot));
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
        runGit(() => reader.readStatus(childRoot)),
        runGit(() => reader.hasOperationInProgress(childRoot)),
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

type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

function createLimiter(limit: number): Limiter {
  let active = 0;
  const pending: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    pending.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => pending.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

import type {
  AdoptedPointerChanges,
  NameStatusEntry,
  RepoWorkingState,
  SubmoduleNode,
  WorkspaceGitModel,
  WorkspaceRootNode,
} from "./types.js";

/**
 * Snapshot consumed by the SCM TreeView. Roots are independent workspace
 * folders; submodule nodes are nested by immediate gitlink parenthood.
 */
export interface SubmoduleViewModel {
  readonly roots: readonly WorkspaceRootNode[];
}

export type AdoptedChangeKind = "staged" | "unstaged";

export interface AdoptedDiffSpec {
  repoRoot: string;
  fromSha: string;
  toSha: string;
  kind: AdoptedChangeKind;
}

/**
 * File-level adopted diff used by the view to open `vscode.diff` / `vscode.changes`.
 * Compare SHAs inside the *child* repository (A→B of the gitlink pointer).
 */
export interface AdoptedDiffReader {
  listNameStatus(spec: AdoptedDiffSpec): Promise<readonly NameStatusEntry[]>;
}

export interface AdoptedChangesLookup {
  getChanges(node: SubmoduleNode): AdoptedPointerChanges;
}

/**
 * Fail-closed inputs for branch restore. The model never switch/fetch/push;
 * restore owns those Git writes after re-validating this snapshot.
 */
export interface BranchRestoreTarget {
  parentRootPath: string;
  relativePath: string;
  childRootPath: string;
  /** From committed `HEAD:.gitmodules`. */
  targetBranch: string | null;
  /** From the parent HEAD gitlink. */
  targetPin: string | null;
  currentBranch: string | null;
  currentHeadSha: string | null;
  upstream: string | null;
  workingState: RepoWorkingState;
}

export interface BranchRestoreService {
  reconcile(target: BranchRestoreTarget): Promise<BranchRestoreResult>;
}

export type BranchRestoreAction = "attached" | "already-attached" | "blocked" | "skipped";

export interface BranchRestoreResult {
  path: string;
  action: BranchRestoreAction;
  detail: string;
}

export interface GitModelProvider {
  snapshot(): Promise<WorkspaceGitModel>;
}

export function toBranchRestoreTarget(node: SubmoduleNode): BranchRestoreTarget {
  return {
    parentRootPath: node.parentRootPath,
    relativePath: node.relativePath,
    childRootPath: node.rootPath,
    targetBranch: node.branch.committedConfiguredBranch,
    targetPin: node.pins.headGitlinkSha,
    currentBranch: node.branch.name,
    currentHeadSha: node.pins.checkoutHeadSha,
    upstream: node.branch.upstream,
    workingState: node.workingState,
  };
}

export function toSubmoduleViewModel(model: WorkspaceGitModel): SubmoduleViewModel {
  return { roots: model.roots };
}

export function getAdoptedChanges(node: SubmoduleNode): AdoptedPointerChanges {
  return node.adoptedChanges;
}

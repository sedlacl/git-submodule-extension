export type GitNodeKind = "workspace-root" | "submodule";

export interface GitmodulesEntry {
  name: string;
  path: string;
  url: string | null;
  branch: string | null;
}

export interface GitlinkEntry {
  path: string;
  sha: string;
  stage: number;
}

export interface DeclaredSubmodule {
  relativePath: string;
  name: string;
  url: string | null;
  configuredBranch: string | null;
  committedConfiguredBranch: string | null;
  headGitlinkSha: string | null;
  indexGitlinkSha: string | null;
}

export interface RepoPins {
  /** SHA recorded in the parent HEAD gitlink (committed pin). */
  headGitlinkSha: string | null;
  /** SHA recorded in the parent index gitlink (staged pin). */
  indexGitlinkSha: string | null;
  /** SHA of the child checkout HEAD. */
  checkoutHeadSha: string | null;
}

export interface BranchInfo {
  name: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  detached: boolean;
  /** Branch from the parent's current (index/working) `.gitmodules`. */
  configuredBranch: string | null;
  /** Branch from the parent's `HEAD:.gitmodules` — restore target. */
  committedConfiguredBranch: string | null;
}

export interface RepoWorkingState {
  uninitialized: boolean;
  dirty: boolean;
  detached: boolean;
  /** Local branch has unique commits vs upstream (`ahead`/`behind` ≠ 0). */
  diverged: boolean;
  /** Checkout HEAD differs from the index gitlink (or HEAD gitlink if index is absent). */
  pointerMismatch: boolean;
  operationInProgress: boolean;
  probeFailed: boolean;
}

export interface AdoptedPointerChange {
  fromSha: string;
  toSha: string;
}

export interface AdoptedPointerChanges {
  /** Parent HEAD gitlink → parent index gitlink. */
  staged: AdoptedPointerChange | null;
  /** Parent index gitlink → child checkout HEAD. */
  unstaged: AdoptedPointerChange | null;
}

export interface PorcelainStatus {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  detached: boolean;
  dirty: boolean;
}

export type NameStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged"
  | "unknown";

export interface NameStatusEntry {
  status: NameStatusKind;
  path: string;
  oldPath?: string;
  similarity?: number;
}

interface GitNodeBase {
  id: string;
  kind: GitNodeKind;
  rootPath: string;
  displayName: string;
  children: SubmoduleNode[];
}

export interface WorkspaceRootNode extends GitNodeBase {
  kind: "workspace-root";
  workspaceFolderPath: string;
}

export interface SubmoduleNode extends GitNodeBase {
  kind: "submodule";
  parentRootPath: string;
  relativePath: string;
  name: string;
  url: string | null;
  pins: RepoPins;
  branch: BranchInfo;
  workingState: RepoWorkingState;
  adoptedChanges: AdoptedPointerChanges;
}

export type GitRepoNode = WorkspaceRootNode | SubmoduleNode;

export interface WorkspaceGitModel {
  roots: WorkspaceRootNode[];
  nodesByRootPath: ReadonlyMap<string, GitRepoNode>;
}

export interface DiscoveryInput {
  workspaceFolderPaths: readonly string[];
}

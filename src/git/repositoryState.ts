import * as path from "node:path";
import type { Branch, CommitOptions, FetchOptions, ForcePushMode, Ref, Remote, Repository } from "./git.js";
import { normalizeRepoPath } from "./pathUtils.js";

/**
 * Runtime copy of vscode.git `Status`. Values match
 * microsoft/vscode `extensions/git/src/api/git.d.ts` tag 1.96.0.
 */
export const ResourceStatus = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
} as const;

export type ResourceStatus = (typeof ResourceStatus)[keyof typeof ResourceStatus];

export type ChangeGroupKind = "merge" | "index" | "workingTree" | "untracked";

export const CHANGE_GROUP_ORDER: readonly ChangeGroupKind[] = ["merge", "index", "workingTree", "untracked"];

/** Built-in SCM group titles from microsoft/vscode Git `package.nls.json`. */
export const CHANGE_GROUP_LABELS: Record<ChangeGroupKind, string> = {
  merge: "Merge Changes",
  index: "Staged Changes",
  workingTree: "Changes",
  untracked: "Untracked Changes",
};

export interface PathUri {
  readonly fsPath: string;
}

export interface ChangeLike {
  readonly uri: PathUri;
  readonly originalUri: PathUri;
  readonly renameUri?: PathUri;
  readonly status: number;
}

export interface ResourceChange {
  readonly uri: string;
  readonly originalUri: string;
  readonly renameUri?: string;
  readonly status: ResourceStatus;
  readonly relativePath: string;
}

export interface RepositoryHead {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { remote: string; name: string; commit?: string };
  readonly ahead?: number;
  readonly behind?: number;
  readonly detached: boolean;
}

export interface RepositoryRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface RepositoryChangeGroups {
  readonly merge: readonly ResourceChange[];
  readonly index: readonly ResourceChange[];
  readonly workingTree: readonly ResourceChange[];
  readonly untracked: readonly ResourceChange[];
}

export interface RepositoryStateSnapshot {
  readonly rootPath: string;
  readonly head: RepositoryHead | undefined;
  readonly remotes: readonly RepositoryRemote[];
  readonly groups: RepositoryChangeGroups;
}

export interface ChangeGroupViewModel {
  readonly kind: ChangeGroupKind;
  readonly label: string;
  readonly resources: readonly ResourceChange[];
}

/** Tree layer: one repository node plus non-empty change groups in built-in order. */
export interface RepositoryTreeModel {
  readonly rootPath: string;
  readonly head: RepositoryHead | undefined;
  readonly groups: readonly ChangeGroupViewModel[];
}

/** Command layer: resources in one vscode.git group of a specific repository. */
export interface ChangeCommandTarget {
  readonly rootPath: string;
  readonly group: ChangeGroupKind;
  readonly resources: readonly ResourceChange[];
}

/** Command layer: repository row (commit / refresh / sync / publish). */
export interface RepositoryCommandTarget {
  readonly rootPath: string;
  readonly head: RepositoryHead | undefined;
}

export interface GitRepositoryOperations {
  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;
  commit(message: string, opts?: CommitOptions): Promise<void>;
  status(): Promise<void>;
  getBranches(): Promise<RepositoryBranch[]>;
  checkout(branchName: string): Promise<void>;
  fetch(options?: FetchOptions): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>;
}

export interface RepositoryBranch {
  readonly name: string;
  readonly commit?: string;
}

/**
 * Public vscode.git repository handle used by the command layer.
 * `rootPath` is `Repository.rootUri.fsPath`; lookups must tolerate separator/case differences.
 */
export interface GitRepositoryHandle {
  readonly rootPath: string;
  inputBoxValue: string;
  snapshot(): RepositoryStateSnapshot;
  operations(): GitRepositoryOperations;
}

export interface GitRepositoryProvider {
  getRepositoryHandle(rootPath: string): GitRepositoryHandle | undefined;
}

export interface RepositoryStateLike {
  readonly HEAD?: Branch;
  readonly remotes?: readonly Remote[];
  readonly mergeChanges?: readonly ChangeLike[];
  readonly indexChanges?: readonly ChangeLike[];
  readonly workingTreeChanges?: readonly ChangeLike[];
  readonly untrackedChanges?: readonly ChangeLike[];
}

export interface RepositoryLike {
  readonly rootUri: PathUri;
  readonly state: RepositoryStateLike;
}

type OperationsHost = Pick<
  Repository,
  "add" | "revert" | "clean" | "commit" | "status" | "getBranches" | "checkout" | "pull" | "push"
> & {
  fetch(options?: FetchOptions): Promise<void>;
};

const RENAME_STATUSES = new Set<number>([
  ResourceStatus.INDEX_RENAMED,
  ResourceStatus.INDEX_COPIED,
  ResourceStatus.INTENT_TO_RENAME,
]);

const UNTRACKED_OR_IGNORED = new Set<number>([ResourceStatus.UNTRACKED, ResourceStatus.IGNORED]);

export function snapshotRepository(repository: RepositoryLike): RepositoryStateSnapshot {
  const rootPath = repository.rootUri.fsPath;
  return {
    rootPath,
    head: snapshotHead(repository.state.HEAD),
    remotes: snapshotRemotes(repository.state.remotes),
    groups: snapshotChangeGroups(rootPath, repository.state),
  };
}

export function snapshotChangeGroups(repoRoot: string, state: RepositoryStateLike): RepositoryChangeGroups {
  const merge = mapChanges(repoRoot, state.mergeChanges);
  const index = mapChanges(repoRoot, state.indexChanges);
  if (state.untrackedChanges !== undefined) {
    return {
      merge,
      index,
      workingTree: mapChanges(repoRoot, state.workingTreeChanges),
      untracked: mapChanges(repoRoot, state.untrackedChanges),
    };
  }

  const mixed = mapChanges(repoRoot, state.workingTreeChanges);
  return {
    merge,
    index,
    workingTree: mixed.filter((change) => !UNTRACKED_OR_IGNORED.has(change.status)),
    untracked: mixed.filter((change) => UNTRACKED_OR_IGNORED.has(change.status)),
  };
}

export function snapshotChange(repoRoot: string, change: ChangeLike): ResourceChange {
  const uri = change.uri.fsPath;
  const originalUri = change.originalUri.fsPath;
  const renameUri = change.renameUri?.fsPath;
  return {
    uri,
    originalUri,
    renameUri,
    status: asResourceStatus(change.status),
    relativePath: toPosixRelative(repoRoot, uri),
  };
}

export function snapshotHead(head: Branch | undefined): RepositoryHead | undefined {
  if (!head) {
    return undefined;
  }
  return {
    name: head.name,
    commit: head.commit,
    upstream: head.upstream
      ? { remote: head.upstream.remote, name: head.upstream.name, commit: head.upstream.commit }
      : undefined,
    ahead: head.ahead,
    behind: head.behind,
    detached: !head.name,
  };
}

export function snapshotRemotes(remotes: readonly Remote[] | undefined): RepositoryRemote[] {
  return (remotes ?? []).map((remote) => ({
    name: remote.name,
    fetchUrl: remote.fetchUrl,
    pushUrl: remote.pushUrl,
    isReadOnly: remote.isReadOnly,
  }));
}

function branchRefs(refs: readonly Ref[]): RepositoryBranch[] {
  return refs
    .filter((ref): ref is Ref & { name: string } => Boolean(ref.name))
    .map((ref) => ({ name: ref.name, commit: ref.commit }));
}

export function visibleChangeGroups(groups: RepositoryChangeGroups): ChangeGroupViewModel[] {
  return CHANGE_GROUP_ORDER.filter((kind) => groups[kind].length > 0).map((kind) => ({
    kind,
    label: CHANGE_GROUP_LABELS[kind],
    resources: groups[kind],
  }));
}

export function toRepositoryTreeModel(snapshot: RepositoryStateSnapshot): RepositoryTreeModel {
  return {
    rootPath: snapshot.rootPath,
    head: snapshot.head,
    groups: visibleChangeGroups(snapshot.groups),
  };
}

export function isRenameChange(change: ResourceChange): boolean {
  return Boolean(change.renameUri) && (RENAME_STATUSES.has(change.status) || change.renameUri !== change.originalUri);
}

export function commandPaths(target: ChangeCommandTarget): string[] {
  return target.resources.map((resource) => resource.uri);
}

export function bindRepositoryOperations(repository: OperationsHost): GitRepositoryOperations {
  return {
    add: (paths) => repository.add(paths),
    revert: (paths) => repository.revert(paths),
    clean: (paths) => repository.clean(paths),
    commit: (message, opts) => repository.commit(message, opts),
    status: () => repository.status(),
    getBranches: async () => branchRefs(await repository.getBranches({ remote: false, sort: "alphabetically" })),
    checkout: (branchName) => repository.checkout(branchName),
    fetch: (options) => repository.fetch(options),
    pull: (unshallow) => repository.pull(unshallow),
    push: (remoteName, branchName, setUpstream, force) =>
      repository.push(remoteName, branchName, setUpstream, force),
  };
}

export function indexSnapshots(snapshots: readonly RepositoryStateSnapshot[]): Map<string, RepositoryStateSnapshot> {
  const map = new Map<string, RepositoryStateSnapshot>();
  for (const snapshot of snapshots) {
    map.set(snapshot.rootPath, snapshot);
    map.set(normalizeRepoPath(snapshot.rootPath), snapshot);
  }
  return map;
}

export function lookupSnapshot(
  rootPath: string,
  snapshots: ReadonlyMap<string, RepositoryStateSnapshot>,
): RepositoryStateSnapshot | undefined {
  return snapshots.get(rootPath) ?? snapshots.get(normalizeRepoPath(rootPath));
}

export function resourceStatusLetter(status: ResourceStatus): string {
  switch (status) {
    case ResourceStatus.INDEX_MODIFIED:
    case ResourceStatus.MODIFIED:
      return "M";
    case ResourceStatus.INDEX_ADDED:
    case ResourceStatus.INTENT_TO_ADD:
      return "A";
    case ResourceStatus.INDEX_DELETED:
    case ResourceStatus.DELETED:
      return "D";
    case ResourceStatus.INDEX_RENAMED:
    case ResourceStatus.INTENT_TO_RENAME:
      return "R";
    case ResourceStatus.TYPE_CHANGED:
      return "T";
    case ResourceStatus.UNTRACKED:
      return "U";
    case ResourceStatus.IGNORED:
      return "I";
    case ResourceStatus.INDEX_COPIED:
      return "C";
    case ResourceStatus.BOTH_DELETED:
    case ResourceStatus.ADDED_BY_US:
    case ResourceStatus.DELETED_BY_THEM:
    case ResourceStatus.ADDED_BY_THEM:
    case ResourceStatus.DELETED_BY_US:
    case ResourceStatus.BOTH_ADDED:
    case ResourceStatus.BOTH_MODIFIED:
      return "!";
    default:
      return "?";
  }
}

export function resourceStatusText(status: ResourceStatus): string {
  switch (status) {
    case ResourceStatus.INDEX_MODIFIED:
      return "Index Modified";
    case ResourceStatus.MODIFIED:
      return "Modified";
    case ResourceStatus.INDEX_ADDED:
      return "Index Added";
    case ResourceStatus.INDEX_DELETED:
      return "Index Deleted";
    case ResourceStatus.DELETED:
      return "Deleted";
    case ResourceStatus.INDEX_RENAMED:
      return "Index Renamed";
    case ResourceStatus.INDEX_COPIED:
      return "Index Copied";
    case ResourceStatus.UNTRACKED:
      return "Untracked";
    case ResourceStatus.IGNORED:
      return "Ignored";
    case ResourceStatus.INTENT_TO_ADD:
      return "Intent to Add";
    case ResourceStatus.INTENT_TO_RENAME:
      return "Intent to Rename";
    case ResourceStatus.TYPE_CHANGED:
      return "Type Changed";
    case ResourceStatus.BOTH_DELETED:
      return "Conflict: Both Deleted";
    case ResourceStatus.ADDED_BY_US:
      return "Conflict: Added By Us";
    case ResourceStatus.DELETED_BY_THEM:
      return "Conflict: Deleted By Them";
    case ResourceStatus.ADDED_BY_THEM:
      return "Conflict: Added By Them";
    case ResourceStatus.DELETED_BY_US:
      return "Conflict: Deleted By Us";
    case ResourceStatus.BOTH_ADDED:
      return "Conflict: Both Added";
    case ResourceStatus.BOTH_MODIFIED:
      return "Conflict: Both Modified";
    default:
      return "Changed";
  }
}

export function resourceStatusThemeColorId(status: ResourceStatus): string {
  switch (status) {
    case ResourceStatus.INDEX_MODIFIED:
      return "gitDecoration.stageModifiedResourceForeground";
    case ResourceStatus.MODIFIED:
    case ResourceStatus.TYPE_CHANGED:
      return "gitDecoration.modifiedResourceForeground";
    case ResourceStatus.INDEX_DELETED:
      return "gitDecoration.stageDeletedResourceForeground";
    case ResourceStatus.DELETED:
      return "gitDecoration.deletedResourceForeground";
    case ResourceStatus.INDEX_ADDED:
    case ResourceStatus.INTENT_TO_ADD:
      return "gitDecoration.addedResourceForeground";
    case ResourceStatus.INDEX_COPIED:
    case ResourceStatus.INDEX_RENAMED:
    case ResourceStatus.INTENT_TO_RENAME:
      return "gitDecoration.renamedResourceForeground";
    case ResourceStatus.UNTRACKED:
      return "gitDecoration.untrackedResourceForeground";
    case ResourceStatus.IGNORED:
      return "gitDecoration.ignoredResourceForeground";
    case ResourceStatus.BOTH_DELETED:
    case ResourceStatus.ADDED_BY_US:
    case ResourceStatus.DELETED_BY_THEM:
    case ResourceStatus.ADDED_BY_THEM:
    case ResourceStatus.DELETED_BY_US:
    case ResourceStatus.BOTH_ADDED:
    case ResourceStatus.BOTH_MODIFIED:
      return "gitDecoration.conflictingResourceForeground";
    default:
      return "gitDecoration.modifiedResourceForeground";
  }
}

export function headDescription(head: RepositoryHead | undefined): string {
  if (!head) {
    return "";
  }
  const name = head.detached ? shortCommit(head.commit) : (head.name ?? shortCommit(head.commit));
  if (!name) {
    return "";
  }
  if (head.upstream) {
    const sync = formatAheadBehind(head);
    const tracking = `${name} ↔ ${head.upstream.remote}/${head.upstream.name}`;
    return sync ? `${tracking} ${sync}` : tracking;
  }
  return name;
}

export function formatAheadBehind(head: RepositoryHead): string {
  const ahead = head.ahead ?? 0;
  const behind = head.behind ?? 0;
  const parts: string[] = [];
  if (behind > 0) {
    parts.push(`${behind}↓`);
  }
  if (ahead > 0) {
    parts.push(`${ahead}↑`);
  }
  return parts.join(" ");
}

function mapChanges(repoRoot: string, changes: readonly ChangeLike[] | undefined): ResourceChange[] {
  return (changes ?? []).map((change) => snapshotChange(repoRoot, change));
}

function asResourceStatus(status: number): ResourceStatus {
  if (knownResourceStatuses().has(status)) {
    return status as ResourceStatus;
  }
  return ResourceStatus.MODIFIED;
}

let knownStatuses: Set<number> | undefined;
function knownResourceStatuses(): Set<number> {
  knownStatuses ??= new Set(Object.values(ResourceStatus));
  return knownStatuses;
}

function toPosixRelative(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..")) {
    return filePath.replace(/\\/g, "/");
  }
  return relative;
}

function shortCommit(commit: string | undefined): string {
  return commit && commit.length >= 8 ? commit.slice(0, 8) : (commit ?? "");
}

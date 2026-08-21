import { computeAdoptedPointers } from "../git/adoptedPointers.js";
import type { AdoptedChangeKind, AdoptedDiffSpec, SubmoduleViewModel } from "../git/interfaces.js";
import {
  indexSnapshots,
  lookupSnapshot,
  ResourceStatus,
  resourceStatusLetter,
  resourceStatusText,
  resourceStatusThemeColorId,
  type ChangeGroupKind,
  type ChangeGroupViewModel,
  type RepositoryChangeGroups,
  type RepositoryStateSnapshot,
  type ResourceChange,
} from "../git/repositoryState.js";
import type {
  NameStatusEntry,
  NameStatusKind,
  RepoWorkingState,
  SubmoduleNode,
  WorkspaceRootNode,
} from "../git/types.js";
import type { RestoreResult } from "../restore/branchRestoreService.js";
import type { RestoreCommandContext } from "../restore/settings.js";
import {
  DEFAULT_CHANGES_TREE_SETTINGS,
  emptyChangeGroups,
  repositoryBranchDescription,
  visibleTreeGroups,
  type ChangesTreeSettings,
} from "./changesTreeSettings.js";
import { COMMANDS, CONTEXT } from "./constants.js";

export type AdoptedTreeKind =
  | "workspace-root"
  | "submodule"
  | "change-group"
  | "change"
  | "folder"
  | "adopted-group"
  | "pointer"
  | "staged"
  | "unstaged"
  | "file"
  | "message";

export interface AdoptedFileDiff {
  repoRoot: string;
  kind: AdoptedChangeKind;
  fromSha: string;
  toSha: string;
  status: NameStatusKind;
  path: string;
  oldPath?: string;
  similarity?: number;
}

export interface ChangeFileRef {
  rootPath: string;
  group: ChangeGroupKind;
  resource: ResourceChange;
}

export interface FileDecorationSpec {
  badge: string;
  tooltip: string;
  themeColorId: string;
}

export interface AdoptedTreeNode {
  id: string;
  kind: AdoptedTreeKind;
  /** Owning vscode.git repository. Prevents parent "all" actions from crossing into child repositories. */
  repositoryRoot?: string;
  /** Owning built-in-like change group for group/folder/item command routing. */
  changeGroup?: ChangeGroupKind;
  label: string;
  description?: string;
  tooltip: string;
  collapsible: boolean;
  expandByDefault: boolean;
  contextValue: string;
  iconId: string;
  themeColorId?: string;
  decoration?: FileDecorationSpec;
  diffSpec?: AdoptedDiffSpec;
  diffSpecs?: AdoptedDiffSpec[];
  fileDiff?: AdoptedFileDiff;
  change?: ChangeFileRef;
  resourceUri?: string;
  clickCommand?: { command: string; title: string };
  restoreTarget?: RestoreCommandContext;
  restoreResult?: RestoreResult;
  children: AdoptedTreeNode[];
}

const STATUS_DECORATION: Record<NameStatusKind, FileDecorationSpec> = {
  added: { badge: "A", tooltip: "Added", themeColorId: "gitDecoration.addedResourceForeground" },
  modified: { badge: "M", tooltip: "Modified", themeColorId: "gitDecoration.modifiedResourceForeground" },
  deleted: { badge: "D", tooltip: "Deleted", themeColorId: "gitDecoration.deletedResourceForeground" },
  renamed: { badge: "R", tooltip: "Renamed", themeColorId: "gitDecoration.renamedResourceForeground" },
  copied: { badge: "C", tooltip: "Copied", themeColorId: "gitDecoration.renamedResourceForeground" },
  typechange: { badge: "T", tooltip: "Type change", themeColorId: "gitDecoration.modifiedResourceForeground" },
  unmerged: { badge: "U", tooltip: "Unmerged", themeColorId: "gitDecoration.conflictingResourceForeground" },
  unknown: { badge: "?", tooltip: "Changed", themeColorId: "gitDecoration.modifiedResourceForeground" },
};

const SUBMODULE_DECORATION: FileDecorationSpec = {
  badge: "S",
  tooltip: "Submodule",
  themeColorId: "gitDecoration.submoduleResourceForeground",
};

const FILE_ICON: Record<NameStatusKind, { iconId: string; themeColorId: string }> = {
  added: { iconId: "diff-added", themeColorId: "gitDecoration.addedResourceForeground" },
  modified: { iconId: "diff-modified", themeColorId: "gitDecoration.modifiedResourceForeground" },
  deleted: { iconId: "diff-removed", themeColorId: "gitDecoration.deletedResourceForeground" },
  renamed: { iconId: "diff-renamed", themeColorId: "gitDecoration.renamedResourceForeground" },
  copied: { iconId: "diff-added", themeColorId: "gitDecoration.renamedResourceForeground" },
  typechange: { iconId: "diff-modified", themeColorId: "gitDecoration.modifiedResourceForeground" },
  unmerged: { iconId: "warning", themeColorId: "gitDecoration.conflictingResourceForeground" },
  unknown: { iconId: "file", themeColorId: "gitDecoration.modifiedResourceForeground" },
};

const CHANGE_GROUP_CONTEXT: Record<ChangeGroupKind, string> = {
  merge: CONTEXT.changeGroupMerge,
  index: CONTEXT.changeGroupIndex,
  workingTree: CONTEXT.changeGroupWorkingTree,
  untracked: CONTEXT.changeGroupUntracked,
};

const CHANGE_FILE_CONTEXT: Record<ChangeGroupKind, string> = {
  merge: CONTEXT.changeMerge,
  index: CONTEXT.changeIndex,
  workingTree: CONTEXT.changeWorkingTree,
  untracked: CONTEXT.changeUntracked,
};

const RESOURCE_FOLDER_CONTEXT: Record<ChangeGroupKind, string> = {
  merge: CONTEXT.resourceFolderMerge,
  index: CONTEXT.resourceFolderIndex,
  workingTree: CONTEXT.resourceFolderWorkingTree,
  untracked: CONTEXT.resourceFolderUntracked,
};

export function shortSha(sha: string | null | undefined): string {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "unknown";
}

export function fileDecoration(status: NameStatusKind): FileDecorationSpec {
  return STATUS_DECORATION[status];
}

export function changeDecoration(status: ResourceStatus): FileDecorationSpec {
  return {
    badge: resourceStatusLetter(status),
    tooltip: resourceStatusText(status),
    themeColorId: resourceStatusThemeColorId(status),
  };
}

export function submoduleStatusSummary(state: RepoWorkingState, branchName: string | null, headSha: string | null): string {
  if (state.uninitialized) {
    return "uninitialized";
  }
  if (state.probeFailed) {
    return "status unavailable";
  }

  const parts: string[] = [];
  if (state.detached) {
    parts.push(`detached ${shortSha(headSha)}`);
  } else if (branchName) {
    parts.push(branchName);
  }
  if (state.operationInProgress) {
    parts.push("git busy");
  }
  if (state.dirty) {
    parts.push("dirty");
  }
  if (state.diverged) {
    parts.push("diverged");
  }
  if (state.pointerMismatch) {
    parts.push("pointer");
  }
  return parts.join(" · ");
}

export function submoduleIcon(state: RepoWorkingState): { iconId: string; themeColorId?: string } {
  if (state.uninitialized) {
    return { iconId: "circle-slash", themeColorId: "disabledForeground" };
  }
  if (state.probeFailed) {
    return { iconId: "warning", themeColorId: "list.warningForeground" };
  }
  if (state.operationInProgress) {
    return { iconId: "sync~spin" };
  }
  if (state.dirty) {
    return { iconId: "warning", themeColorId: "list.warningForeground" };
  }
  if (state.diverged) {
    return { iconId: "git-compare", themeColorId: "list.warningForeground" };
  }
  if (state.pointerMismatch) {
    return { iconId: "diff", themeColorId: "gitDecoration.modifiedResourceForeground" };
  }
  if (state.detached) {
    return { iconId: "git-commit" };
  }
  return { iconId: "file-submodule" };
}

export function buildAdoptedTree(
  model: SubmoduleViewModel,
  snapshots: readonly RepositoryStateSnapshot[] = [],
  settings: ChangesTreeSettings = DEFAULT_CHANGES_TREE_SETTINGS,
): AdoptedTreeNode[] {
  const byRoot = indexSnapshots(snapshots);
  return model.roots.map((root) => buildWorkspaceRootNode(root, byRoot, settings));
}

export const buildChangesTree = buildAdoptedTree;

export function fileNodesFromNameStatus(
  spec: AdoptedDiffSpec,
  entries: readonly NameStatusEntry[],
  settings: ChangesTreeSettings = DEFAULT_CHANGES_TREE_SETTINGS,
): AdoptedTreeNode[] {
  if (entries.length === 0) {
    return [];
  }

  const files = entries.map((entry) => toFileNode(spec, entry));
  return settings.viewMode === "tree"
    ? nestNodesByPath(files, settings.compactFolders, (relativePath, children) =>
        buildPathFolderNode(spec.repoRoot, relativePath, children),
      )
    : files;
}

export function errorMessageNode(id: string, error: unknown, label = "Failed to list changes"): AdoptedTreeNode {
  const detail = error instanceof Error ? error.message : String(error);
  return messageNode(id, label, detail, "warning");
}

export function tryFileDecoration(status: string | null): FileDecorationSpec | undefined {
  if (!status || !Object.prototype.hasOwnProperty.call(STATUS_DECORATION, status)) {
    return undefined;
  }
  return STATUS_DECORATION[status as NameStatusKind];
}

function buildWorkspaceRootNode(
  root: WorkspaceRootNode,
  snapshots: ReadonlyMap<string, RepositoryStateSnapshot>,
  settings: ChangesTreeSettings,
): AdoptedTreeNode {
  const snapshot = lookupSnapshot(root.rootPath, snapshots);
  const groups = snapshot?.groups ?? emptyChangeGroups();
  const children = repoChildNodes(root, groups, snapshots, settings);
  const branch = repositoryBranchDescription(snapshot?.head, groups);
  const submoduleCount = root.children.length;
  const fallback = submoduleCount === 0 ? undefined : submoduleCount === 1 ? "1 submodule" : `${submoduleCount} submodules`;
  return {
    id: `root:${root.rootPath}`,
    kind: "workspace-root",
    repositoryRoot: root.rootPath,
    label: root.displayName,
    description: branch || fallback,
    tooltip: root.rootPath,
    collapsible: children.length > 0,
    expandByDefault: children.length > 0,
    contextValue: repositoryContextValue(CONTEXT.workspaceRoot, snapshot),
    iconId: "repo",
    clickCommand: { command: COMMANDS.checkoutBranch, title: "Checkout Branch…" },
    children,
  };
}

function buildSubmoduleTreeNode(
  node: SubmoduleNode,
  snapshots: ReadonlyMap<string, RepositoryStateSnapshot>,
  settings: ChangesTreeSettings,
): AdoptedTreeNode {
  const snapshot = lookupSnapshot(node.rootPath, snapshots);
  const groups = snapshot?.groups ?? emptyChangeGroups();
  const branch = snapshot?.head ? repositoryBranchDescription(snapshot.head, groups) : undefined;
  const icon = repoRowIcon(node.workingState);
  const children = repoChildNodes(node, groups, snapshots, settings);
  return {
    id: `sub:${node.rootPath}`,
    kind: "submodule",
    repositoryRoot: node.rootPath,
    label: node.displayName,
    description: branch || submoduleStatusSummary(node.workingState, node.branch.name, node.pins.checkoutHeadSha),
    tooltip: submoduleTooltip(node),
    collapsible: children.length > 0,
    expandByDefault: false,
    contextValue: repositoryContextValue(CONTEXT.submodule, snapshot),
    iconId: icon.iconId,
    themeColorId: icon.themeColorId,
    clickCommand: { command: COMMANDS.checkoutBranch, title: "Checkout Branch…" },
    restoreTarget: {
      parentRootPath: node.parentRootPath,
      relativePath: node.relativePath,
      childRootPath: node.rootPath,
      branch: node.branch.committedConfiguredBranch,
      pin: node.pins.headGitlinkSha,
    },
    children,
  };
}

function repositoryContextValue(
  base: string,
  snapshot: RepositoryStateSnapshot | undefined,
): string {
  return `${base}.${snapshot?.head?.upstream ? CONTEXT.hasUpstream : CONTEXT.noUpstream}`;
}

function repoRowIcon(state: RepoWorkingState): { iconId: string; themeColorId?: string } {
  if (state.uninitialized) {
    return { iconId: "circle-slash", themeColorId: "disabledForeground" };
  }
  if (state.probeFailed) {
    return { iconId: "warning", themeColorId: "list.warningForeground" };
  }
  if (state.operationInProgress) {
    return { iconId: "sync~spin" };
  }
  return { iconId: "file-submodule" };
}

function repoChildNodes(
  node: WorkspaceRootNode | SubmoduleNode,
  groups: RepositoryChangeGroups,
  snapshots: ReadonlyMap<string, RepositoryStateSnapshot>,
  settings: ChangesTreeSettings,
): AdoptedTreeNode[] {
  const changeGroups = visibleTreeGroups(withAdoptedGitlinks(groups, node.rootPath, node.children), settings).map(
    (group) => buildChangeGroupNode(node.rootPath, group, node.children, settings),
  );
  const childRepos = node.children.map((child) => buildSubmoduleTreeNode(child, snapshots, settings));
  return [...changeGroups, ...childRepos];
}

function buildChangeGroupNode(
  rootPath: string,
  group: ChangeGroupViewModel,
  children: readonly SubmoduleNode[],
  settings: ChangesTreeSettings,
): AdoptedTreeNode {
  const gitlinks = gitlinkByPath(children);
  const files = [...group.resources]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((resource) => toChangeNode(rootPath, group.kind, resource, gitlinks.get(resource.relativePath), settings));
  const nested =
    settings.viewMode === "tree"
      ? nestNodesByPath(files, settings.compactFolders, (relativePath, children) =>
          buildFolderNode(rootPath, group.kind, relativePath, children),
        )
      : files;
  return {
    id: `change-group:${rootPath}:${group.kind}`,
    kind: "change-group",
    repositoryRoot: rootPath,
    changeGroup: group.kind,
    label: group.label,
    description: String(group.resources.length),
    tooltip: group.label,
    collapsible: true,
    expandByDefault: true,
    contextValue: CHANGE_GROUP_CONTEXT[group.kind],
    iconId: "",
    children: nested,
  };
}

function toChangeNode(
  rootPath: string,
  group: ChangeGroupKind,
  resource: ResourceChange,
  gitlink: SubmoduleNode | undefined,
  settings: ChangesTreeSettings,
): AdoptedTreeNode {
  const pointer = gitlinkPointer(group, gitlink);
  const decoration = gitlink ? SUBMODULE_DECORATION : changeDecoration(resource.status);
  const icon = gitlink
    ? { iconId: "file-submodule", themeColorId: SUBMODULE_DECORATION.themeColorId }
    : changeStatusIcon(resource.status);
  const useIcons = !settings.decorationsEnabled;
  const spec = pointer && gitlink
    ? {
        repoRoot: gitlink.rootPath,
        fromSha: pointer.fromSha,
        toSha: pointer.toSha,
        kind: pointer.kind,
      }
    : undefined;
  const adopted = gitlink ? [buildGitlinkAdoptedGroup(rootPath, group, gitlink, spec)] : [];
  return {
    id: `change:${rootPath}:${group}:${resource.relativePath}`,
    kind: "change",
    repositoryRoot: rootPath,
    changeGroup: group,
    label: resource.relativePath,
    description: spec && gitlink ? gitlinkPointerDescription(gitlink, spec) : undefined,
    tooltip: gitlinkTooltip(resource.relativePath, decoration.tooltip, gitlink, spec),
    collapsible: adopted.length > 0,
    expandByDefault: adopted.length > 0,
    contextValue: gitlink ? `${CHANGE_FILE_CONTEXT[group]}.${CONTEXT.gitlink}` : CHANGE_FILE_CONTEXT[group],
    iconId: useIcons ? icon.iconId : "file",
    themeColorId: useIcons ? icon.themeColorId : decoration.themeColorId,
    decoration,
    resourceUri: resource.uri,
    change: { rootPath, group, resource },
    clickCommand: settings.openDiffOnClick
      ? { command: COMMANDS.openChange, title: "Open Changes" }
      : { command: COMMANDS.openFile, title: "Open File" },
    children: adopted,
  };
}

function buildGitlinkAdoptedGroup(
  parentRootPath: string,
  group: ChangeGroupKind,
  gitlink: SubmoduleNode,
  spec: AdoptedDiffSpec | undefined,
): AdoptedTreeNode {
  const tooltip = !spec
    ? "No gitlink pointer change"
    : spec.kind === "staged"
      ? "HEAD gitlink → index gitlink"
      : "index gitlink → checkout HEAD";
  return {
    id: `adopted:${parentRootPath}:${group}:${gitlink.rootPath}`,
    kind: "adopted-group",
    repositoryRoot: gitlink.rootPath,
    label: "Adopted Changes",
    description: "0",
    tooltip,
    collapsible: true,
    expandByDefault: true,
    contextValue: CONTEXT.adoptedGroup,
    iconId: "",
    diffSpec: spec,
    children: [],
  };
}

function changeStatusIcon(status: ResourceStatus): { iconId: string; themeColorId: string } {
  const themeColorId = resourceStatusThemeColorId(status);
  const letter = resourceStatusLetter(status);
  switch (letter) {
    case "A":
      return { iconId: "diff-added", themeColorId };
    case "D":
      return { iconId: "diff-removed", themeColorId };
    case "R":
    case "C":
      return { iconId: "diff-renamed", themeColorId };
    case "U":
      return { iconId: "question", themeColorId };
    case "!":
      return { iconId: "warning", themeColorId };
    default:
      return { iconId: "diff-modified", themeColorId };
  }
}

interface FolderTrie {
  name: string;
  files: AdoptedTreeNode[];
  folders: Map<string, FolderTrie>;
}

function nestPath(node: AdoptedTreeNode): string {
  return node.fileDiff?.path ?? node.change?.resource.relativePath ?? node.label;
}

function nestNodesByPath(
  files: readonly AdoptedTreeNode[],
  compactFolders: boolean,
  makeFolder: (relativePath: string, children: AdoptedTreeNode[]) => AdoptedTreeNode,
): AdoptedTreeNode[] {
  const root: FolderTrie = { name: "", files: [], folders: new Map() };
  for (const file of files) {
    const parts = nestPath(file).split("/").filter(Boolean);
    if (parts.length === 0) {
      root.files.push(file);
      continue;
    }
    insertFile(root, parts, file);
  }
  return trieToNodes(root, compactFolders, makeFolder);
}

function insertFile(trie: FolderTrie, parts: string[], file: AdoptedTreeNode): void {
  if (parts.length === 1) {
    const leafLabel = file.label.includes(" → ") ? file.label : parts[0]!;
    trie.files.push({ ...file, label: leafLabel });
    return;
  }
  const [head, ...rest] = parts;
  let child = trie.folders.get(head!);
  if (!child) {
    child = { name: head!, files: [], folders: new Map() };
    trie.folders.set(head!, child);
  }
  insertFile(child, rest, file);
}

function compactTrie(trie: FolderTrie): FolderTrie {
  const names = [trie.name];
  let current = trie;
  while (current.files.length === 0 && current.folders.size === 1) {
    const only = [...current.folders.values()][0]!;
    names.push(only.name);
    current = only;
  }
  return { name: names.filter(Boolean).join("/"), files: current.files, folders: current.folders };
}

function trieToNodes(
  trie: FolderTrie,
  compactFolders: boolean,
  makeFolder: (relativePath: string, children: AdoptedTreeNode[]) => AdoptedTreeNode,
): AdoptedTreeNode[] {
  const folderNodes = [...trie.folders.values()].map((child) => {
    const folded = compactFolders ? compactTrie(child) : child;
    const children = trieToNodes(folded, compactFolders, makeFolder);
    return makeFolder(folded.name, children);
  });
  return [...folderNodes, ...trie.files].sort((left, right) => left.label.localeCompare(right.label));
}

function buildPathFolderNode(rootPath: string, relativePath: string, children: AdoptedTreeNode[]): AdoptedTreeNode {
  return {
    id: `folder:${rootPath}:adopted:${relativePath}`,
    kind: "folder",
    label: relativePath,
    tooltip: relativePath,
    collapsible: true,
    expandByDefault: true,
    contextValue: CONTEXT.folder,
    iconId: "folder",
    resourceUri: `${rootPath}/${relativePath}`,
    children,
  };
}

function buildFolderNode(
  rootPath: string,
  group: ChangeGroupKind,
  relativePath: string,
  children: AdoptedTreeNode[],
): AdoptedTreeNode {
  return {
    id: `folder:${rootPath}:${group}:${relativePath}`,
    kind: "folder",
    repositoryRoot: rootPath,
    changeGroup: group,
    label: relativePath,
    tooltip: relativePath,
    collapsible: true,
    expandByDefault: true,
    contextValue: RESOURCE_FOLDER_CONTEXT[group],
    iconId: "folder",
    resourceUri: `${rootPath}/${relativePath}`,
    children,
  };
}

function gitlinkByPath(children: readonly SubmoduleNode[]): Map<string, SubmoduleNode> {
  return new Map(children.map((child) => [child.relativePath, child]));
}

function withAdoptedGitlinks(
  groups: RepositoryChangeGroups,
  parentRootPath: string,
  children: readonly SubmoduleNode[],
): RepositoryChangeGroups {
  const index = [...groups.index];
  const workingTree = [...groups.workingTree];
  for (const child of children) {
    const adopted = child.adoptedChanges ?? computeAdoptedPointers(child.pins);
    if (adopted.staged && !hasRelativePath(index, child.relativePath)) {
      index.push(syntheticGitlink(parentRootPath, child.relativePath, ResourceStatus.INDEX_MODIFIED));
    }
    if (adopted.unstaged && !hasRelativePath(workingTree, child.relativePath)) {
      workingTree.push(syntheticGitlink(parentRootPath, child.relativePath, ResourceStatus.MODIFIED));
    }
  }
  return { ...groups, index, workingTree };
}

function hasRelativePath(resources: readonly ResourceChange[], relativePath: string): boolean {
  return resources.some((resource) => resource.relativePath === relativePath);
}

function syntheticGitlink(rootPath: string, relativePath: string, status: ResourceStatus): ResourceChange {
  const uri = `${rootPath}/${relativePath}`;
  return { uri, originalUri: uri, status, relativePath };
}

function gitlinkPointer(
  group: ChangeGroupKind,
  gitlink: SubmoduleNode | undefined,
): { kind: AdoptedChangeKind; fromSha: string; toSha: string } | undefined {
  if (!gitlink) {
    return undefined;
  }
  const adopted = gitlink.adoptedChanges ?? computeAdoptedPointers(gitlink.pins);
  if (group === "index" && adopted.staged) {
    return { kind: "staged", ...adopted.staged };
  }
  if (group === "workingTree" && adopted.unstaged) {
    return { kind: "unstaged", ...adopted.unstaged };
  }
  return undefined;
}

function gitlinkPointerDescription(gitlink: SubmoduleNode, spec: AdoptedDiffSpec): string {
  return `${gitlinkSideLabel(spec.fromSha, gitlink)} → ${gitlinkSideLabel(spec.toSha, gitlink)}`;
}

function gitlinkSideLabel(sha: string, gitlink: SubmoduleNode): string {
  if (sha === gitlink.pins.checkoutHeadSha && gitlink.branch.name && !gitlink.workingState.detached) {
    return gitlink.branch.name;
  }
  return shortSha(sha);
}

function gitlinkTooltip(
  relativePath: string,
  statusTooltip: string,
  gitlink: SubmoduleNode | undefined,
  spec: AdoptedDiffSpec | undefined,
): string {
  const lines = [statusTooltip, relativePath];
  if (gitlink) {
    lines.push(
      `HEAD gitlink: ${shortSha(gitlink.pins.headGitlinkSha)}`,
      `index gitlink: ${shortSha(gitlink.pins.indexGitlinkSha)}`,
      `checkout HEAD: ${shortSha(gitlink.pins.checkoutHeadSha)}`,
    );
  }
  if (spec) {
    lines.push(`${spec.kind}: ${shortSha(spec.fromSha)} → ${shortSha(spec.toSha)}`);
  }
  return lines.join("\n");
}

function toFileNode(spec: AdoptedDiffSpec, entry: NameStatusEntry): AdoptedTreeNode {
  const decoration = fileDecoration(entry.status);
  const icon = FILE_ICON[entry.status];
  const label = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
  const fileDiff: AdoptedFileDiff = {
    repoRoot: spec.repoRoot,
    kind: spec.kind,
    fromSha: spec.fromSha,
    toSha: spec.toSha,
    status: entry.status,
    path: entry.path,
    oldPath: entry.oldPath,
    similarity: entry.similarity,
  };

  return {
    id: `file:${spec.repoRoot}:${spec.kind}:${entry.path}`,
    kind: "file",
    label,
    tooltip: fileTooltip(entry, spec),
    collapsible: false,
    expandByDefault: false,
    contextValue: CONTEXT.file,
    iconId: icon.iconId,
    themeColorId: icon.themeColorId,
    decoration,
    fileDiff,
    children: [],
  };
}

function messageNode(id: string, label: string, tooltip: string, iconId = "info"): AdoptedTreeNode {
  return {
    id,
    kind: "message",
    label,
    tooltip,
    collapsible: false,
    expandByDefault: false,
    contextValue: CONTEXT.message,
    iconId,
    children: [],
  };
}

function submoduleTooltip(node: SubmoduleNode): string {
  const lines = [
    node.rootPath,
    `path: ${node.relativePath}`,
    `branch: ${node.workingState.detached ? "detached" : node.branch.name ?? "unknown"}`,
    `HEAD: ${node.pins.checkoutHeadSha ?? "unknown"}`,
    `parent HEAD gitlink: ${node.pins.headGitlinkSha ?? "unknown"}`,
    `parent index gitlink: ${node.pins.indexGitlinkSha ?? "unknown"}`,
  ];
  if (node.branch.configuredBranch) {
    lines.push(`configured branch: ${node.branch.configuredBranch}`);
  }
  const summary = submoduleStatusSummary(node.workingState, node.branch.name, node.pins.checkoutHeadSha);
  if (summary) {
    lines.push(`status: ${summary}`);
  }
  return lines.join("\n");
}

function fileTooltip(entry: NameStatusEntry, spec: AdoptedDiffSpec): string {
  const rename = entry.oldPath ? `\n${entry.oldPath} → ${entry.path}` : `\n${entry.path}`;
  const similarity = entry.similarity !== undefined ? `\nsimilarity ${entry.similarity}%` : "";
  return `${fileDecoration(entry.status).tooltip} (${spec.kind})${rename}\n${shortSha(spec.fromSha)} → ${shortSha(spec.toSha)}${similarity}`;
}

export function usesThemeFileIcon(node: AdoptedTreeNode): boolean {
  if (node.kind === "file" || node.kind === "folder") {
    return true;
  }
  return node.kind === "change" && node.iconId === "file";
}

export function applyRestoreOverlay(
  nodes: AdoptedTreeNode[],
  lookup: (childRootPath: string) => RestoreResult | undefined,
): AdoptedTreeNode[] {
  return nodes.map((node) => overlayRestore(node, lookup));
}

function overlayRestore(
  node: AdoptedTreeNode,
  lookup: (childRootPath: string) => RestoreResult | undefined,
): AdoptedTreeNode {
  const children = node.children.map((child) => overlayRestore(child, lookup));
  if (node.kind !== "submodule" || !node.restoreTarget) {
    return children === node.children ? node : { ...node, children };
  }

  const result = lookup(node.restoreTarget.childRootPath);
  if (!result || result.action !== "blocked") {
    return { ...node, children, restoreResult: result };
  }

  return {
    ...node,
    children,
    restoreResult: result,
    description: [node.description, "restore blocked"].filter(Boolean).join(" · "),
    tooltip: `${node.tooltip}\nrestore: ${result.detail}`,
    contextValue: `${CONTEXT.submodule}.restoreBlocked`,
    iconId: node.iconId === "sync~spin" ? node.iconId : "warning",
    themeColorId: "list.warningForeground",
  };
}

export function treeCollapsibleMode(node: AdoptedTreeNode): "none" | "collapsed" | "expanded" {
  if (!node.collapsible) {
    return "none";
  }
  return node.expandByDefault ? "expanded" : "collapsed";
}

export function treeItemCommand(
  node: AdoptedTreeNode,
): { command: string; title: string; arguments: [AdoptedTreeNode] } | undefined {
  if (node.clickCommand) {
    return { ...node.clickCommand, arguments: [node] };
  }
  if (node.fileDiff || node.change) {
    return {
      command: COMMANDS.openChange,
      title: "Open Changes",
      arguments: [node],
    };
  }
  return undefined;
}

export function collectDiffSpecs(node: AdoptedTreeNode): AdoptedDiffSpec[] {
  if (node.diffSpec) {
    return [node.diffSpec];
  }
  if (node.diffSpecs && node.diffSpecs.length > 0) {
    return node.diffSpecs;
  }
  if (
    node.kind === "workspace-root" ||
    node.kind === "submodule" ||
    node.kind === "change-group" ||
    node.kind === "folder" ||
    node.kind === "change" ||
    node.kind === "adopted-group" ||
    node.kind === "pointer"
  ) {
    return node.children.flatMap(collectDiffSpecs);
  }
  return [];
}

export function collectChangeRefs(node: AdoptedTreeNode): ChangeFileRef[] {
  if (node.change) {
    return [node.change];
  }
  if (
    node.kind === "workspace-root" ||
    node.kind === "submodule" ||
    node.kind === "change-group" ||
    node.kind === "folder"
  ) {
    return node.children.flatMap(collectChangeRefs);
  }
  return [];
}

export function collectFileDiffs(nodes: readonly AdoptedTreeNode[]): AdoptedFileDiff[] {
  return nodes.flatMap((node) => (node.fileDiff ? [node.fileDiff] : collectFileDiffs(node.children)));
}

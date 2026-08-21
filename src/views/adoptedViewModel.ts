import { computeAdoptedPointers } from "../git/adoptedPointers.js";
import type { AdoptedChangeKind, AdoptedDiffSpec, SubmoduleViewModel } from "../git/interfaces.js";
import type {
  NameStatusEntry,
  NameStatusKind,
  RepoWorkingState,
  SubmoduleNode,
  WorkspaceRootNode,
} from "../git/types.js";
import type { RestoreResult } from "../restore/branchRestoreService.js";
import type { RestoreCommandContext } from "../restore/settings.js";
import { COMMANDS, CONTEXT } from "./constants.js";

export type AdoptedTreeKind =
  | "workspace-root"
  | "submodule"
  | "adopted-group"
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

export interface FileDecorationSpec {
  badge: string;
  tooltip: string;
  themeColorId: string;
}

export interface AdoptedTreeNode {
  id: string;
  kind: AdoptedTreeKind;
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

export function shortSha(sha: string | null | undefined): string {
  return sha && sha.length >= 7 ? sha.slice(0, 7) : "unknown";
}

export function fileDecoration(status: NameStatusKind): FileDecorationSpec {
  return STATUS_DECORATION[status];
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

export function buildAdoptedTree(model: SubmoduleViewModel): AdoptedTreeNode[] {
  return model.roots.map(buildWorkspaceRootNode);
}

export function fileNodesFromNameStatus(spec: AdoptedDiffSpec, entries: readonly NameStatusEntry[]): AdoptedTreeNode[] {
  if (entries.length === 0) {
    return [
      messageNode(
        `${spec.kind}:${spec.repoRoot}:empty`,
        "No file changes",
        `${spec.kind} pointer ${shortSha(spec.fromSha)} → ${shortSha(spec.toSha)} has no name-status entries.`,
      ),
    ];
  }

  return entries.map((entry) => toFileNode(spec, entry));
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

function buildWorkspaceRootNode(root: WorkspaceRootNode): AdoptedTreeNode {
  const children = root.children.map(buildSubmoduleTreeNode);
  return {
    id: `root:${root.rootPath}`,
    kind: "workspace-root",
    label: root.displayName,
    description: children.length === 1 ? "1 submodule" : `${children.length} submodules`,
    tooltip: root.rootPath,
    collapsible: children.length > 0,
    expandByDefault: children.length > 0,
    contextValue: CONTEXT.workspaceRoot,
    iconId: "repo",
    children,
  };
}

function buildSubmoduleTreeNode(node: SubmoduleNode): AdoptedTreeNode {
  const icon = submoduleIcon(node.workingState);
  const description = submoduleStatusSummary(node.workingState, node.branch.name, node.pins.checkoutHeadSha);
  return {
    id: `sub:${node.rootPath}`,
    kind: "submodule",
    label: node.displayName,
    description,
    tooltip: submoduleTooltip(node),
    collapsible: true,
    expandByDefault: false,
    contextValue: CONTEXT.submodule,
    iconId: icon.iconId,
    themeColorId: icon.themeColorId,
    restoreTarget: {
      parentRootPath: node.parentRootPath,
      relativePath: node.relativePath,
      childRootPath: node.rootPath,
      branch: node.branch.committedConfiguredBranch,
      pin: node.pins.headGitlinkSha,
    },
    children: [buildAdoptedGroup(node), ...node.children.map(buildSubmoduleTreeNode)],
  };
}

function buildAdoptedGroup(node: SubmoduleNode): AdoptedTreeNode {
  const adopted = node.adoptedChanges ?? computeAdoptedPointers(node.pins);
  const children: AdoptedTreeNode[] = [];
  const specs: AdoptedDiffSpec[] = [];

  if (adopted.staged) {
    const spec: AdoptedDiffSpec = {
      repoRoot: node.rootPath,
      fromSha: adopted.staged.fromSha,
      toSha: adopted.staged.toSha,
      kind: "staged",
    };
    specs.push(spec);
    children.push(buildPointerGroup(node.rootPath, "staged", spec, "HEAD gitlink → index gitlink"));
  }

  if (adopted.unstaged) {
    const spec: AdoptedDiffSpec = {
      repoRoot: node.rootPath,
      fromSha: adopted.unstaged.fromSha,
      toSha: adopted.unstaged.toSha,
      kind: "unstaged",
    };
    specs.push(spec);
    children.push(buildPointerGroup(node.rootPath, "unstaged", spec, "index gitlink → checkout HEAD"));
  }

  const hasChanges = children.length > 0;
  return {
    id: `adopted:${node.rootPath}`,
    kind: "adopted-group",
    label: "Adopted Changes",
    description: adoptedGroupDescription(Boolean(adopted.staged), Boolean(adopted.unstaged)),
    tooltip: hasChanges
      ? "Pointer shifts relative to the immediate parent gitlink."
      : "No staged or unstaged gitlink pointer shift.",
    collapsible: hasChanges,
    expandByDefault: hasChanges,
    contextValue: CONTEXT.adoptedGroup,
    iconId: "layers",
    diffSpecs: specs,
    children,
  };
}

function buildPointerGroup(
  repoRoot: string,
  kind: AdoptedChangeKind,
  spec: AdoptedDiffSpec,
  tooltip: string,
): AdoptedTreeNode {
  return {
    id: `${kind}:${repoRoot}`,
    kind,
    label: kind === "staged" ? "Staged" : "Unstaged",
    description: `${shortSha(spec.fromSha)} → ${shortSha(spec.toSha)}`,
    tooltip,
    collapsible: true,
    expandByDefault: true,
    contextValue: kind === "staged" ? CONTEXT.staged : CONTEXT.unstaged,
    iconId: kind === "staged" ? "check" : "edit",
    diffSpec: spec,
    children: [],
  };
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
    description: decoration.badge,
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

function adoptedGroupDescription(staged: boolean, unstaged: boolean): string {
  if (staged && unstaged) {
    return "staged · unstaged";
  }
  if (staged) {
    return "staged";
  }
  if (unstaged) {
    return "unstaged";
  }
  return "none";
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
  return node.kind === "file";
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
  if (!node.fileDiff) {
    return undefined;
  }
  return {
    command: COMMANDS.openDiff,
    title: "Open Diff",
    arguments: [node],
  };
}

export function collectDiffSpecs(node: AdoptedTreeNode): AdoptedDiffSpec[] {
  if (node.diffSpec) {
    return [node.diffSpec];
  }
  if (node.diffSpecs && node.diffSpecs.length > 0) {
    return node.diffSpecs;
  }
  if (node.kind === "submodule") {
    const group = node.children.find((child) => child.kind === "adopted-group");
    return group ? collectDiffSpecs(group) : [];
  }
  return [];
}

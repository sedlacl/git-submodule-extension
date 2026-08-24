import * as vscode from "vscode";
import type { AdoptedTreeController } from "./adoptedTreeController.js";
import { parseGitShowUri, prepareFileDiff, type GitShowUriParts } from "./adoptedDiffPrep.js";
import { treeCollapsibleMode, treeItemCodicon, treeItemCommand, treeItemFileKindIcon, tryFileDecoration, type AdoptedTreeNode } from "./adoptedViewModel.js";
import { GIT_SHOW_SCHEME } from "./constants.js";

export function toVscodeUri(parts: GitShowUriParts): vscode.Uri {
  return vscode.Uri.from({
    scheme: parts.scheme,
    path: parts.path,
    query: parts.query,
  });
}

export class SubmoduleTreeProvider implements vscode.TreeDataProvider<AdoptedTreeNode> {
  private readonly didChange = new vscode.EventEmitter<AdoptedTreeNode | undefined>();
  readonly onDidChangeTreeData = this.didChange.event;

  constructor(private readonly controller: AdoptedTreeController) {}

  refresh(): void {
    this.didChange.fire(undefined);
  }

  getTreeItem(element: AdoptedTreeNode): vscode.TreeItem {
    const mode = treeCollapsibleMode(element);
    const collapsible =
      mode === "expanded"
        ? vscode.TreeItemCollapsibleState.Expanded
        : mode === "collapsed"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(element.label, collapsible);
    item.id = element.id;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    item.description = element.description;

    const fileKind = treeItemFileKindIcon(element);
    if (fileKind === "folder") {
      item.iconPath = vscode.ThemeIcon.Folder;
    } else if (fileKind === "file") {
      item.iconPath = vscode.ThemeIcon.File;
    } else {
      const codicon = treeItemCodicon(element);
      if (codicon) {
        item.iconPath = new vscode.ThemeIcon(codicon.id, new vscode.ThemeColor(codicon.colorId));
      }
    }

    if (element.fileDiff) {
      item.resourceUri = toVscodeUri(prepareFileDiff(element.fileDiff).reveal);
    } else if (element.change && element.decoration) {
      item.resourceUri = changeDecorationUri(element);
    } else if ((element.kind === "workspace-root" || element.kind === "submodule") && element.decoration) {
      item.resourceUri = repoDecorationUri(element);
    } else if (element.kind === "folder" && element.resourceUri) {
      item.resourceUri = vscode.Uri.file(element.resourceUri);
    }

    const command = treeItemCommand(element);
    if (command) {
      item.command = command;
    }

    return item;
  }

  getChildren(element?: AdoptedTreeNode): Promise<AdoptedTreeNode[]> {
    return this.controller.getChildren(element);
  }
}

export class AdoptedFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly didChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.didChange.event;

  refresh(): void {
    this.didChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== GIT_SHOW_SCHEME) {
      return undefined;
    }
    const query = new URLSearchParams(uri.query);
    const kind = query.get("kind");
    if (kind === "change" || kind === "repo") {
      const badge = query.get("badge") ?? undefined;
      const colorId = query.get("color");
      return new vscode.FileDecoration(
        badge,
        query.get("tooltip") ?? undefined,
        colorId ? new vscode.ThemeColor(colorId) : undefined,
      );
    }
    const parsed = parseGitShowUri(uri);
    const spec = tryFileDecoration(parsed.status);
    if (!spec) {
      return undefined;
    }
    return new vscode.FileDecoration(spec.badge, spec.tooltip, new vscode.ThemeColor(spec.themeColorId));
  }
}

export function changeDecorationUri(node: AdoptedTreeNode): vscode.Uri {
  const relativePath = node.change?.resource.relativePath ?? node.label;
  const query = new URLSearchParams();
  query.set("kind", "change");
  if (node.decoration) {
    if (node.decoration.badge) {
      query.set("badge", node.decoration.badge);
    }
    query.set("tooltip", node.decoration.tooltip);
    query.set("color", node.decoration.themeColorId);
  }
  if (node.change) {
    query.set("root", node.change.rootPath);
    query.set("file", relativePath);
  }
  return vscode.Uri.from({
    scheme: GIT_SHOW_SCHEME,
    path: `/${relativePath.replace(/^\/+/, "")}`,
    query: query.toString(),
  });
}

export function repoDecorationUri(node: AdoptedTreeNode): vscode.Uri {
  const query = new URLSearchParams();
  query.set("kind", "repo");
  if (node.decoration?.badge) {
    query.set("badge", node.decoration.badge);
  }
  if (node.decoration) {
    query.set("tooltip", node.decoration.tooltip);
    query.set("color", node.decoration.themeColorId);
  }
  if (node.repositoryRoot) {
    query.set("root", node.repositoryRoot);
  }
  const path = node.repositoryRoot?.replace(/^\/+/, "") || node.label;
  return vscode.Uri.from({
    scheme: GIT_SHOW_SCHEME,
    path: `/${path}`,
    query: query.toString(),
  });
}

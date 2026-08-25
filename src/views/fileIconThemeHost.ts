import path from "node:path";
import * as vscode from "vscode";
import type { AdoptedTreeNode } from "./adoptedViewModel.js";
import {
  iconThemeQueryForNode,
  parseIconThemeJson,
  resolveThemeIconPath,
  type IconThemeDocument,
} from "./fileIconTheme.js";

export interface LoadedFileIconTheme {
  extensionUri: vscode.Uri;
  themeDir: vscode.Uri;
  document: IconThemeDocument;
  light: boolean;
}

export async function loadActiveFileIconTheme(): Promise<LoadedFileIconTheme | undefined> {
  const id = vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
  if (!id) {
    return undefined;
  }
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON?.contributes?.iconThemes as Array<{ id: string; path: string }> | undefined;
    const contrib = themes?.find((theme) => theme.id === id);
    if (!contrib?.path) {
      continue;
    }
    const jsonUri = vscode.Uri.joinPath(extension.extensionUri, contrib.path);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(jsonUri);
    } catch {
      return undefined;
    }
    return {
      extensionUri: extension.extensionUri,
      themeDir: vscode.Uri.file(path.dirname(jsonUri.fsPath)),
      document: parseIconThemeJson(Buffer.from(bytes).toString("utf8")),
      light: isLightColorTheme(vscode.window.activeColorTheme.kind),
    };
  }
  return undefined;
}

export function fileIconWebviewSrc(
  loaded: LoadedFileIconTheme,
  webview: vscode.Webview,
  node: AdoptedTreeNode,
  expanded: boolean,
): string | undefined {
  const query = iconThemeQueryForNode(node, expanded);
  if (!query) {
    return undefined;
  }
  const iconPath = resolveThemeIconPath(loaded.document, { ...query, light: loaded.light });
  if (!iconPath) {
    return undefined;
  }
  const absolute = path.normalize(path.join(loaded.themeDir.fsPath, iconPath));
  return webview.asWebviewUri(vscode.Uri.file(absolute)).toString();
}

function isLightColorTheme(kind: vscode.ColorThemeKind): boolean {
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

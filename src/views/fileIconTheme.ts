import { CONTEXT } from "./constants.js";
import { usesThemeFileIcon, type AdoptedTreeNode } from "./adoptedViewModel.js";

export interface IconDefinition {
  iconPath?: string;
}

export interface IconThemeAssociations {
  iconDefinitions?: Record<string, IconDefinition>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface IconThemeDocument extends IconThemeAssociations {
  light?: IconThemeAssociations;
}

export interface IconThemeQuery {
  fileName: string;
  isFolder: boolean;
  expanded: boolean;
  light: boolean;
}

export function parseIconThemeJson(text: string): IconThemeDocument {
  const trimmed = text.replace(/^\uFEFF/, "");
  try {
    return parseIconTheme(JSON.parse(trimmed) as unknown);
  } catch {
    const stripped = trimmed.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return parseIconTheme(JSON.parse(stripped) as unknown);
  }
}

export function parseIconTheme(value: unknown): IconThemeDocument {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as IconThemeDocument;
}

export function resolveThemeIconPath(theme: IconThemeDocument, query: IconThemeQuery): string | undefined {
  const resolved = query.light ? mergeLight(theme) : theme;
  const definitionId = query.isFolder
    ? resolveFolderDefinitionId(resolved, query.fileName, query.expanded)
    : resolveFileDefinitionId(resolved, query.fileName);
  if (!definitionId) {
    return undefined;
  }
  return resolved.iconDefinitions?.[definitionId]?.iconPath ?? theme.iconDefinitions?.[definitionId]?.iconPath;
}

export function iconThemeQueryForNode(
  node: AdoptedTreeNode,
  expanded: boolean,
): Omit<IconThemeQuery, "light"> | undefined {
  if (!usesThemeFileIcon(node)) {
    return undefined;
  }
  const fileName = fileNameForIcon(node);
  const isGitlink = node.contextValue.includes(CONTEXT.gitlink);
  return {
    fileName,
    isFolder: node.kind === "folder" || isGitlink,
    expanded,
  };
}

export function compactFolderDisplayLabel(label: string, sep: string): string {
  return label.split("/").join(` ${sep} `);
}

function mergeLight(theme: IconThemeDocument): IconThemeDocument {
  const light = theme.light;
  if (!light) {
    return theme;
  }
  return {
    ...theme,
    iconDefinitions: { ...theme.iconDefinitions, ...light.iconDefinitions },
    file: light.file ?? theme.file,
    folder: light.folder ?? theme.folder,
    folderExpanded: light.folderExpanded ?? theme.folderExpanded,
    fileExtensions: { ...theme.fileExtensions, ...light.fileExtensions },
    fileNames: { ...theme.fileNames, ...light.fileNames },
    folderNames: { ...theme.folderNames, ...light.folderNames },
    folderNamesExpanded: { ...theme.folderNamesExpanded, ...light.folderNamesExpanded },
    languageIds: { ...theme.languageIds, ...light.languageIds },
  };
}

function resolveFileDefinitionId(theme: IconThemeAssociations, fileName: string): string | undefined {
  const base = lastSegment(fileName);
  const byName = lookupCi(theme.fileNames, base) ?? lookupCi(theme.fileNames, fileName);
  if (byName) {
    return byName;
  }
  for (const extension of extensionKeys(base)) {
    const id = lookupCi(theme.fileExtensions, extension);
    if (id) {
      return id;
    }
  }
  return theme.file;
}

function resolveFolderDefinitionId(theme: IconThemeAssociations, fileName: string, expanded: boolean): string | undefined {
  const names = expanded ? theme.folderNamesExpanded : theme.folderNames;
  const specific = lookupCi(names, fileName) ?? lookupCi(names, lastSegment(fileName));
  if (specific) {
    return specific;
  }
  return (expanded ? theme.folderExpanded : theme.folder) ?? theme.folder;
}

function lookupCi(map: Record<string, string> | undefined, key: string): string | undefined {
  if (!map) {
    return undefined;
  }
  return map[key] ?? map[key.toLowerCase()];
}

function extensionKeys(fileName: string): string[] {
  const lower = fileName.toLowerCase();
  const keys: string[] = [];
  let index = lower.indexOf(".");
  while (index !== -1) {
    keys.push(lower.slice(index + 1));
    index = lower.indexOf(".", index + 1);
  }
  return keys;
}

function lastSegment(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? fileName;
}

function fileNameForIcon(node: AdoptedTreeNode): string {
  if (node.fileDiff?.path) {
    return node.fileDiff.path;
  }
  if (node.change?.resource.relativePath) {
    return node.change.resource.relativePath;
  }
  const arrow = " → ";
  if (node.label.includes(arrow)) {
    return node.label.slice(node.label.lastIndexOf(arrow) + arrow.length);
  }
  return node.label;
}

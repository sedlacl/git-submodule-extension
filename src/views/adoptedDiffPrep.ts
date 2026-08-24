import type { NameStatusKind } from "../git/types.js";
import type { AdoptedFileDiff } from "./adoptedViewModel.js";
import { shortSha } from "./adoptedViewModel.js";
import { GIT_SHOW_SCHEME } from "./constants.js";

export interface GitShowUriParts {
  scheme: typeof GIT_SHOW_SCHEME;
  path: string;
  query: string;
}

export interface ParsedGitShowUri {
  repoRoot: string;
  sha: string;
  gitPath: string;
  empty: boolean;
  status: string | null;
}

export interface PreparedFileDiff {
  title: string;
  original: GitShowUriParts;
  modified: GitShowUriParts;
  reveal: GitShowUriParts;
}

export type OpenAllResult = "changes" | "diff-fallback" | "empty";

export function gitShowUriParts(input: {
  repoRoot: string;
  sha: string;
  gitPath: string;
  empty?: boolean;
  status?: NameStatusKind;
}): GitShowUriParts {
  const query = new URLSearchParams();
  query.set("root", input.repoRoot);
  query.set("sha", input.sha);
  query.set("file", input.gitPath);
  if (input.empty) {
    query.set("empty", "1");
  }
  if (input.status) {
    query.set("status", input.status);
  }
  return {
    scheme: GIT_SHOW_SCHEME,
    path: `/${input.gitPath.replace(/^\/+/, "")}`,
    query: query.toString(),
  };
}

export function parseGitShowUri(uri: { path: string; query: string }): ParsedGitShowUri {
  const query = new URLSearchParams(uri.query);
  const fromQuery = query.get("file");
  const gitPath = fromQuery && fromQuery.length > 0 ? fromQuery : uri.path.replace(/^\/+/, "");
  return {
    repoRoot: query.get("root") ?? "",
    sha: query.get("sha") ?? "",
    gitPath,
    empty: query.get("empty") === "1",
    status: query.get("status"),
  };
}

export function prepareFileDiff(file: AdoptedFileDiff): PreparedFileDiff {
  const sides = diffSides(file);

  const original = gitShowUriParts({
    repoRoot: file.repoRoot,
    sha: sides.original.sha,
    gitPath: sides.original.gitPath,
    empty: sides.original.empty,
    status: file.status,
  });
  const modified = gitShowUriParts({
    repoRoot: file.repoRoot,
    sha: sides.modified.sha,
    gitPath: sides.modified.gitPath,
    empty: sides.modified.empty,
    status: file.status,
  });

  return {
    title: diffTitle(file),
    original,
    modified,
    reveal: sides.modified.empty ? original : modified,
  };
}

export function prepareOpenAll(title: string, files: readonly AdoptedFileDiff[]): {
  title: string;
  files: PreparedFileDiff[];
} {
  return {
    title,
    files: files.map(prepareFileDiff),
  };
}

export async function openPreparedChanges<TUri>(
  title: string,
  files: readonly PreparedFileDiff[],
  toUri: (parts: GitShowUriParts) => TUri,
  executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown>,
  useChanges: boolean,
): Promise<OpenAllResult> {
  if (files.length === 0) {
    return "empty";
  }

  if (useChanges) {
    const changes = files.map((file) => [toUri(file.original), toUri(file.modified), toUri(file.reveal)]);
    try {
      await executeCommand("vscode.changes", title, changes);
      return "changes";
    } catch {
      // Fall through to per-file vscode.diff.
    }
  }

  for (const file of files) {
    await executeCommand("vscode.diff", toUri(file.original), toUri(file.modified), file.title);
  }
  return "diff-fallback";
}

export function openAllTitle(label: string, fileCount: number): string {
  const count = fileCount === 1 ? "1 change" : `${fileCount} changes`;
  return `${label} (${count})`;
}

interface DiffSidePlan {
  sha: string;
  gitPath: string;
  empty?: boolean;
}

function diffSides(file: AdoptedFileDiff): { original: DiffSidePlan; modified: DiffSidePlan } {
  const source = { sha: file.fromSha, gitPath: file.path };
  const target = { sha: file.toSha, gitPath: file.path };
  switch (file.status) {
    case "added":
      return { original: { ...source, empty: true }, modified: target };
    case "deleted":
      return { original: source, modified: { ...target, empty: true } };
    case "renamed":
    case "copied":
      return {
        original: { ...source, gitPath: file.oldPath ?? file.path },
        modified: target,
      };
    case "modified":
    case "typechange":
    case "unmerged":
    case "unknown":
      return { original: source, modified: target };
  }
}

function diffTitle(file: AdoptedFileDiff): string {
  const name = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return `${name} (${file.kind} ${shortSha(file.fromSha)} → ${shortSha(file.toSha)})`;
}

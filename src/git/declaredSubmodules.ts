import { normalizeGitRelativePath } from "./pathUtils.js";
import type { DeclaredSubmodule, GitlinkEntry, GitmodulesEntry } from "./types.js";

export interface MergeDeclaredSubmodulesInput {
  indexGitmodules: readonly GitmodulesEntry[];
  headGitmodules: readonly GitmodulesEntry[];
  headGitlinks: readonly GitlinkEntry[];
  indexGitlinks: readonly GitlinkEntry[];
}

/**
 * Union of `.gitmodules` (index + HEAD) and gitlinks (HEAD + index), keyed by
 * relative POSIX path. Index metadata wins for current URL/branch; HEAD keeps
 * the committed branch used by restore.
 */
export function mergeDeclaredSubmodules(input: MergeDeclaredSubmodulesInput): DeclaredSubmodule[] {
  const byPath = new Map<string, DeclaredSubmodule>();
  const order: string[] = [];

  const note = (relativePath: string): DeclaredSubmodule => {
    const existing = byPath.get(relativePath);
    if (existing) {
      return existing;
    }
    const created: DeclaredSubmodule = {
      relativePath,
      name: relativePath,
      url: null,
      configuredBranch: null,
      committedConfiguredBranch: null,
      headGitlinkSha: null,
      indexGitlinkSha: null,
    };
    byPath.set(relativePath, created);
    order.push(relativePath);
    return created;
  };

  for (const entry of input.indexGitmodules) {
    const relativePath = normalizeGitRelativePath(entry.path);
    if (!relativePath) {
      continue;
    }
    const declared = note(relativePath);
    declared.name = entry.name || relativePath;
    declared.url = entry.url;
    declared.configuredBranch = entry.branch;
  }

  for (const entry of input.headGitmodules) {
    const relativePath = normalizeGitRelativePath(entry.path);
    if (!relativePath) {
      continue;
    }
    const declared = note(relativePath);
    declared.committedConfiguredBranch = entry.branch;
    if (!declared.configuredBranch) {
      declared.configuredBranch = entry.branch;
    }
    if (!declared.url) {
      declared.url = entry.url;
    }
    if (declared.name === relativePath && entry.name) {
      declared.name = entry.name;
    }
  }

  for (const link of input.headGitlinks) {
    const relativePath = normalizeGitRelativePath(link.path);
    if (!relativePath) {
      continue;
    }
    note(relativePath).headGitlinkSha = link.sha;
  }

  for (const link of input.indexGitlinks) {
    const relativePath = normalizeGitRelativePath(link.path);
    if (!relativePath) {
      continue;
    }
    const declared = note(relativePath);
    if (link.stage === 0 || declared.indexGitlinkSha === null) {
      declared.indexGitlinkSha = link.sha;
    }
  }

  return order.map((relativePath) => byPath.get(relativePath)).filter((entry): entry is DeclaredSubmodule => Boolean(entry));
}

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Normalize a repository root for identity comparison.
 * Drive letters are lowercased on Windows; separators become `/`.
 */
export function normalizeRepoPath(input: string): string {
  const resolved = path.resolve(input);
  const withForwardSlashes = resolved.replace(/\\/g, "/");
  return withForwardSlashes.replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}

/**
 * Resolve 8.3 short names and directory junctions so Git's
 * `rev-parse --show-toplevel` can be compared with Node paths on Windows.
 */
export function canonicalizeRepoPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return normalizeRepoPath(fs.realpathSync.native(resolved));
  } catch {
    try {
      return normalizeRepoPath(fs.realpathSync(resolved));
    } catch {
      return normalizeRepoPath(resolved);
    }
  }
}

export function sameRepoPath(left: string, right: string): boolean {
  return canonicalizeRepoPath(left) === canonicalizeRepoPath(right);
}

/**
 * Git `.gitmodules` and gitlink paths use POSIX separators. Reject absolute
 * paths and `..` traversal so callers can join them onto a parent root.
 */
export function normalizeGitRelativePath(raw: string): string | null {
  const stripped = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!stripped || stripped.startsWith("/") || /^[A-Za-z]:/.test(stripped)) {
    return null;
  }

  const posix = path.posix.normalize(stripped);
  if (posix === "." || posix === ".." || posix.startsWith("../") || posix.startsWith("/")) {
    return null;
  }

  return posix;
}

export function joinRepoPath(parentRoot: string, relativePosixPath: string): string {
  const segments = relativePosixPath.split("/").filter(Boolean);
  return path.join(parentRoot, ...segments);
}

export function displayNameFromRepoPath(repoPath: string): string {
  const normalized = normalizeRepoPath(repoPath);
  const base = normalized.split("/").filter(Boolean).pop();
  return base || normalized;
}

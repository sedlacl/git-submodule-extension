import { splitNul } from "./gitlinkParser.js";
import { parseSha } from "./sha.js";
import type { NameStatusEntry, NameStatusKind } from "./types.js";

const STATUS_BY_CODE: Record<string, NameStatusKind> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "typechange",
  U: "unmerged",
  R: "renamed",
  C: "copied",
};

const RAW_PREFIX =
  /^:([0-7]{6})\s+([0-7]{6})\s+([0-9a-f]{7,64}|0{7,40})\s+([0-9a-f]{7,64}|0{7,40})\s+([AMDTRCUX])(\d{0,3})$/i;

/**
 * Parse `git diff --name-status -z --find-renames A B`.
 * Rename/copy records consume two paths (old, new).
 */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const parts = splitNul(stdout);
  const entries: NameStatusEntry[] = [];
  let index = 0;

  while (index < parts.length) {
    const token = parts[index];
    index += 1;
    if (!token) {
      continue;
    }

    const code = token[0] ?? "";
    const similarityRaw = token.slice(1);
    const similarity = similarityRaw.length > 0 ? Number(similarityRaw) : undefined;
    const status = STATUS_BY_CODE[code] ?? "unknown";

    if (code === "R" || code === "C") {
      const oldPath = parts[index] ?? "";
      index += 1;
      const newPath = parts[index] ?? "";
      index += 1;
      if (!oldPath || !newPath) {
        continue;
      }
      entries.push({
        status,
        path: newPath,
        oldPath,
        similarity: Number.isFinite(similarity) ? similarity : undefined,
      });
      continue;
    }

    const filePath = parts[index] ?? "";
    index += 1;
    if (!filePath) {
      continue;
    }
    entries.push({ status, path: filePath });
  }

  return entries;
}

/**
 * Parse `git diff --raw -z --no-abbrev --find-renames A B`.
 * Keeps modes and full object names so gitlink pointer diffs can recurse.
 * Rename/copy records consume two paths (old, new).
 */
export function parseRawDiffZ(stdout: string): NameStatusEntry[] {
  const parts = splitNul(stdout);
  const entries: NameStatusEntry[] = [];
  let index = 0;

  while (index < parts.length) {
    const token = parts[index];
    index += 1;
    if (!token) {
      continue;
    }

    const match = token.match(RAW_PREFIX);
    if (!match) {
      continue;
    }

    const oldMode = match[1]!;
    const newMode = match[2]!;
    const oldShaRaw = match[3]!;
    const newShaRaw = match[4]!;
    const code = match[5]!.toUpperCase();
    const similarityRaw = match[6] ?? "";
    const similarity = similarityRaw.length > 0 ? Number(similarityRaw) : undefined;
    const status = STATUS_BY_CODE[code] ?? "unknown";
    const oldSha = zeroOrSha(oldShaRaw);
    const newSha = zeroOrSha(newShaRaw);

    if (code === "R" || code === "C") {
      const oldPath = parts[index] ?? "";
      index += 1;
      const newPath = parts[index] ?? "";
      index += 1;
      if (!oldPath || !newPath) {
        continue;
      }
      entries.push({
        status,
        path: newPath,
        oldPath,
        similarity: Number.isFinite(similarity) ? similarity : undefined,
        oldMode,
        newMode,
        oldSha,
        newSha,
      });
      continue;
    }

    const filePath = parts[index] ?? "";
    index += 1;
    if (!filePath) {
      continue;
    }
    entries.push({
      status,
      path: filePath,
      oldMode,
      newMode,
      oldSha,
      newSha,
    });
  }

  return entries;
}

function zeroOrSha(raw: string): string | undefined {
  if (/^0+$/.test(raw)) {
    return undefined;
  }
  return parseSha(raw) ?? undefined;
}

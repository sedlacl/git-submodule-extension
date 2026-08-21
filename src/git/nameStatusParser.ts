import { splitNul } from "./gitlinkParser.js";
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

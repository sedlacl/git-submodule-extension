import type { GitmodulesEntry } from "./types.js";

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  const matched = trimmed.match(/^"(.*)"$/);
  return matched ? matched[1] : trimmed;
}

function isCommentLine(line: string): boolean {
  return line.startsWith("#") || line.startsWith(";");
}

/**
 * Parse a `.gitmodules` blob. Values may be quoted (required for paths
 * containing `#`, as in infra-deploy `#t1/#t2/#prod` checkouts).
 */
export function parseGitmodules(content: string): GitmodulesEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: Array<{ name: string; path?: string; url?: string; branch?: string }> = [];
  let current: { name: string; path?: string; url?: string; branch?: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || isCommentLine(line)) {
      continue;
    }

    const sectionMatch = line.match(/^\[submodule\s+(?:"([^"]+)"|([^\]]+))\]$/);
    if (sectionMatch) {
      const name = (sectionMatch[1] ?? sectionMatch[2] ?? "").trim();
      current = { name };
      entries.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const propertyMatch = line.match(/^([A-Za-z0-9.-]+)\s*=\s*(.+)$/);
    if (!propertyMatch) {
      continue;
    }

    const key = propertyMatch[1];
    const value = stripOptionalQuotes(propertyMatch[2] ?? "");
    if (key === "path") {
      current.path = value;
    } else if (key === "url") {
      current.url = value;
    } else if (key === "branch") {
      current.branch = value;
    }
  }

  return entries
    .filter((entry): entry is { name: string; path: string; url?: string; branch?: string } => Boolean(entry.path))
    .map((entry) => ({
      name: entry.name || entry.path,
      path: entry.path,
      url: entry.url ?? null,
      branch: entry.branch ?? null,
    }));
}

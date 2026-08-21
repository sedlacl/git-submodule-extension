import * as fs from "node:fs";
import * as path from "node:path";

/** Repository root (npm scripts run with cwd set to the project root). */
export function getProjectRoot(): string {
  return process.cwd();
}

/** Convert an absolute filesystem path to a local `file://` URL for Git submodule URLs. */
export function toFileUrl(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  let normalized = resolved;
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Path may not exist yet while planning submodule URLs.
  }
  const posix = normalized.replace(/\\/g, "/");
  const withLeadingSlash = posix.startsWith("/") ? posix : `/${posix}`;
  return `file://${withLeadingSlash}`;
}

/** Quote a path for safe inclusion in generated JSON / shell docs (platform-aware). */
export function quotePathForDocs(absolutePath: string): string {
  if (process.platform === "win32") {
    return `"${absolutePath.replace(/"/g, '\\"')}"`;
  }
  return `'${absolutePath.replace(/'/g, "'\\''")}'`;
}

/** Isolated VS Code profile directories under `.vscode-test/`. */
export function getVsCodeTestProfileArgs(projectRoot: string): string[] {
  const base = path.join(projectRoot, ".vscode-test");
  return [
    `--extensions-dir=${path.join(base, "extensions")}`,
    `--user-data-dir=${path.join(base, "user-data")}`,
  ];
}

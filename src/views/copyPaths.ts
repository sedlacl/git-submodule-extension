import * as path from "node:path";
import type { AdoptedTreeNode } from "./adoptedViewModel.js";

/** File or folder on disk behind a row: a change, a change folder, or an adopted file in the submodule checkout. */
export function nodeFilePath(node: AdoptedTreeNode): string | undefined {
  const filePath =
    node.change?.resource.uri ??
    node.resourceUri ??
    (node.fileDiff ? path.join(node.fileDiff.repoRoot, node.fileDiff.path) : undefined);
  return filePath ? path.normalize(filePath) : undefined;
}

/**
 * Explorer's Copy Relative Path separator (`explorer.copyRelativePathSeparator`): `auto` uses the
 * platform separator. `relativePath` is what `workspace.asRelativePath` returns, with `/` separators.
 */
export function relativeCopyPath(relativePath: string, separator: string, platformSeparator = path.sep): string {
  const target = separator === "/" || separator === "\\" ? separator : platformSeparator;
  return relativePath.replace(/[\\/]/g, target);
}

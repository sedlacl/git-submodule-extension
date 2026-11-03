import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";
import { contextActions } from "../../../src/views/changesRowActions.js";
import { COMMANDS, CONTEXT } from "../../../src/views/constants.js";
import { nodeFilePath, relativeCopyPath } from "../../../src/views/copyPaths.js";

function node(partial: Partial<AdoptedTreeNode>): AdoptedTreeNode {
  return {
    id: "row",
    kind: "change",
    label: "row",
    tooltip: "row",
    collapsible: false,
    expandByDefault: false,
    contextValue: CONTEXT.changeWorkingTree,
    iconId: "file",
    children: [],
    ...partial,
  };
}

describe("copy paths", () => {
  it("offers Copy Path and Copy Relative Path only on rows backed by a file or folder", () => {
    const copies = (contextValue: string) =>
      contextActions(contextValue)
        .filter((action) => action.command === COMMANDS.copyPath || action.command === COMMANDS.copyRelativePath)
        .map((action) => action.command);
    for (const contextValue of [
      CONTEXT.changeWorkingTree,
      `${CONTEXT.changeIndex}.${CONTEXT.gitlink}`,
      CONTEXT.resourceFolderUntracked,
      CONTEXT.file,
      CONTEXT.folder,
    ]) {
      expect(copies(contextValue)).toEqual([COMMANDS.copyPath, COMMANDS.copyRelativePath]);
    }
    for (const contextValue of [
      `${CONTEXT.workspaceRoot}.${CONTEXT.hasUpstream}`,
      CONTEXT.changeGroupWorkingTree,
      CONTEXT.adoptedGroup,
      CONTEXT.adoptedPointer,
      CONTEXT.localChangesLink,
    ]) {
      expect(copies(contextValue)).toEqual([]);
    }
  });

  it("reads the change, folder, or adopted file path in platform form", () => {
    const root = path.resolve("/ws/app");
    expect(nodeFilePath(node({ resourceUri: `${root}/src/a.ts` }))).toBe(path.join(root, "src", "a.ts"));
    expect(
      nodeFilePath(
        node({
          kind: "file",
          fileDiff: { repoRoot: root, kind: "staged", fromSha: "a", toSha: "b", status: "modified", path: "lib/b.ts" },
        }),
      ),
    ).toBe(path.join(root, "lib", "b.ts"));
    expect(nodeFilePath(node({ kind: "message" }))).toBeUndefined();
  });

  it("follows explorer.copyRelativePathSeparator", () => {
    expect(relativeCopyPath("src/views/a.ts", "auto", "\\")).toBe("src\\views\\a.ts");
    expect(relativeCopyPath("src/views/a.ts", "auto", "/")).toBe("src/views/a.ts");
    expect(relativeCopyPath("src\\views\\a.ts", "/", "\\")).toBe("src/views/a.ts");
    expect(relativeCopyPath("src/views/a.ts", "\\", "/")).toBe("src\\views\\a.ts");
  });
});

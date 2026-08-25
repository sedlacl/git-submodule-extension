import { describe, expect, it } from "vitest";
import { ResourceStatus } from "../../../src/git/repositoryState.js";
import { CONTEXT } from "../../../src/views/constants.js";
import {
  compactFolderDisplayLabel,
  iconThemeQueryForNode,
  parseIconThemeJson,
  resolveThemeIconPath,
} from "../../../src/views/fileIconTheme.js";
import type { AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";

const theme = parseIconThemeJson(`{
  "iconDefinitions": {
    "file": { "iconPath": "./icons/file.svg" },
    "folder": { "iconPath": "./icons/folder.svg" },
    "folder-open": { "iconPath": "./icons/folder-open.svg" },
    "javascript": { "iconPath": "./icons/javascript.svg" },
    "test-js": { "iconPath": "./icons/test-js.svg" },
    "folder-config": { "iconPath": "./icons/folder-config.svg" },
    "folder-config-open": { "iconPath": "./icons/folder-config-open.svg" }
  },
  "file": "file",
  "folder": "folder",
  "folderExpanded": "folder-open",
  "fileExtensions": {
    "js": "javascript",
    "test.js": "test-js"
  },
  "fileNames": {
    "package.json": "javascript"
  },
  "folderNames": {
    "configuration": "folder-config"
  },
  "folderNamesExpanded": {
    "configuration": "folder-config-open"
  }
}`);

function node(partial: Partial<AdoptedTreeNode> & Pick<AdoptedTreeNode, "id" | "kind" | "label">): AdoptedTreeNode {
  return {
    tooltip: partial.label,
    collapsible: false,
    expandByDefault: false,
    contextValue: CONTEXT.file,
    iconId: "file",
    children: [],
    ...partial,
  };
}

describe("file icon theme matching", () => {
  it("picks Material-style file, test suffix, and named folder icons", () => {
    expect(
      resolveThemeIconPath(theme, { fileName: "app.js", isFolder: false, expanded: false, light: false }),
    ).toBe("./icons/javascript.svg");
    expect(
      resolveThemeIconPath(theme, { fileName: "foo.test.js", isFolder: false, expanded: false, light: false }),
    ).toBe("./icons/test-js.svg");
    expect(
      resolveThemeIconPath(theme, { fileName: "package.json", isFolder: false, expanded: false, light: false }),
    ).toBe("./icons/javascript.svg");
    expect(
      resolveThemeIconPath(theme, { fileName: "configuration", isFolder: true, expanded: false, light: false }),
    ).toBe("./icons/folder-config.svg");
    expect(
      resolveThemeIconPath(theme, { fileName: "initDataSets/dataFlows", isFolder: true, expanded: true, light: false }),
    ).toBe("./icons/folder-open.svg");
    expect(
      resolveThemeIconPath(theme, { fileName: "src/util/configuration", isFolder: true, expanded: true, light: false }),
    ).toBe("./icons/folder-config-open.svg");
  });

  it("falls back to generic file when the theme has no SVG path", () => {
    expect(
      resolveThemeIconPath(
        { iconDefinitions: { file: { } }, file: "file" },
        { fileName: "app.js", isFolder: false, expanded: false, light: false },
      ),
    ).toBeUndefined();
  });
});

describe("icon theme queries", () => {
  it("treats gitlinks as folders and change files as files", () => {
    const file = node({
      id: "c1",
      kind: "change",
      label: "a.ts",
      iconId: "file",
      change: {
        rootPath: "/ws",
        group: "workingTree",
        resource: {
          uri: "/ws/src/a.ts",
          originalUri: "/ws/src/a.ts",
          status: ResourceStatus.MODIFIED,
          relativePath: "src/a.ts",
        },
      },
    });
    const gitlink = node({
      id: "g1",
      kind: "change",
      label: "mod",
      iconId: "file",
      contextValue: `${CONTEXT.changeWorkingTree}.${CONTEXT.gitlink}`,
    });
    const folder = node({
      id: "f1",
      kind: "folder",
      label: "src/util",
      iconId: "folder",
      collapsible: true,
    });
    expect(iconThemeQueryForNode(file, false)).toEqual({ fileName: "src/a.ts", isFolder: false, expanded: false });
    expect(iconThemeQueryForNode(gitlink, true)).toEqual({ fileName: "mod", isFolder: true, expanded: true });
    expect(iconThemeQueryForNode(folder, true)).toEqual({ fileName: "src/util", isFolder: true, expanded: true });
  });
});

describe("compact folder labels", () => {
  it("joins nested folder names with the platform separator used by built-in SCM", () => {
    expect(compactFolderDisplayLabel("initDataSets/dataFlows", "\\")).toBe("initDataSets \\ dataFlows");
    expect(compactFolderDisplayLabel("src", "/")).toBe("src");
  });
});

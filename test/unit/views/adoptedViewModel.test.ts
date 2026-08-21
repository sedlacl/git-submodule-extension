import { describe, expect, it } from "vitest";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import type { RepoPins, RepoWorkingState, SubmoduleNode, WorkspaceRootNode } from "../../../src/git/types.js";
import {
  applyRestoreOverlay,
  buildAdoptedTree,
  fileDecoration,
  fileNodesFromNameStatus,
  submoduleIcon,
  submoduleStatusSummary,
  treeCollapsibleMode,
  treeItemCommand,
  usesThemeFileIcon,
} from "../../../src/views/adoptedViewModel.js";
import { COMMANDS, CONTEXT } from "../../../src/views/constants.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHECKOUT = "cccccccccccccccccccccccccccccccccccccccc";
const NESTED_HEAD = "dddddddddddddddddddddddddddddddddddddddd";

function cleanState(overrides: Partial<RepoWorkingState> = {}): RepoWorkingState {
  return {
    uninitialized: false,
    dirty: false,
    detached: false,
    diverged: false,
    pointerMismatch: false,
    operationInProgress: false,
    probeFailed: false,
    ...overrides,
  };
}

function submodule(input: {
  rootPath: string;
  parentRootPath: string;
  relativePath: string;
  pins: RepoPins;
  workingState?: Partial<RepoWorkingState>;
  branchName?: string | null;
  children?: SubmoduleNode[];
}): SubmoduleNode {
  const workingState = cleanState(input.workingState);
  return {
    id: input.rootPath,
    kind: "submodule",
    rootPath: input.rootPath,
    displayName: input.relativePath.split("/").pop() ?? input.relativePath,
    children: input.children ?? [],
    parentRootPath: input.parentRootPath,
    relativePath: input.relativePath,
    name: input.relativePath,
    url: "ssh://git@example/mod.git",
    pins: input.pins,
    branch: {
      name: workingState.detached ? null : (input.branchName ?? "main"),
      upstream: workingState.detached ? null : "origin/main",
      ahead: 0,
      behind: 0,
      detached: workingState.detached,
      configuredBranch: "main",
      committedConfiguredBranch: "main",
    },
    workingState,
    adoptedChanges: computeAdoptedPointers(input.pins),
  };
}

function workspaceRoot(rootPath: string, children: SubmoduleNode[]): WorkspaceRootNode {
  return {
    id: rootPath,
    kind: "workspace-root",
    rootPath,
    workspaceFolderPath: rootPath,
    displayName: rootPath.split("/").pop() ?? rootPath,
    children,
  };
}

describe("buildAdoptedTree", () => {
  it("nests workspace repos, direct/nested submodules, and Adopted Changes groups", () => {
    const nested = submodule({
      rootPath: "/ws/http/common/data",
      parentRootPath: "/ws/http/common",
      relativePath: "submodules/uu_energygateway_datagatewayg01",
      pins: { headGitlinkSha: NESTED_HEAD, indexGitlinkSha: NESTED_HEAD, checkoutHeadSha: CHECKOUT },
      workingState: { detached: true, pointerMismatch: true },
    });
    const common = submodule({
      rootPath: "/ws/http/common",
      parentRootPath: "/ws/http",
      relativePath: "submodules/usy_idsmari_commong01",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: HEAD },
      branchName: "development/AFLEX",
      children: [nested],
    });
    const httplib = submodule({
      rootPath: "/ws/http/httplib",
      parentRootPath: "/ws/http",
      relativePath: "submodules/uu_energygateway_httpendpointg01",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: INDEX, checkoutHeadSha: INDEX },
    });
    const tree = buildAdoptedTree({
      roots: [workspaceRoot("/ws/http", [httplib, common]), workspaceRoot("/ws/plain", [])],
    });

    expect(tree.map((node) => node.label)).toEqual(["http", "plain"]);
    expect(tree[0]?.kind).toBe("workspace-root");
    expect(tree[0]?.children.map((child) => child.kind)).toEqual(["submodule", "submodule"]);
    expect(treeCollapsibleMode(tree[0]!)).toBe("expanded");
    expect(treeCollapsibleMode(tree[1]!)).toBe("none");

    const [libNode, commonNode] = tree[0]!.children;
    expect(libNode?.children[0]?.kind).toBe("adopted-group");
    expect(libNode?.children[0]?.description).toBe("staged");
    expect(libNode?.children[0]?.children.map((child) => child.kind)).toEqual(["staged"]);
    expect(libNode?.children[0]?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/httplib",
      fromSha: HEAD,
      toSha: INDEX,
      kind: "staged",
    });

    expect(commonNode?.children.map((child) => child.kind)).toEqual(["adopted-group", "submodule"]);
    expect(commonNode?.children[0]?.description).toBe("none");
    expect(treeCollapsibleMode(commonNode!.children[0]!)).toBe("none");

    const nestedNode = commonNode?.children[1];
    expect(nestedNode?.label).toBe("uu_energygateway_datagatewayg01");
    expect(nestedNode?.children[0]?.description).toBe("unstaged");
    expect(nestedNode?.children[0]?.children[0]?.kind).toBe("unstaged");
    expect(nestedNode?.children[0]?.children[0]?.diffSpec?.kind).toBe("unstaged");
    expect(nestedNode?.description).toContain("detached");
  });

  it("keeps Adopted Changes on every submodule even when both pointers match", () => {
    const child = submodule({
      rootPath: "/ws/app/mod",
      parentRootPath: "/ws/app",
      relativePath: "mod",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: HEAD },
    });
    const [root] = buildAdoptedTree({ roots: [workspaceRoot("/ws/app", [child])] });
    expect(root?.children[0]?.children[0]).toMatchObject({
      kind: "adopted-group",
      label: "Adopted Changes",
      description: "none",
      contextValue: CONTEXT.adoptedGroup,
    });
  });
});

describe("fileNodesFromNameStatus", () => {
  const spec = {
    repoRoot: "/ws/http/httplib",
    fromSha: HEAD,
    toSha: INDEX,
    kind: "staged" as const,
  };

  it("maps add, modify, delete, and rename into file nodes with open-diff commands", () => {
    const nodes = fileNodesFromNameStatus(spec, [
      { status: "added", path: "src/new.ts" },
      { status: "modified", path: "src/index.ts" },
      { status: "deleted", path: "gone.md" },
      { status: "renamed", path: "new/name.ts", oldPath: "old/name.ts", similarity: 100 },
    ]);

    expect(nodes.map((node) => node.label)).toEqual(["src/new.ts", "src/index.ts", "gone.md", "old/name.ts → new/name.ts"]);
    expect(nodes.map((node) => node.description)).toEqual(["A", "M", "D", "R"]);
    expect(nodes[3]?.fileDiff).toEqual({
      repoRoot: spec.repoRoot,
      kind: "staged",
      fromSha: HEAD,
      toSha: INDEX,
      status: "renamed",
      path: "new/name.ts",
      oldPath: "old/name.ts",
      similarity: 100,
    });
    expect(treeItemCommand(nodes[0]!)).toEqual({
      command: COMMANDS.openDiff,
      title: "Open Diff",
      arguments: [nodes[0]],
    });
    expect(treeCollapsibleMode(nodes[0]!)).toBe("none");
    expect(usesThemeFileIcon(nodes[0]!)).toBe(true);
    expect(usesThemeFileIcon(nodes[3]!)).toBe(true);
  });

  it("renders an informational child when the pointer shifted but name-status is empty", () => {
    const nodes = fileNodesFromNameStatus(spec, []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("message");
    expect(nodes[0]?.label).toBe("No file changes");
    expect(treeItemCommand(nodes[0]!)).toBeUndefined();
  });
});

describe("submodule decorations", () => {
  it("summarizes dirty, detached, and uninitialized states", () => {
    expect(submoduleStatusSummary(cleanState({ uninitialized: true }), "main", HEAD)).toBe("uninitialized");
    expect(submoduleStatusSummary(cleanState({ detached: true }), null, CHECKOUT)).toBe(`detached ${CHECKOUT.slice(0, 7)}`);
    expect(submoduleStatusSummary(cleanState({ dirty: true, pointerMismatch: true }), "main", HEAD)).toBe("main · dirty · pointer");
    expect(submoduleIcon(cleanState({ uninitialized: true })).iconId).toBe("circle-slash");
    expect(submoduleIcon(cleanState({ dirty: true })).iconId).toBe("warning");
    expect(fileDecoration("added").badge).toBe("A");
    expect(fileDecoration("deleted").badge).toBe("D");
  });
});

describe("restore overlay", () => {
  it("marks blocked submodules without changing file icon theme usage", () => {
    const child = submodule({
      rootPath: "/ws/app/mod",
      parentRootPath: "/ws/app",
      relativePath: "mod",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: HEAD },
    });
    const [root] = buildAdoptedTree({ roots: [workspaceRoot("/ws/app", [child])] });
    const overlaid = applyRestoreOverlay(root ? [root] : [], (childRoot) =>
      childRoot === "/ws/app/mod"
        ? {
            path: "mod",
            parentRootPath: "/ws/app",
            childRootPath: "/ws/app/mod",
            action: "blocked",
            detail: "working tree is dirty",
          }
        : undefined,
    );
    const submoduleNode = overlaid[0]?.children[0];
    expect(submoduleNode?.contextValue).toBe(`${CONTEXT.submodule}.restoreBlocked`);
    expect(submoduleNode?.description).toContain("restore blocked");
    expect(submoduleNode?.tooltip).toContain("working tree is dirty");
    expect(submoduleNode?.restoreTarget).toMatchObject({ childRootPath: "/ws/app/mod", branch: "main" });
    expect(usesThemeFileIcon(submoduleNode!)).toBe(false);
  });
});

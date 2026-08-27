import { describe, expect, it } from "vitest";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import { ResourceStatus } from "../../../src/git/repositoryState.js";
import type { RepoPins, RepoWorkingState, SubmoduleNode, WorkspaceRootNode } from "../../../src/git/types.js";
import {
  applyRestoreOverlay,
  buildAdoptedTree,
  buildBootstrapRepoNodes,
  fileDecoration,
  fileNodesFromNameStatus,
  restoreBlockedSummary,
  submoduleIcon,
  submoduleStatusSummary,
  treeCollapsibleMode,
  treeItemCodicon,
  treeItemCommand,
  treeItemFileKindIcon,
  usesThemeFileIcon,
  type AdoptedTreeNode,
} from "../../../src/views/adoptedViewModel.js";
import { BUILTIN_GROUP_LABELS } from "../../../src/views/builtinGitParity.js";
import { DEFAULT_CHANGES_TREE_SETTINGS, emptyChangeGroups } from "../../../src/views/changesTreeSettings.js";
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

function byKind(nodes: readonly AdoptedTreeNode[] | undefined, kind: AdoptedTreeNode["kind"]): AdoptedTreeNode[] {
  return (nodes ?? []).filter((node) => node.kind === kind);
}

function byLabel(nodes: readonly AdoptedTreeNode[] | undefined, label: string): AdoptedTreeNode | undefined {
  return nodes?.find((node) => node.label === label);
}

function findByRelativePath(
  nodes: readonly AdoptedTreeNode[] | undefined,
  relativePath: string,
): AdoptedTreeNode | undefined {
  for (const node of nodes ?? []) {
    if (node.change?.resource.relativePath === relativePath) {
      return node;
    }
    const nested = findByRelativePath(node.children, relativePath);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

describe("buildAdoptedTree", () => {
  it("nests pointer diffs under the parent gitlink row, not the child checkout", () => {
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
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: INDEX },
      workingState: { pointerMismatch: true },
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
    expect(treeItemCodicon(tree[0]!)).toEqual({ id: "repo", colorId: "foreground" });
    expect(treeItemFileKindIcon(tree[0]!)).toBeUndefined();
    expect(tree[0]?.decoration?.themeColorId).toBe("gitDecoration.submoduleResourceForeground");
    expect(tree[1]?.decoration).toBeUndefined();
    expect(tree[0]?.children.map((child) => child.kind)).toEqual([
      "change-group",
      "change-group",
      "submodule",
      "submodule",
    ]);
    expect(treeCollapsibleMode(tree[0]!)).toBe("expanded");
    expect(treeCollapsibleMode(tree[1]!)).toBe("none");
    expect(byKind(tree[1]?.children, "adopted-group")).toEqual([]);
    expect(tree[1]?.children).toEqual([]);

    const staged = byLabel(tree[0]?.children, BUILTIN_GROUP_LABELS.index);
    const changes = byLabel(tree[0]?.children, BUILTIN_GROUP_LABELS.workingTree);
    const libGitlink = findByRelativePath(staged?.children, "submodules/uu_energygateway_httpendpointg01");
    expect(libGitlink).toMatchObject({
      kind: "change",
      label: "uu_energygateway_httpendpointg01",
      contextValue: `${CONTEXT.changeIndex}.${CONTEXT.gitlink}`,
      decoration: { badge: "S", tooltip: "Submodule" },
      description: `${HEAD.slice(0, 7)} → main`,
    });
    expect(libGitlink?.children[0]).toMatchObject({
      kind: "adopted-group",
      label: "Adopted Changes",
      description: undefined,
      expandByDefault: false,
      contextValue: CONTEXT.adoptedGroup,
    });
    expect(treeItemFileKindIcon(libGitlink!)).toBe("file");
    expect(treeItemCodicon(libGitlink!)).toBeUndefined();
    expect(libGitlink?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/httplib",
      fromSha: HEAD,
      toSha: INDEX,
      kind: "staged",
    });

    const commonGitlink = findByRelativePath(changes?.children, "submodules/usy_idsmari_commong01");
    expect(commonGitlink?.label).toBe("usy_idsmari_commong01");
    expect(commonGitlink?.decoration?.badge).toBe("S");
    expect(commonGitlink?.description).toBe(`${HEAD.slice(0, 7)} → development/AFLEX`);
    expect(commonGitlink?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/common",
      fromSha: HEAD,
      toSha: INDEX,
      kind: "unstaged",
    });

    const libNode = byLabel(tree[0]?.children, "uu_energygateway_httpendpointg01");
    const commonNode = byLabel(tree[0]?.children, "usy_idsmari_commong01");
    expect(libNode?.kind).toBe("submodule");
    expect(treeItemCodicon(libNode!)).toEqual({ id: "file-submodule", colorId: "foreground" });
    expect(byKind(libNode?.children, "adopted-group")).toEqual([]);
    expect(libNode?.children).toEqual([]);
    expect(treeCollapsibleMode(libNode!)).toBe("none");

    const nestedGitlink = findByRelativePath(
      byLabel(commonNode?.children, BUILTIN_GROUP_LABELS.workingTree)?.children,
      "submodules/uu_energygateway_datagatewayg01",
    );
    expect(nestedGitlink?.kind).toBe("change");
    expect(nestedGitlink?.decoration?.badge).toBe("S");
    expect(nestedGitlink?.description).toBe(`${NESTED_HEAD.slice(0, 7)} → ${CHECKOUT.slice(0, 7)}`);
    expect(nestedGitlink?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/common/data",
      fromSha: NESTED_HEAD,
      toSha: CHECKOUT,
      kind: "unstaged",
    });

    const nestedNode = byLabel(commonNode?.children, "uu_energygateway_datagatewayg01");
    expect(nestedNode?.kind).toBe("submodule");
    expect(nestedNode?.description).toContain("detached");
    expect(byKind(nestedNode?.children, "adopted-group")).toEqual([]);
    expect(nestedNode?.children).toEqual([]);
  });

  it("omits gitlink rows when the parent has no pointer diffs", () => {
    const child = submodule({
      rootPath: "/ws/app/mod",
      parentRootPath: "/ws/app",
      relativePath: "mod",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: HEAD },
    });
    const [root] = buildAdoptedTree({ roots: [workspaceRoot("/ws/app", [child])] });
    expect(byKind(root?.children, "adopted-group")).toEqual([]);
    expect(root?.children.map((node) => node.kind)).toEqual(["submodule"]);
    expect(byKind(root?.children[0]?.children, "adopted-group")).toEqual([]);
    expect(root?.children[0]?.children).toEqual([]);
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
    const nodes = fileNodesFromNameStatus(
      spec,
      [
        { status: "added", path: "src/new.ts" },
        { status: "modified", path: "src/index.ts" },
        { status: "deleted", path: "gone.md" },
        { status: "renamed", path: "new/name.ts", oldPath: "old/name.ts", similarity: 100 },
      ],
      { ...DEFAULT_CHANGES_TREE_SETTINGS, viewMode: "list" },
    );

    expect(nodes.map((node) => node.label)).toEqual(["src/new.ts", "src/index.ts", "gone.md", "old/name.ts → new/name.ts"]);
    expect(nodes.map((node) => node.decoration?.badge)).toEqual(["A", "M", "D", "R"]);
    expect(nodes.map((node) => node.description)).toEqual([undefined, undefined, undefined, undefined]);
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
      command: COMMANDS.openChange,
      title: "Open Changes",
      arguments: [nodes[0]],
    });
    expect(treeCollapsibleMode(nodes[0]!)).toBe("none");
    expect(usesThemeFileIcon(nodes[0]!)).toBe(true);
    expect(usesThemeFileIcon(nodes[3]!)).toBe(true);
  });

  it("returns no children when the pointer shifted but name-status is empty", () => {
    expect(fileNodesFromNameStatus(spec, [])).toEqual([]);
  });

  it("nests adopted files by folder in tree view mode", () => {
    const nodes = fileNodesFromNameStatus(spec, [
      { status: "added", path: "src/new.ts" },
      { status: "modified", path: "src/index.ts" },
      { status: "deleted", path: "gone.md" },
    ]);
    expect(nodes.map((node) => node.label)).toEqual(["gone.md", "src"]);
    expect(nodes[1]?.kind).toBe("folder");
    expect(treeItemFileKindIcon(nodes[1]!)).toBe("folder");
    expect(treeItemFileKindIcon(nodes[1]!.children[0]!)).toBe("file");
    expect(nodes[1]?.children.map((child) => child.label)).toEqual(["index.ts", "new.ts"]);
  });

  it("renders historical gitlinks as recursive pointer rows using tree SHAs, not live pins", () => {
    const nestedFrom = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const nestedTo = "ffffffffffffffffffffffffffffffffffffffff";
    const liveCheckout = CHECKOUT;
    const child = submodule({
      rootPath: "/ws/http/common/data",
      parentRootPath: "/ws/http/common",
      relativePath: "submodules/uu_energygateway_datagatewayg01",
      pins: { headGitlinkSha: NESTED_HEAD, indexGitlinkSha: NESTED_HEAD, checkoutHeadSha: liveCheckout },
      workingState: { detached: true, pointerMismatch: true },
    });
    const commonSpec = {
      repoRoot: "/ws/http/common",
      fromSha: HEAD,
      toSha: INDEX,
      kind: "unstaged" as const,
    };
    const nodes = fileNodesFromNameStatus(
      commonSpec,
      [
        {
          status: "modified",
          path: "submodules/uu_energygateway_datagatewayg01",
          oldMode: "160000",
          newMode: "160000",
          oldSha: nestedFrom,
          newSha: nestedTo,
        },
        { status: "modified", path: "notes.txt", oldMode: "100644", newMode: "100644", oldSha: HEAD, newSha: INDEX },
      ],
      { ...DEFAULT_CHANGES_TREE_SETTINGS, viewMode: "list" },
      [child],
    );

    const pointer = nodes.find((node) => node.kind === "pointer");
    expect(pointer).toMatchObject({
      kind: "pointer",
      label: "submodules/uu_energygateway_datagatewayg01",
      description: `${nestedFrom.slice(0, 7)} → ${nestedTo.slice(0, 7)}`,
      decoration: { badge: "S", tooltip: "Submodule" },
      collapsible: true,
      contextValue: CONTEXT.adoptedPointer,
    });
    expect(pointer?.diffSpec).toBeUndefined();
    expect(pointer?.children[0]).toMatchObject({
      kind: "adopted-group",
      label: "Adopted Changes",
      expandByDefault: false,
      diffSpec: {
        repoRoot: "/ws/http/common/data",
        fromSha: nestedFrom,
        toSha: nestedTo,
        kind: "unstaged",
      },
    });
    expect(pointer?.children[0]?.diffSpec?.fromSha).not.toBe(liveCheckout);
    expect(pointer?.children[0]?.diffSpec?.toSha).not.toBe(liveCheckout);
    expect(treeCollapsibleMode(pointer!)).toBe("expanded");
    expect(treeItemFileKindIcon(pointer!)).toBe("file");
    expect(nodes.find((node) => node.label === "notes.txt")?.kind).toBe("file");
  });

  it("keeps unrecognized gitlink rows as ordinary files when the child is missing", () => {
    const nodes = fileNodesFromNameStatus(
      spec,
      [
        {
          status: "modified",
          path: "submodules/missing",
          oldMode: "160000",
          newMode: "160000",
          oldSha: HEAD,
          newSha: INDEX,
        },
      ],
      { ...DEFAULT_CHANGES_TREE_SETTINGS, viewMode: "list" },
      [],
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("file");
    expect(nodes[0]?.collapsible).toBe(false);
    expect(nodes[0]?.decoration?.badge).toBe("M");
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
    const submoduleNode = overlaid[0]?.children.find((child) => child.kind === "submodule");
    expect(submoduleNode?.contextValue).toBe(`${CONTEXT.submodule}.restoreBlocked`);
    expect(submoduleNode?.description).toContain("restore blocked: working tree is dirty");
    expect(submoduleNode?.tooltip).toContain("working tree is dirty");
    expect(submoduleNode?.restoreTarget).toMatchObject({ childRootPath: "/ws/app/mod", branch: "main" });
    expect(usesThemeFileIcon(submoduleNode!)).toBe(false);
  });

  it("shortens the row reason to the leading clause and keeps the full detail in the tooltip", () => {
    expect(restoreBlockedSummary("pinned commit is not an ancestor of origin/aflex/6.3")).toBe(
      "pinned commit is not an ancestor of origin/aflex/6.3",
    );
    expect(restoreBlockedSummary("missing refs/remotes/origin/aflex/6.3; fetch it explicitly")).toBe(
      "missing refs/remotes/origin/aflex/6.3",
    );
    expect(restoreBlockedSummary("git switch failed\nfatal: unable to write ref\nhint: retry")).toBe(
      "git switch failed",
    );
    expect(restoreBlockedSummary(`local branch ${"a".repeat(80)} has commits not on origin`)).toHaveLength(60);
    expect(restoreBlockedSummary("   ")).toBe("unknown reason");
  });
});

describe("bootstrap repo nodes", () => {
  it("builds workspace rows from vscode.git snapshots without a git model", () => {
    const nodes = buildBootstrapRepoNodes(
      [
        {
          rootPath: "/ws/httpendpoint",
          head: { name: "main", commit: "c1", detached: false },
          remotes: [],
          groups: {
            ...emptyChangeGroups(),
            workingTree: [
              {
                uri: "/ws/httpendpoint/app.ts",
                originalUri: "/ws/httpendpoint/app.ts",
                status: ResourceStatus.MODIFIED,
                relativePath: "app.ts",
              },
            ],
          },
        },
      ],
      ["/ws/httpendpoint", "/ws/other"],
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe("root:/ws/httpendpoint");
    expect(nodes[0]?.label).toBe("httpendpoint");
    expect(nodes[0]?.description).toBe("main*");
    expect(nodes[0]?.syncLabel).toBeUndefined();
    expect(nodes[0]?.children.some((child) => child.kind === "change-group" && child.label === "Changes")).toBe(true);
  });

  it("attaches the built-in syncLabel from ahead/behind without changing the branch description", () => {
    const child = submodule({
      rootPath: "/ws/app/mod",
      parentRootPath: "/ws/app",
      relativePath: "mod",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: HEAD },
    });
    const [root] = buildAdoptedTree(
      { roots: [workspaceRoot("/ws/app", [child])] },
      [
        {
          rootPath: "/ws/app",
          head: {
            name: "master",
            commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            upstream: { remote: "origin", name: "master" },
            ahead: 0,
            behind: 23,
            detached: false,
          },
          remotes: [{ name: "origin", isReadOnly: false }],
          groups: emptyChangeGroups(),
        },
        {
          rootPath: "/ws/app/mod",
          head: {
            name: "feature/t1-deployment",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            upstream: { remote: "origin", name: "feature/t1-deployment" },
            ahead: 1,
            behind: 0,
            detached: false,
          },
          remotes: [{ name: "origin", isReadOnly: false }],
          groups: emptyChangeGroups(),
        },
      ],
    );
    expect(root?.description).toBe("master");
    expect(root?.syncLabel).toBe("23↓ 0↑");
    expect(root?.syncTooltip).toBe("Pull 23 commits from origin/master");
    const sub = byLabel(root?.children, "mod");
    expect(sub?.description).toBe("feature/t1-deployment");
    expect(sub?.syncLabel).toBe("0↓ 1↑");
    expect(sub?.syncTooltip).toBe("Push 1 commits to origin/feature/t1-deployment");
  });
});

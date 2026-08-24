import { describe, expect, it } from "vitest";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import {
  ResourceStatus,
  type RepositoryChangeGroups,
  type RepositoryStateSnapshot,
  type ResourceChange,
} from "../../../src/git/repositoryState.js";
import type { RepoPins, RepoWorkingState, SubmoduleNode, WorkspaceRootNode } from "../../../src/git/types.js";
import { BUILTIN_COMMAND_TITLES, BUILTIN_GROUP_LABELS } from "../../../src/views/builtinGitParity.js";
import {
  DEFAULT_CHANGES_TREE_SETTINGS,
  emptyChangeGroups,
  type ChangesTreeSettings,
} from "../../../src/views/changesTreeSettings.js";
import { COMMANDS, CONTEXT } from "../../../src/views/constants.js";
import {
  buildAdoptedTree,
  treeCollapsibleMode,
  treeItemCommand,
  treeItemFileKindIcon,
  usesThemeFileIcon,
  type AdoptedTreeNode,
} from "../../../src/views/adoptedViewModel.js";

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

function workspaceRoot(rootPath: string, children: SubmoduleNode[], displayName?: string): WorkspaceRootNode {
  return {
    id: rootPath,
    kind: "workspace-root",
    rootPath,
    workspaceFolderPath: rootPath,
    displayName: displayName ?? (rootPath.split("/").pop() ?? rootPath),
    children,
  };
}

function resource(rootPath: string, relativePath: string, status: number, renamePath?: string): ResourceChange {
  const uri = `${rootPath}/${relativePath}`;
  return {
    uri: renamePath ? `${rootPath}/${renamePath}` : uri,
    originalUri: uri,
    renameUri: renamePath ? `${rootPath}/${renamePath}` : undefined,
    status: status as ResourceChange["status"],
    relativePath: renamePath ?? relativePath,
  };
}

function snapshot(
  rootPath: string,
  groups: Partial<RepositoryChangeGroups>,
  head?: RepositoryStateSnapshot["head"],
): RepositoryStateSnapshot {
  return {
    rootPath,
    head: head ?? { name: "main", detached: false, ahead: 0, behind: 0 },
    remotes: [],
    groups: { ...emptyChangeGroups(), ...groups },
  };
}

function byKind(nodes: readonly AdoptedTreeNode[] | undefined, kind: AdoptedTreeNode["kind"]): AdoptedTreeNode[] {
  return (nodes ?? []).filter((node) => node.kind === kind);
}

function byLabel(nodes: readonly AdoptedTreeNode[] | undefined, label: string): AdoptedTreeNode | undefined {
  return nodes?.find((node) => node.label === label);
}

function groupLabels(nodes: readonly AdoptedTreeNode[] | undefined): string[] {
  return (nodes ?? []).map((node) => node.label);
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

describe("buildAdoptedTree change groups", () => {
  const httplib = submodule({
    rootPath: "/ws/http/httplib",
    parentRootPath: "/ws/http",
    relativePath: "submodules/uu_energygateway_httpendpointg01",
    pins: { headGitlinkSha: HEAD, indexGitlinkSha: INDEX, checkoutHeadSha: INDEX },
  });
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
  const model = { roots: [workspaceRoot("/ws/http", [httplib, common], "httpendpoint")] };

  it("composes Merge, Staged, Changes, then child repos with built-in labels", () => {
    const gitlink = resource("/ws/http", "submodules/uu_energygateway_httpendpointg01", ResourceStatus.INDEX_MODIFIED);
    const dirty = resource("/ws/http", "src/app.ts", ResourceStatus.MODIFIED);
    const untracked = resource("/ws/http", "tmp.log", ResourceStatus.UNTRACKED);
    const conflict = resource("/ws/http", "conflict.ts", ResourceStatus.BOTH_MODIFIED);
    const tree = buildAdoptedTree(model, [
      snapshot("/ws/http", {
        merge: [conflict],
        index: [gitlink],
        workingTree: [dirty, gitlink],
        untracked: [untracked],
      }),
    ]);

    const http = tree[0];
    expect(http?.label).toBe("httpendpoint");
    expect(http?.description).toContain("main");
    expect(http?.decoration).toEqual({
      tooltip: "Submodule changes",
      themeColorId: "gitDecoration.submoduleResourceForeground",
    });
    expect(groupLabels(http?.children)).toEqual([
      BUILTIN_GROUP_LABELS.merge,
      BUILTIN_GROUP_LABELS.index,
      BUILTIN_GROUP_LABELS.workingTree,
      "uu_energygateway_httpendpointg01",
      "usy_idsmari_commong01",
    ]);
    expect(http?.children.map((child) => child.kind)).toEqual([
      "change-group",
      "change-group",
      "change-group",
      "submodule",
      "submodule",
    ]);

    const merge = http?.children[0];
    const staged = http?.children[1];
    const changes = http?.children[2];
    expect(merge?.description).toBe("1");
    expect(merge?.contextValue).toBe(CONTEXT.changeGroupMerge);
    expect(staged?.label).toBe(BUILTIN_GROUP_LABELS.index);
    expect(staged?.description).toBe("1");
    expect(staged?.contextValue).toBe(CONTEXT.changeGroupIndex);
    expect(changes?.label).toBe(BUILTIN_GROUP_LABELS.workingTree);
    expect(changes?.description).toBe("4");
    expect(changes?.contextValue).toBe(CONTEXT.changeGroupWorkingTree);

    expect(staged?.children.map((child) => child.label)).toEqual(["submodules"]);
    expect(changes?.children.map((child) => child.label)).toEqual(["src", "submodules", "tmp.log"]);

    const gitlinkChange = findByRelativePath(staged?.children, "submodules/uu_energygateway_httpendpointg01");
    expect(gitlinkChange?.kind).toBe("change");
    expect(gitlinkChange?.label).toBe("uu_energygateway_httpendpointg01");
    expect(gitlinkChange?.contextValue).toBe(`${CONTEXT.changeIndex}.${CONTEXT.gitlink}`);
    expect(gitlinkChange?.decoration?.badge).toBe("S");
    expect(gitlinkChange?.decoration?.tooltip).toBe("Submodule");
    expect(gitlinkChange?.description).toBe(`${HEAD.slice(0, 7)} → main`);
    expect(gitlinkChange?.diffSpec).toBeUndefined();
    expect(gitlinkChange?.children.map((child) => child.kind)).toEqual(["adopted-group"]);
    expect(gitlinkChange?.children[0]?.label).toBe("Adopted Changes");
    expect(gitlinkChange?.children[0]?.description).toBe("0");
    expect(gitlinkChange?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/httplib",
      fromSha: HEAD,
      toSha: INDEX,
      kind: "staged",
    });
    expect(usesThemeFileIcon(gitlinkChange!)).toBe(true);
    expect(treeItemFileKindIcon(gitlinkChange!)).toBe("file");
    expect(treeItemCommand(gitlinkChange!)?.title).toBe(BUILTIN_COMMAND_TITLES.openChange);
    expect(treeItemCommand(gitlinkChange!)?.command).toBe(COMMANDS.openChange);

    const workingGitlink = findByRelativePath(changes?.children, "submodules/uu_energygateway_httpendpointg01");
    expect(workingGitlink?.decoration?.badge).toBe("S");
    expect(workingGitlink?.collapsible).toBe(true);
    expect(workingGitlink?.description).toBeUndefined();
    expect(workingGitlink?.children[0]).toMatchObject({
      kind: "adopted-group",
      label: "Adopted Changes",
      description: "0",
    });
    expect(workingGitlink?.children[0]?.diffSpec).toBeUndefined();

    const commonGitlink = findByRelativePath(changes?.children, "submodules/usy_idsmari_commong01");
    expect(commonGitlink?.decoration?.badge).toBe("S");
    expect(commonGitlink?.description).toBe(`${HEAD.slice(0, 7)} → development/AFLEX`);
    expect(commonGitlink?.children[0]?.diffSpec?.kind).toBe("unstaged");
    expect(commonGitlink?.children[0]?.description).toBe("0");
    expect(byKind(http?.children, "adopted-group")).toEqual([]);
  });

  it("omits empty Adopted Changes and empty working-tree groups", () => {
    const child = submodule({
      rootPath: "/ws/app/mod",
      parentRootPath: "/ws/app",
      relativePath: "mod",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: HEAD },
    });
    const [root] = buildAdoptedTree({ roots: [workspaceRoot("/ws/app", [child])] });
    expect(byKind(root?.children, "adopted-group")).toEqual([]);
    expect(root?.children.map((node) => node.kind)).toEqual(["submodule"]);
    expect(root?.decoration).toBeUndefined();
  });

  it("colors a parent repo when a child checkout has local changes and the parent gitlinks are clean", () => {
    const child = submodule({
      rootPath: "/ws/app/mod",
      parentRootPath: "/ws/app",
      relativePath: "mod",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: HEAD, checkoutHeadSha: HEAD },
    });
    const [root] = buildAdoptedTree(
      { roots: [workspaceRoot("/ws/app", [child])] },
      [
        snapshot("/ws/app", {}),
        snapshot("/ws/app/mod", {
          index: [resource("/ws/app/mod", "notes.txt", ResourceStatus.INDEX_ADDED)],
        }),
      ],
    );
    expect(root?.decoration?.themeColorId).toBe("gitDecoration.submoduleResourceForeground");
    expect(root?.decoration?.badge).toBeUndefined();
    expect(byLabel(root?.children, "mod")?.decoration?.themeColorId).toBeUndefined();
  });

  it("shows Untracked Changes separately and empty Staged when settings require it", () => {
    const settings: ChangesTreeSettings = {
      ...DEFAULT_CHANGES_TREE_SETTINGS,
      untrackedChanges: "separate",
      alwaysShowStagedChangesResourceGroup: true,
    };
    const [root] = buildAdoptedTree(
      { roots: [workspaceRoot("/ws/app", [])] },
      [
        snapshot("/ws/app", {
          workingTree: [resource("/ws/app", "dirty.ts", ResourceStatus.MODIFIED)],
          untracked: [resource("/ws/app", "new.ts", ResourceStatus.UNTRACKED)],
        }),
      ],
      settings,
    );
    expect(groupLabels(root?.children)).toEqual([
      BUILTIN_GROUP_LABELS.index,
      BUILTIN_GROUP_LABELS.workingTree,
      BUILTIN_GROUP_LABELS.untracked,
    ]);
    expect(root?.children[0]?.children).toEqual([]);
    expect(root?.children[1]?.children.map((child) => child.label)).toEqual(["dirty.ts"]);
    expect(root?.children[2]?.label).toBe(BUILTIN_GROUP_LABELS.untracked);
    expect(root?.children[2]?.contextValue).toBe(CONTEXT.changeGroupUntracked);
    expect(root?.children[2]?.children[0]?.contextValue).toBe(CONTEXT.changeUntracked);
    expect(root?.children[2]?.children[0]?.decoration?.badge).toBe("U");
  });

  it("hides untracked files when git.untrackedChanges is hidden", () => {
    const [root] = buildAdoptedTree(
      { roots: [workspaceRoot("/ws/app", [])] },
      [
        snapshot("/ws/app", {
          workingTree: [resource("/ws/app", "dirty.ts", ResourceStatus.MODIFIED)],
          untracked: [resource("/ws/app", "new.ts", ResourceStatus.UNTRACKED)],
        }),
      ],
      { ...DEFAULT_CHANGES_TREE_SETTINGS, untrackedChanges: "hidden" },
    );
    expect(groupLabels(root?.children)).toEqual([BUILTIN_GROUP_LABELS.workingTree]);
    expect(root?.children[0]?.children.map((child) => child.label)).toEqual(["dirty.ts"]);
    expect(root?.decoration).toBeUndefined();
  });

  it("nests pointer diffs under the matching gitlink row, not on the child checkout", () => {
    const tree = buildAdoptedTree(model, []);
    const http = tree[0];
    expect(byKind(http?.children, "adopted-group")).toEqual([]);
    expect(http?.children.map((child) => child.kind)).toEqual([
      "change-group",
      "change-group",
      "submodule",
      "submodule",
    ]);

    const staged = byLabel(http?.children, BUILTIN_GROUP_LABELS.index);
    const changes = byLabel(http?.children, BUILTIN_GROUP_LABELS.workingTree);
    const libGitlink = findByRelativePath(staged?.children, "submodules/uu_energygateway_httpendpointg01");
    expect(libGitlink?.description).toBe(`${HEAD.slice(0, 7)} → main`);
    expect(libGitlink?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/httplib",
      fromSha: HEAD,
      toSha: INDEX,
      kind: "staged",
    });
    expect(findByRelativePath(changes?.children, "submodules/usy_idsmari_commong01")?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/common",
      fromSha: HEAD,
      toSha: INDEX,
      kind: "unstaged",
    });

    const libNode = byLabel(http?.children, "uu_energygateway_httpendpointg01");
    expect(libNode?.kind).toBe("submodule");
    expect(byKind(libNode?.children, "adopted-group")).toEqual([]);
    expect(libNode?.children).toEqual([]);

    const commonNode = byLabel(http?.children, "usy_idsmari_commong01");
    const nestedGitlink = findByRelativePath(
      byLabel(commonNode?.children, BUILTIN_GROUP_LABELS.workingTree)?.children,
      "submodules/uu_energygateway_datagatewayg01",
    );
    expect(nestedGitlink?.decoration?.badge).toBe("S");
    expect(nestedGitlink?.description).toBe(`${NESTED_HEAD.slice(0, 7)} → ${CHECKOUT.slice(0, 7)}`);
    expect(nestedGitlink?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/common/data",
      fromSha: NESTED_HEAD,
      toSha: CHECKOUT,
      kind: "unstaged",
    });

    const nestedNode = byLabel(commonNode?.children, "uu_energygateway_datagatewayg01");
    expect(byKind(nestedNode?.children, "adopted-group")).toEqual([]);
  });

  it("nests compact folders in tree view mode", () => {
    const settings: ChangesTreeSettings = { ...DEFAULT_CHANGES_TREE_SETTINGS, viewMode: "tree", compactFolders: true };
    const [root] = buildAdoptedTree(
      { roots: [workspaceRoot("/ws/app", [])] },
      [
        snapshot("/ws/app", {
          workingTree: [
            resource("/ws/app", "src/util/a.ts", ResourceStatus.MODIFIED),
            resource("/ws/app", "src/util/b.ts", ResourceStatus.MODIFIED),
            resource("/ws/app", "readme.md", ResourceStatus.MODIFIED),
          ],
        }),
      ],
      settings,
    );
    const changes = root?.children[0];
    expect(changes?.children.map((child) => child.label)).toEqual(["readme.md", "src/util"]);
    const folder = byKind(changes?.children, "folder")[0];
    expect(folder?.contextValue).toBe(CONTEXT.resourceFolderWorkingTree);
    expect(folder?.children.map((child) => child.label)).toEqual(["a.ts", "b.ts"]);
    expect(treeCollapsibleMode(folder!)).toBe("expanded");
  });

  it("maps rename, delete, add, and conflict decorations without description letters", () => {
    const [root] = buildAdoptedTree(
      { roots: [workspaceRoot("/ws/app", [])] },
      [
        snapshot("/ws/app", {
          index: [resource("/ws/app", "old.ts", ResourceStatus.INDEX_RENAMED, "new.ts")],
          workingTree: [
            resource("/ws/app", "gone.ts", ResourceStatus.DELETED),
            resource("/ws/app", "fresh.ts", ResourceStatus.INTENT_TO_ADD),
          ],
          merge: [resource("/ws/app", "both.ts", ResourceStatus.BOTH_MODIFIED)],
        }),
      ],
    );
    const mergeFile = byLabel(root?.children, BUILTIN_GROUP_LABELS.merge)?.children[0];
    const stagedFile = byLabel(root?.children, BUILTIN_GROUP_LABELS.index)?.children[0];
    const changes = byLabel(root?.children, BUILTIN_GROUP_LABELS.workingTree);
    expect(mergeFile?.decoration).toMatchObject({ badge: "!", tooltip: "Conflict: Both Modified" });
    expect(mergeFile?.description).toBeUndefined();
    expect(stagedFile?.label).toBe("new.ts");
    expect(stagedFile?.decoration?.badge).toBe("R");
    expect(byLabel(changes?.children, "gone.ts")?.decoration?.badge).toBe("D");
    expect(byLabel(changes?.children, "fresh.ts")?.decoration?.badge).toBe("A");
  });

  it("marks a dirty checkout with + on the gitlink pointer and the child repo row", () => {
    const child = submodule({
      rootPath: "/ws/app/mod",
      parentRootPath: "/ws/app",
      relativePath: "mod",
      pins: { headGitlinkSha: HEAD, indexGitlinkSha: INDEX, checkoutHeadSha: INDEX },
      workingState: { detached: true },
    });
    const [root] = buildAdoptedTree(
      { roots: [workspaceRoot("/ws/app", [child])] },
      [
        snapshot("/ws/app", { index: [resource("/ws/app", "mod", ResourceStatus.INDEX_MODIFIED)] }),
        snapshot("/ws/app/mod", { index: [resource("/ws/app/mod", "notes.txt", ResourceStatus.INDEX_ADDED)] }, {
          commit: INDEX,
          detached: true,
        }),
      ],
    );
    const gitlink = findByRelativePath(byLabel(root?.children, BUILTIN_GROUP_LABELS.index)?.children, "mod");
    expect(gitlink?.description).toBe(`${HEAD.slice(0, 7)} → ${INDEX.slice(0, 7)}+`);
    expect(byLabel(root?.children, "mod")?.description).toBe(`${INDEX.slice(0, 8)}+`);
  });
});

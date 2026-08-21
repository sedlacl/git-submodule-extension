import path from "node:path";
import { describe, expect, it } from "vitest";
import { overlayHierarchicalRepositoryState } from "../../../src/git/hierarchicalRepositoryState.js";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import { ResourceStatus, type RepositoryStateSnapshot } from "../../../src/git/repositoryState.js";
import type { RepoPins, SubmoduleNode, WorkspaceGitModel, WorkspaceRootNode } from "../../../src/git/types.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function submodule(rootPath: string, parentRootPath: string, relativePath: string, children: SubmoduleNode[] = []): SubmoduleNode {
  const pins: RepoPins = { headGitlinkSha: HEAD, indexGitlinkSha: INDEX, checkoutHeadSha: INDEX };
  return {
    id: rootPath,
    kind: "submodule",
    rootPath,
    displayName: relativePath.split("/").pop() ?? relativePath,
    children,
    parentRootPath,
    relativePath,
    name: relativePath,
    url: null,
    pins,
    branch: {
      name: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      detached: false,
      configuredBranch: "main",
      committedConfiguredBranch: "main",
    },
    workingState: {
      uninitialized: false,
      dirty: false,
      detached: false,
      diverged: false,
      pointerMismatch: false,
      operationInProgress: false,
      probeFailed: false,
    },
    adoptedChanges: computeAdoptedPointers(pins),
  };
}

function model(rootPath: string, children: SubmoduleNode[]): WorkspaceGitModel {
  const root: WorkspaceRootNode = {
    id: rootPath,
    kind: "workspace-root",
    rootPath,
    workspaceFolderPath: rootPath,
    displayName: path.basename(rootPath),
    children,
  };
  const nodesByRootPath = new Map();
  const index = (node: WorkspaceRootNode | SubmoduleNode): void => {
    nodesByRootPath.set(node.rootPath, node);
    for (const child of node.children) {
      index(child);
    }
  };
  index(root);
  return { roots: [root], nodesByRootPath };
}

function snapshot(rootPath: string, files: { group: "merge" | "index" | "workingTree" | "untracked"; name: string }[]): RepositoryStateSnapshot {
  const empty = { merge: [], index: [], workingTree: [], untracked: [] } as RepositoryStateSnapshot["groups"];
  const groups = { ...empty, merge: [...empty.merge], index: [...empty.index], workingTree: [...empty.workingTree], untracked: [...empty.untracked] };
  for (const file of files) {
    groups[file.group] = [
      ...groups[file.group],
      {
        uri: path.join(rootPath, file.name),
        originalUri: path.join(rootPath, file.name),
        status: ResourceStatus.MODIFIED,
        relativePath: file.name,
      },
    ];
  }
  return {
    rootPath,
    head: { name: "main", detached: false, ahead: 0, behind: 0 },
    remotes: [],
    groups,
  };
}

describe("overlayHierarchicalRepositoryState", () => {
  const http = path.join("/ws", "httpendpoint");
  const common = path.join(http, "submodules", "usy_idsmari_commong01");
  const data = path.join(common, "submodules", "uu_energygateway_datagatewayg01");

  it("attaches vscode.git groups to each hierarchical repo node and keeps gitlink parenthood", () => {
    const graph = model(http, [submodule(common, http, "submodules/usy_idsmari_commong01", [
      submodule(data, common, "submodules/uu_energygateway_datagatewayg01"),
    ])]);
    const views = overlayHierarchicalRepositoryState(graph, [
      snapshot(http, [{ group: "index", name: "parent.ts" }]),
      snapshot(common, [{ group: "workingTree", name: "child.ts" }]),
      snapshot(data, [
        { group: "merge", name: "conflict.ts" },
        { group: "untracked", name: "new.ts" },
      ]),
    ]);

    expect(views).toHaveLength(1);
    expect(views[0].displayName).toBe("httpendpoint");
    expect(views[0].handlePresent).toBe(true);
    expect(views[0].groups.map((group) => group.kind)).toEqual(["index"]);
    expect(views[0].children).toHaveLength(1);
    expect(views[0].children[0].rootPath).toBe(common);
    expect(views[0].children[0].groups.map((group) => group.kind)).toEqual(["workingTree"]);
    expect(views[0].children[0].children[0].rootPath).toBe(data);
    expect(views[0].children[0].children[0].groups.map((group) => group.kind)).toEqual(["merge", "untracked"]);
    expect(views[0].children[0].children[0].head?.name).toBe("main");
  });

  it("keeps a node without an open vscode.git handle and omits empty groups", () => {
    const nested = submodule(common, http, "submodules/usy_idsmari_commong01");
    const views = overlayHierarchicalRepositoryState(model(http, [nested]), [
      snapshot(http, []),
    ]);

    expect(views[0].handlePresent).toBe(true);
    expect(views[0].groups).toEqual([]);
    expect(views[0].children[0].handlePresent).toBe(false);
    expect(views[0].children[0].groups).toEqual([]);
    expect(views[0].children[0].head).toBeUndefined();
  });
});

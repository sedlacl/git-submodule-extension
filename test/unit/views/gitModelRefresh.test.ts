import { describe, expect, it } from "vitest";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import { ResourceStatus, type RepositoryStateSnapshot } from "../../../src/git/repositoryState.js";
import type { GitRepoNode, SubmoduleNode, WorkspaceGitModel, WorkspaceRootNode } from "../../../src/git/types.js";
import { emptyChangeGroups } from "../../../src/views/changesTreeSettings.js";
import { gitModelNeedsRediscovery } from "../../../src/views/gitModelRefresh.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function snapshot(
  rootPath: string,
  groups: Partial<RepositoryStateSnapshot["groups"]> = {},
  commit = "c1",
): RepositoryStateSnapshot {
  return {
    rootPath,
    head: { name: "main", commit, detached: false },
    remotes: [],
    groups: { ...emptyChangeGroups(), ...groups },
  };
}

function change(rootPath: string, relativePath: string, status: number) {
  return {
    uri: `${rootPath}/${relativePath}`,
    originalUri: `${rootPath}/${relativePath}`,
    status: status as RepositoryStateSnapshot["groups"]["index"][number]["status"],
    relativePath,
  };
}

function modelWithChild(parentRoot = "/ws/http", childRel = "lib"): WorkspaceGitModel {
  const childRoot = `${parentRoot}/${childRel}`;
  const child: SubmoduleNode = {
    id: childRoot,
    kind: "submodule",
    rootPath: childRoot,
    displayName: childRel,
    children: [],
    parentRootPath: parentRoot,
    relativePath: childRel,
    name: childRel,
    url: null,
    pins: { headGitlinkSha: HEAD, indexGitlinkSha: INDEX, checkoutHeadSha: INDEX },
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
    adoptedChanges: computeAdoptedPointers({
      headGitlinkSha: HEAD,
      indexGitlinkSha: INDEX,
      checkoutHeadSha: INDEX,
    }),
  };
  const root: WorkspaceRootNode = {
    id: parentRoot,
    kind: "workspace-root",
    rootPath: parentRoot,
    workspaceFolderPath: parentRoot,
    displayName: "http",
    children: [child],
  };
  return {
    roots: [root],
    nodesByRootPath: new Map<string, GitRepoNode>([
      [root.rootPath, root],
      [child.rootPath, child],
    ]),
  };
}

describe("gitModelNeedsRediscovery", () => {
  it("requires discovery when the cached graph or previous state is missing", () => {
    const next = snapshot("/ws/app", { workingTree: [change("/ws/app", "app.js", ResourceStatus.MODIFIED)] });
    expect(gitModelNeedsRediscovery(undefined, undefined, next)).toBe(true);
    expect(gitModelNeedsRediscovery(modelWithChild(), undefined, next)).toBe(true);
  });

  it("does not rediscover ordinary file stage/unstage on a repo without gitlink children", () => {
    const root: WorkspaceRootNode = {
      id: "/ws/app",
      kind: "workspace-root",
      rootPath: "/ws/app",
      workspaceFolderPath: "/ws/app",
      displayName: "app",
      children: [],
    };
    const model: WorkspaceGitModel = {
      roots: [root],
      nodesByRootPath: new Map<string, GitRepoNode>([[root.rootPath, root]]),
    };
    const dirty = snapshot("/ws/app", { workingTree: [change("/ws/app", "app.js", ResourceStatus.MODIFIED)] });
    const staged = snapshot("/ws/app", { index: [change("/ws/app", "app.js", ResourceStatus.INDEX_MODIFIED)] });
    expect(gitModelNeedsRediscovery(model, dirty, staged)).toBe(false);
    expect(gitModelNeedsRediscovery(model, staged, dirty)).toBe(false);
  });

  it("does not rediscover file-only mutations while gitlink groups stay unchanged", () => {
    const model = modelWithChild();
    const previous = snapshot("/ws/http", {
      workingTree: [change("/ws/http", "app.js", ResourceStatus.MODIFIED)],
      index: [change("/ws/http", "lib", ResourceStatus.INDEX_MODIFIED)],
    });
    const next = snapshot("/ws/http", {
      index: [
        change("/ws/http", "app.js", ResourceStatus.INDEX_MODIFIED),
        change("/ws/http", "lib", ResourceStatus.INDEX_MODIFIED),
      ],
    });
    expect(gitModelNeedsRediscovery(model, previous, next)).toBe(false);
  });

  it("treats a newly hydrated known repository HEAD as part of the cached discovery", () => {
    const model = modelWithChild();
    const previous = { ...snapshot("/ws/http/lib"), head: undefined };
    const next = snapshot("/ws/http/lib", {}, INDEX);

    expect(gitModelNeedsRediscovery(model, previous, next)).toBe(false);
  });

  it("rediscovers when a gitlink moves between groups or HEAD commit changes", () => {
    const model = modelWithChild();
    const unstaged = snapshot("/ws/http", {
      workingTree: [change("/ws/http", "lib", ResourceStatus.MODIFIED)],
    });
    const staged = snapshot("/ws/http", {
      index: [change("/ws/http", "lib", ResourceStatus.INDEX_MODIFIED)],
    });
    expect(gitModelNeedsRediscovery(model, unstaged, staged)).toBe(true);
    const sameFiles = snapshot("/ws/http", { workingTree: [change("/ws/http", "app.js", ResourceStatus.MODIFIED)] }, "c2");
    const previous = snapshot("/ws/http", { workingTree: [change("/ws/http", "app.js", ResourceStatus.MODIFIED)] }, "c1");
    expect(gitModelNeedsRediscovery(model, previous, sameFiles)).toBe(true);
  });
});

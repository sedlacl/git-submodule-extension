import { describe, expect, it } from "vitest";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import type { AdoptedDiffReader, AdoptedDiffSpec, GitModelProvider } from "../../../src/git/interfaces.js";
import { ResourceStatus, type RepositoryStateSnapshot } from "../../../src/git/repositoryState.js";
import type { GitRepoNode, NameStatusEntry, RepoPins, SubmoduleNode, WorkspaceGitModel, WorkspaceRootNode } from "../../../src/git/types.js";
import { AdoptedTreeController } from "../../../src/views/adoptedTreeController.js";
import { treeItemCommand } from "../../../src/views/adoptedViewModel.js";
import { emptyChangeGroups } from "../../../src/views/changesTreeSettings.js";
import { COMMANDS } from "../../../src/views/constants.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHECKOUT = "cccccccccccccccccccccccccccccccccccccccc";

function submodule(rootPath: string, parentRootPath: string, relativePath: string, pins: RepoPins): SubmoduleNode {
  return {
    id: rootPath,
    kind: "submodule",
    rootPath,
    displayName: relativePath.split("/").pop() ?? relativePath,
    children: [],
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

function modelWith(child: SubmoduleNode): WorkspaceGitModel {
  const root: WorkspaceRootNode = {
    id: "/ws/http",
    kind: "workspace-root",
    rootPath: "/ws/http",
    workspaceFolderPath: "/ws/http",
    displayName: "http",
    children: [child],
  };
  return { roots: [root], nodesByRootPath: new Map<string, GitRepoNode>([[root.rootPath, root], [child.rootPath, child]]) };
}

class FakeModel implements GitModelProvider, AdoptedDiffReader {
  snapshotCount = 0;
  nameStatusCalls: AdoptedDiffSpec[] = [];
  snapshotImpl: () => Promise<WorkspaceGitModel>;
  nameStatusImpl: (spec: AdoptedDiffSpec) => Promise<readonly NameStatusEntry[]>;

  constructor(snapshot: WorkspaceGitModel, files: readonly NameStatusEntry[] = []) {
    this.snapshotImpl = async () => snapshot;
    this.nameStatusImpl = async () => files;
  }

  async snapshot(): Promise<WorkspaceGitModel> {
    this.snapshotCount += 1;
    return this.snapshotImpl();
  }

  async listNameStatus(spec: AdoptedDiffSpec): Promise<readonly NameStatusEntry[]> {
    this.nameStatusCalls.push(spec);
    return this.nameStatusImpl(spec);
  }
}

describe("AdoptedTreeController", () => {
  const child = submodule("/ws/http/lib", "/ws/http", "lib", {
    headGitlinkSha: HEAD,
    indexGitlinkSha: INDEX,
    checkoutHeadSha: CHECKOUT,
  });

  it("loads staged and unstaged name-status lazily and prepares Open All from the group", async () => {
    const fake = new FakeModel(modelWith(child), []);
    fake.nameStatusImpl = async (spec) => {
      if (spec.kind === "staged") {
        return [{ status: "modified", path: "src/index.ts" }];
      }
      return [
        { status: "added", path: "src/new.ts" },
        { status: "deleted", path: "legacy.ts" },
      ];
    };
    const controller = new AdoptedTreeController(fake);

    const roots = await controller.getChildren();
    expect(fake.nameStatusCalls).toEqual([]);
    const stagedGroup = roots[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index");
    const changesGroup = roots[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "workingTree");
    const stagedGitlink = stagedGroup?.children[0];
    const unstagedGitlink = changesGroup?.children[0];
    const lib = roots[0]?.children.find((node) => node.kind === "submodule");
    expect(stagedGitlink?.label).toBe("lib");
    expect(stagedGitlink?.decoration?.badge).toBe("S");
    expect(stagedGitlink?.description).toBe(`${HEAD.slice(0, 7)} → ${INDEX.slice(0, 7)}`);
    expect(stagedGitlink?.children[0]?.kind).toBe("adopted-group");
    expect(stagedGitlink?.children[0]?.diffSpec?.kind).toBe("staged");
    expect(unstagedGitlink?.description).toBe(`${INDEX.slice(0, 7)} → main`);
    expect(unstagedGitlink?.children[0]?.diffSpec?.kind).toBe("unstaged");
    expect(lib?.children.map((node) => node.kind)).toEqual(["change-group"]);

    const stagedFiles = await controller.getChildren(stagedGitlink!.children[0]!);
    const unstagedFiles = await controller.getChildren(unstagedGitlink!.children[0]!);
    expect(fake.nameStatusCalls.map((call) => call.kind)).toEqual(["staged", "unstaged"]);
    expect(stagedFiles.map((node) => node.label)).toEqual(["src"]);
    expect(stagedFiles[0]?.children.map((node) => node.fileDiff?.path)).toEqual(["src/index.ts"]);
    expect(unstagedFiles.map((node) => node.label)).toEqual(["legacy.ts", "src"]);
    expect(unstagedFiles[1]?.children.map((node) => node.fileDiff?.path)).toEqual(["src/new.ts"]);
    expect(treeItemCommand(stagedFiles[0]!.children[0]!)?.command).toBe(COMMANDS.openChange);

    const openAll = await controller.filesForOpenAll(roots[0]!);
    expect(openAll.map((file) => file.path)).toEqual(["src/index.ts", "legacy.ts", "src/new.ts"]);
    expect(fake.nameStatusCalls).toHaveLength(2);

    const fromGitlink = await controller.filesForOpenAll(stagedGitlink!);
    expect(fromGitlink).toHaveLength(1);
    const fromParent = await controller.filesForOpenAll(roots[0]!);
    expect(fromParent).toHaveLength(3);
    const fromSubmodule = await controller.filesForOpenAll(lib!);
    expect(fromSubmodule).toHaveLength(0);
  });

  it("overlays staged file moves from repository state without a second git-model snapshot", async () => {
    const delayMs = 80;
    const fake = new FakeModel(modelWith(child));
    fake.snapshotImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return modelWith(child);
    };
    const file = {
      uri: "/ws/http/app.js",
      originalUri: "/ws/http/app.js",
      status: ResourceStatus.MODIFIED,
      relativePath: "app.js",
    };
    let snapshots: RepositoryStateSnapshot[] = [
      {
        rootPath: "/ws/http",
        head: { name: "main", commit: "c1", detached: false },
        remotes: [],
        groups: { ...emptyChangeGroups(), workingTree: [file] },
      },
    ];
    const controller = new AdoptedTreeController(
      fake,
      () => undefined,
      () => snapshots,
    );
    const first = await controller.getRootNodes();
    expect(fake.snapshotCount).toBe(1);
    expect(first[0]?.children.some((node) => node.kind === "change-group" && node.changeGroup === "workingTree" && node.children.some((childNode) => childNode.label === "app.js"))).toBe(true);

    snapshots = [
      {
        rootPath: "/ws/http",
        head: { name: "main", commit: "c1", detached: false },
        remotes: [],
        groups: {
          ...emptyChangeGroups(),
          index: [{ ...file, status: ResourceStatus.INDEX_MODIFIED }],
        },
      },
    ];
    const overlayStarted = Date.now();
    await controller.refresh();
    const second = await controller.getRootNodes();
    const overlayMs = Date.now() - overlayStarted;
    expect(fake.snapshotCount).toBe(1);
    expect(overlayMs).toBeLessThan(delayMs);
    const staged = second[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index");
    expect(staged?.children.map((node) => node.label)).toEqual(["app.js", "lib"]);
    expect(controller.consumeRepositoryState(snapshots[0]!)).toBe(false);
  });

  it("invalidates the cached git graph only when rediscovery is requested", async () => {
    const fake = new FakeModel(modelWith(child), [{ status: "modified", path: "once.ts" }]);
    const controller = new AdoptedTreeController(fake);
    const first = await controller.getRootNodes();
    const staged = first[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index")?.children[0];
    expect(staged?.kind).toBe("change");
    expect(staged?.children[0]?.diffSpec?.kind).toBe("staged");
    await controller.getChildren(staged!.children[0]);
    expect(fake.snapshotCount).toBe(1);
    expect(fake.nameStatusCalls).toHaveLength(1);

    fake.nameStatusImpl = async () => [{ status: "added", path: "after-refresh.ts" }];
    await controller.refresh();
    expect(fake.snapshotCount).toBe(1);

    controller.invalidateModel();
    await controller.refresh();
    const second = await controller.getRootNodes();
    const stagedAfter = second[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index")?.children[0];
    expect(stagedAfter?.children[0]?.diffSpec?.kind).toBe("staged");
    const files = await controller.getChildren(stagedAfter!.children[0]);
    expect(fake.snapshotCount).toBe(2);
    expect(files[0]?.fileDiff?.path).toBe("after-refresh.ts");
  });

  it("surfaces snapshot and name-status failures as message nodes", async () => {
    const fake = new FakeModel(modelWith(child));
    fake.snapshotImpl = async () => {
      throw new Error("git unavailable");
    };
    const controller = new AdoptedTreeController(fake);
    const roots = await controller.getRootNodes();
    expect(roots[0]?.kind).toBe("message");
    expect(roots[0]?.label).toBe("Failed to load changes");
    expect(roots[0]?.tooltip).toContain("git unavailable");

    const ok = new FakeModel(modelWith(child));
    ok.nameStatusImpl = async () => {
      throw new Error("diff failed");
    };
    const filesController = new AdoptedTreeController(ok);
    const tree = await filesController.getRootNodes();
    const staged = tree[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index")?.children[0];
    expect(staged?.children[0]?.diffSpec?.kind).toBe("staged");
    const files = await filesController.getChildren(staged!.children[0]);
    expect(files[0]?.kind).toBe("message");
    expect(files[0]?.label).toBe("Failed to list changes");
    expect(treeItemCommand(files[0]!)).toBeUndefined();
  });
});

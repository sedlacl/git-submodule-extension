import { describe, expect, it } from "vitest";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import type { AdoptedDiffReader, AdoptedDiffSpec, GitModelProvider } from "../../../src/git/interfaces.js";
import { ResourceStatus, type RepositoryStateSnapshot } from "../../../src/git/repositoryState.js";
import type { GitRepoNode, NameStatusEntry, RepoPins, SubmoduleNode, WorkspaceGitModel, WorkspaceRootNode } from "../../../src/git/types.js";
import { AdoptedTreeController } from "../../../src/views/adoptedTreeController.js";
import { treeItemCommand, type AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";
import { DEFAULT_CHANGES_TREE_SETTINGS, emptyChangeGroups, type ChangesTreeSettings } from "../../../src/views/changesTreeSettings.js";
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

  it("hydrates collapsed adopted counts in the background and reuses the cache for expansion and Open All", async () => {
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
    expect(stagedGitlink?.children[0]?.description).toBeUndefined();
    expect(unstagedGitlink?.description).toBe(`${INDEX.slice(0, 7)} → main`);
    expect(unstagedGitlink?.children[0]?.diffSpec?.kind).toBe("unstaged");
    expect(unstagedGitlink?.children[0]?.description).toBeUndefined();
    expect(lib?.children).toEqual([]);
    expect(fake.nameStatusCalls).toEqual([]);

    const patches: unknown[] = [];
    const timing = await controller.hydrateAdoptedCounts(roots, (patch) => patches.push(patch));
    expect(stagedGitlink?.children[0]?.description).toBe("1");
    expect(unstagedGitlink?.children[0]?.description).toBe("2");
    expect(patches).toEqual([
      { id: stagedGitlink?.children[0]?.id, state: "resolved", count: 1 },
      { id: unstagedGitlink?.children[0]?.id, state: "resolved", count: 2 },
    ]);
    expect(fake.nameStatusCalls).toHaveLength(2);
    expect(timing).toMatchObject({
      queuedCount: 2,
      cacheHits: 0,
      cacheMisses: 2,
      gitCalls: 2,
      concurrencyLimit: 4,
      cancelled: false,
    });
    expect(timing.peakConcurrency).toBeGreaterThan(0);

    const stagedFiles = await controller.getChildren(stagedGitlink!.children[0]!);
    const unstagedFiles = await controller.getChildren(unstagedGitlink!.children[0]!);
    expect(stagedGitlink?.children[0]?.description).toBe("1");
    expect(unstagedGitlink?.children[0]?.description).toBe("2");
    expect(fake.nameStatusCalls).toHaveLength(2);
    const cachedTiming = await controller.hydrateAdoptedCounts(roots, () => undefined);
    expect(cachedTiming).toMatchObject({
      queuedCount: 2,
      cacheHits: 2,
      cacheMisses: 0,
      gitCalls: 0,
      peakConcurrency: 0,
    });
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

  it("expands historical nested gitlinks under Adopted Changes using tree SHAs", async () => {
    const nestedFrom = "dddddddddddddddddddddddddddddddddddddddd";
    const nestedTo = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const liveCheckout = "ffffffffffffffffffffffffffffffffffffffff";
    const nested = submodule("/ws/http/lib/data", "/ws/http/lib", "submodules/uu_energygateway_datagatewayg01", {
      headGitlinkSha: nestedFrom,
      indexGitlinkSha: nestedFrom,
      checkoutHeadSha: liveCheckout,
    });
    nested.workingState = {
      ...nested.workingState,
      detached: true,
      pointerMismatch: true,
    };
    const parent = submodule("/ws/http/lib", "/ws/http", "lib", {
      headGitlinkSha: HEAD,
      indexGitlinkSha: INDEX,
      checkoutHeadSha: CHECKOUT,
    });
    parent.children = [nested];
    const root: WorkspaceRootNode = {
      id: "/ws/http",
      kind: "workspace-root",
      rootPath: "/ws/http",
      workspaceFolderPath: "/ws/http",
      displayName: "http",
      children: [parent],
    };
    const snapshot: WorkspaceGitModel = {
      roots: [root],
      nodesByRootPath: new Map<string, GitRepoNode>([
        [root.rootPath, root],
        [parent.rootPath, parent],
        [nested.rootPath, nested],
      ]),
    };
    const fake = new FakeModel(snapshot);
    fake.nameStatusImpl = async (spec) => {
      if (spec.repoRoot === "/ws/http/lib") {
        return [
          {
            status: "modified",
            path: "submodules/uu_energygateway_datagatewayg01",
            oldMode: "160000",
            newMode: "160000",
            oldSha: nestedFrom,
            newSha: nestedTo,
          },
        ];
      }
      if (spec.repoRoot === "/ws/http/lib/data") {
        expect(spec.fromSha).toBe(nestedFrom);
        expect(spec.toSha).toBe(nestedTo);
        expect(spec.fromSha).not.toBe(liveCheckout);
        expect(spec.toSha).not.toBe(liveCheckout);
        return [{ status: "added", path: "gateway.txt" }];
      }
      return [];
    };
    const controller = new AdoptedTreeController(fake);
    const roots = await controller.getRootNodes();
    const stagedAdopted = roots[0]?.children
      .find((node) => node.changeGroup === "index")
      ?.children[0]?.children[0];
    expect(stagedAdopted?.kind).toBe("adopted-group");

    const level1 = await controller.getChildren(stagedAdopted!);
    const pointer = findDescendant(level1, (node) => node.kind === "pointer");
    expect(pointer?.decoration?.badge).toBe("S");
    expect(pointer?.description).toBe(`${nestedFrom.slice(0, 7)} → ${nestedTo.slice(0, 7)}`);
    expect(pointer?.children[0]?.diffSpec).toEqual({
      repoRoot: "/ws/http/lib/data",
      fromSha: nestedFrom,
      toSha: nestedTo,
      kind: "staged",
    });

    const nestedFiles = await controller.getChildren(pointer!.children[0]!);
    expect(nestedFiles.map((node) => node.fileDiff?.path)).toEqual(["gateway.txt"]);
    expect(fake.nameStatusCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoRoot: "/ws/http/lib", fromSha: HEAD, toSha: INDEX }),
        expect.objectContaining({ repoRoot: "/ws/http/lib/data", fromSha: nestedFrom, toSha: nestedTo }),
      ]),
    );
  });

  it("coalesces duplicate lazy loads and hydrates independent adopted groups in parallel", async () => {
    const fake = new FakeModel(modelWith(child), [{ status: "modified", path: "src/index.ts" }]);
    let active = 0;
    let maxActive = 0;
    fake.nameStatusImpl = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [{ status: "modified", path: "src/index.ts" }];
    };
    const controller = new AdoptedTreeController(fake);
    const roots = await controller.getRootNodes();
    const staged = roots[0]?.children.find((node) => node.changeGroup === "index")?.children[0]?.children[0];

    await Promise.all([controller.getChildren(staged), controller.getChildren(staged)]);
    expect(fake.nameStatusCalls).toHaveLength(1);

    controller.invalidateModel();
    await controller.refresh();
    const refreshed = await controller.getRootNodes();
    const files = await controller.filesForOpenAll(refreshed[0]!);
    expect(files).toHaveLength(2);
    expect(maxActive).toBe(2);
  });

  it("re-nests adopted files when the SCM view mode changes without a second diff", async () => {
    const fake = new FakeModel(modelWith(child), [{ status: "modified", path: "src/index.ts" }]);
    let settings: ChangesTreeSettings = { ...DEFAULT_CHANGES_TREE_SETTINGS, viewMode: "list" };
    const controller = new AdoptedTreeController(
      fake,
      () => undefined,
      () => [],
      () => settings,
    );

    const first = await controller.getRootNodes();
    const stagedList = first[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index")?.children[0];
    expect(stagedList?.children[0]?.description).toBeUndefined();
    expect((await controller.getChildren(stagedList!.children[0]!)).map((node) => node.label)).toEqual(["src/index.ts"]);
    expect(stagedList?.children[0]?.description).toBe("1");
    expect(fake.nameStatusCalls).toHaveLength(1);

    settings = { ...settings, viewMode: "tree" };
    await controller.refresh();
    const second = await controller.getRootNodes();
    const stagedTree = second[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index")?.children[0];
    const nested = await controller.getChildren(stagedTree!.children[0]!);
    expect(nested.map((node) => node.label)).toEqual(["src"]);
    expect(nested[0]?.children.map((node) => node.label)).toEqual(["index.ts"]);
    expect(fake.nameStatusCalls).toHaveLength(1);
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
    expect(controller.repositoryStateNeedsRediscovery()).toBe(false);
  });

  it("invalidates the cached git graph only when rediscovery is requested", async () => {
    const fake = new FakeModel(modelWith(child), [{ status: "modified", path: "once.ts" }]);
    const controller = new AdoptedTreeController(fake);
    const first = await controller.getRootNodes();
    const staged = first[0]?.children.find((node) => node.kind === "change-group" && node.changeGroup === "index")?.children[0];
    expect(staged?.kind).toBe("change");
    expect(staged?.children[0]?.diffSpec?.kind).toBe("staged");
    expect(staged?.children[0]?.description).toBeUndefined();
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
    expect(fake.nameStatusCalls).toHaveLength(2);
  });

  it("surfaces snapshot failures at root and adopted diff failures inside the lazy group", async () => {
    const fake = new FakeModel(modelWith(child));
    fake.snapshotImpl = async () => {
      throw new Error("git unavailable");
    };
    const controller = new AdoptedTreeController(fake);
    const roots = await controller.getRootNodes();
    expect(roots[0]?.kind).toBe("message");
    expect(roots[0]?.label).toBe("Failed to load changes");
    expect(roots[0]?.tooltip).toContain("git unavailable");
    expect(controller.rootLoadError()).toContain("git unavailable");

    fake.snapshotImpl = async () => modelWith(child);
    controller.invalidateModel();
    await controller.refresh();
    expect(controller.rootLoadError()).toBeUndefined();

    const ok = new FakeModel(modelWith(child));
    ok.nameStatusImpl = async () => {
      throw new Error("diff failed");
    };
    const filesController = new AdoptedTreeController(ok);
    const tree = await filesController.getRootNodes();
    expect(tree[0]?.kind).toBe("workspace-root");
    expect(filesController.rootLoadError()).toBeUndefined();
    const adopted = tree[0]?.children.find((node) => node.changeGroup === "index")?.children[0]?.children[0];
    const patches: unknown[] = [];
    await filesController.hydrateAdoptedCounts(tree, (patch) => patches.push(patch));
    expect(patches).toHaveLength(2);
    expect(patches).toContainEqual({
      id: adopted?.id,
      state: "error",
      message: "diff failed",
    });
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "error", message: "diff failed" }),
        expect.objectContaining({ state: "error", message: "diff failed" }),
      ]),
    );
    expect(adopted?.description).toBeUndefined();
    expect(adopted?.adoptedCountError).toBe("diff failed");

    const failure = await filesController.getChildren(adopted);
    expect(failure[0]?.kind).toBe("message");
    expect(failure[0]?.tooltip).toContain("diff failed");
    expect(treeItemCommand(failure[0]!)).toBeUndefined();

    ok.nameStatusImpl = async () => [{ status: "added", path: "retry.ts" }];
    await expect(filesController.retryAdoptedCount(adopted!)).resolves.toEqual({
      id: adopted?.id,
      state: "resolved",
      count: 1,
    });
    expect(adopted?.description).toBe("1");
    expect(adopted?.adoptedCountError).toBeUndefined();
  });

  it("drops adopted count patches from a stale tree generation", async () => {
    const fake = new FakeModel(modelWith(child));
    let resolveFirst!: (entries: readonly NameStatusEntry[]) => void;
    let call = 0;
    fake.nameStatusImpl = async () => {
      call += 1;
      if (call === 1) {
        return new Promise<readonly NameStatusEntry[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return [{ status: "modified", path: "new-generation.ts" }];
    };
    const controller = new AdoptedTreeController(fake);
    const first = await controller.getRootNodes();
    const patches: unknown[] = [];
    const hydration = controller.hydrateAdoptedCounts(first, (patch) => patches.push(patch));

    await controller.refresh();
    resolveFirst([{ status: "modified", path: "stale.ts" }]);
    await hydration;

    expect(patches).toEqual([]);
  });

  it("peeks the last published tree while a refresh is in flight", async () => {
    const fake = new FakeModel(modelWith(child));
    fake.snapshotImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return modelWith(child);
    };
    const controller = new AdoptedTreeController(fake);
    expect(controller.peekRoots()).toBeUndefined();
    const first = await controller.getRootNodes();
    expect(controller.peekRoots()?.[0]?.id).toBe(first[0]?.id);
    await controller.refresh();
    expect(controller.peekRoots()?.[0]?.id).toBe(first[0]?.id);
  });

  it("reconciles in-flight HEAD events into the completed discovery baseline", async () => {
    const fake = new FakeModel(modelWith(child));
    let resolveSnapshot!: (model: WorkspaceGitModel) => void;
    fake.snapshotImpl = () =>
      new Promise<WorkspaceGitModel>((resolve) => {
        resolveSnapshot = resolve;
      });
    const controller = new AdoptedTreeController(fake);
    const loading = controller.getRootNodes();
    const initial = {
      rootPath: "/ws/http",
      head: { name: "main", commit: "c1", detached: false },
      remotes: [],
      groups: emptyChangeGroups(),
    } satisfies RepositoryStateSnapshot;

    expect(controller.consumeRepositoryState(initial)).toBe(false);
    expect(
      controller.consumeRepositoryState({
        ...initial,
        head: { name: "main", commit: "c2", detached: false },
      }),
    ).toBe(true);

    resolveSnapshot(modelWith(child));
    await loading;
    expect(controller.repositoryStateNeedsRediscovery()).toBe(false);
  });

  it("rediscovers only when vscode.git opens a repository absent from the cached topology", async () => {
    const controller = new AdoptedTreeController(new FakeModel(modelWith(child)));

    expect(controller.repositoryOpenNeedsRediscovery("/ws/new")).toBe(false);
    await controller.getRootNodes();
    expect(controller.repositoryOpenNeedsRediscovery("/ws/http")).toBe(false);
    expect(controller.repositoryOpenNeedsRediscovery("/ws/http/lib")).toBe(false);
    expect(controller.repositoryOpenNeedsRediscovery("/ws/new")).toBe(true);
  });

  it("detects branch identity changes even when the commit is unchanged", async () => {
    const initial = {
      rootPath: "/ws/http",
      head: { name: "main", commit: "c1", detached: false },
      remotes: [],
      groups: emptyChangeGroups(),
    } satisfies RepositoryStateSnapshot;
    let snapshots: RepositoryStateSnapshot[] = [initial];
    const controller = new AdoptedTreeController(
      new FakeModel(modelWith(child)),
      () => undefined,
      () => snapshots,
    );
    await controller.getRootNodes();

    const next = {
      ...initial,
      head: { name: "release", commit: "c1", detached: false },
    } satisfies RepositoryStateSnapshot;
    snapshots = [next];
    expect(controller.consumeRepositoryState(next)).toBe(true);
    expect(controller.repositoryStateNeedsRediscovery()).toBe(true);
  });

  it("rediscovers only when workspace root identity differs from the completed discovery", async () => {
    let workspaceRoots = ["/ws/http"];
    const controller = new AdoptedTreeController(
      new FakeModel(modelWith(child)),
      () => undefined,
      () => [],
      () => DEFAULT_CHANGES_TREE_SETTINGS,
      undefined,
      () => workspaceRoots,
    );
    await controller.getRootNodes();
    expect(controller.workspaceFoldersNeedRediscovery()).toBe(false);

    workspaceRoots = ["/ws/http", "/ws/new"];
    expect(controller.workspaceFoldersNeedRediscovery()).toBe(true);

    controller.invalidateModel();
    await controller.refresh("workspace folders changed");
    expect(controller.workspaceFoldersNeedRediscovery()).toBe(false);
  });
});

function findDescendant(
  nodes: readonly AdoptedTreeNode[],
  predicate: (node: AdoptedTreeNode) => boolean,
): AdoptedTreeNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) {
      return node;
    }
    const nested = findDescendant(node.children, predicate);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}
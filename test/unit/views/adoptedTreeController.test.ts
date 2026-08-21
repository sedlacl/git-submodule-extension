import { describe, expect, it } from "vitest";
import { computeAdoptedPointers } from "../../../src/git/adoptedPointers.js";
import type { AdoptedDiffReader, AdoptedDiffSpec, GitModelProvider } from "../../../src/git/interfaces.js";
import type { GitRepoNode, NameStatusEntry, RepoPins, SubmoduleNode, WorkspaceGitModel, WorkspaceRootNode } from "../../../src/git/types.js";
import { AdoptedTreeController } from "../../../src/views/adoptedTreeController.js";
import { treeItemCommand } from "../../../src/views/adoptedViewModel.js";
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
    const group = roots[0]?.children.find((node) => node.kind === "adopted-group");
    const pointer = group?.children.find((node) => node.kind === "pointer");
    const lib = roots[0]?.children.find((node) => node.kind === "submodule");
    expect(group?.id).toBe("adopted:/ws/http");
    expect(pointer?.label).toBe("lib");
    expect(pointer?.children.map((node) => node.kind)).toEqual(["staged", "unstaged"]);
    expect(lib?.children.map((node) => node.kind)).toEqual(["change-group"]);

    const stagedFiles = await controller.getChildren(pointer!.children[0]);
    const unstagedFiles = await controller.getChildren(pointer!.children[1]);
    expect(fake.nameStatusCalls.map((call) => call.kind)).toEqual(["staged", "unstaged"]);
    expect(stagedFiles.map((node) => node.fileDiff?.path)).toEqual(["src/index.ts"]);
    expect(unstagedFiles.map((node) => node.fileDiff?.path)).toEqual(["src/new.ts", "legacy.ts"]);
    expect(treeItemCommand(stagedFiles[0]!)?.command).toBe(COMMANDS.openChange);

    const openAll = await controller.filesForOpenAll(group!);
    expect(openAll.map((file) => file.path)).toEqual(["src/index.ts", "src/new.ts", "legacy.ts"]);
    expect(fake.nameStatusCalls).toHaveLength(2);

    const fromPointer = await controller.filesForOpenAll(pointer!);
    expect(fromPointer).toHaveLength(3);
    const fromParent = await controller.filesForOpenAll(roots[0]!);
    expect(fromParent).toHaveLength(3);
    const fromSubmodule = await controller.filesForOpenAll(lib!);
    expect(fromSubmodule).toHaveLength(0);
  });

  it("refreshes by dropping the snapshot and file cache", async () => {
    const fake = new FakeModel(modelWith(child), [{ status: "modified", path: "once.ts" }]);
    const controller = new AdoptedTreeController(fake);
    const first = await controller.getRootNodes();
    const staged = first[0]?.children.find((node) => node.kind === "adopted-group")?.children[0]?.children[0];
    expect(staged?.kind).toBe("staged");
    await controller.getChildren(staged);
    expect(fake.snapshotCount).toBe(1);
    expect(fake.nameStatusCalls).toHaveLength(1);

    fake.nameStatusImpl = async () => [{ status: "added", path: "after-refresh.ts" }];
    await controller.refresh();
    const second = await controller.getRootNodes();
    const stagedAfter = second[0]?.children.find((node) => node.kind === "adopted-group")?.children[0]?.children[0];
    expect(stagedAfter?.kind).toBe("staged");
    const files = await controller.getChildren(stagedAfter);
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
    const staged = tree[0]?.children.find((node) => node.kind === "adopted-group")?.children[0]?.children[0];
    expect(staged?.kind).toBe("staged");
    const files = await filesController.getChildren(staged);
    expect(files[0]?.kind).toBe("message");
    expect(files[0]?.label).toBe("Failed to list changes");
    expect(treeItemCommand(files[0]!)).toBeUndefined();
  });
});

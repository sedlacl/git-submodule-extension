import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUiFixture, type FixtureManifest } from "../../scripts/create-ui-fixture.js";
import { runGit } from "../../scripts/lib/git-fixture.js";
import { createGitModelService } from "../../src/git/gitModelService.js";
import { toSubmoduleViewModel } from "../../src/git/interfaces.js";
import type { SubmoduleNode } from "../../src/git/types.js";
import { CHANGE_GROUP_LABELS } from "../../src/git/repositoryState.js";
import { SubmoduleChoreReadService } from "../../src/scm/submoduleChoreService.js";
import { AdoptedTreeController } from "../../src/views/adoptedTreeController.js";
import { buildAdoptedTree, type AdoptedTreeNode } from "../../src/views/adoptedViewModel.js";
import { DEFAULT_CHANGES_TREE_SETTINGS } from "../../src/views/changesTreeSettings.js";
import { collectRepositorySnapshots, createGitCli, makeTempRoot, removeTempRoot } from "./helpers.js";

describe("generated fixture topologies", () => {
  let fixtureRoot: string;
  let manifest: FixtureManifest;
  let model: ReturnType<typeof createGitModelService>;

  beforeAll(async () => {
    fixtureRoot = makeTempRoot("git-submodule-int-topo-");
    manifest = await createUiFixture({ force: true, fixtureRoot });
    model = createGitModelService({
      gitPath: "git",
      cli: createGitCli(),
      getWorkspaceFolderPaths: () => manifest.workspaceFolders.map((folder) => folder.path),
    });
  }, 180_000);

  afterAll(() => {
    removeTempRoot(fixtureRoot);
  });

  it("discovers recursive httpendpoint, infra-deploy, and multi-root siblings", async () => {
    const snapshot = await model.snapshot();
    expect(snapshot.roots.map((root) => root.displayName)).toEqual([
      "httpendpoint",
      "infra-deploy",
      "plain-app",
      "plain-lib",
    ]);

    const http = snapshot.roots.find((root) => root.displayName === "httpendpoint");
    expect(http?.children.map((child) => child.relativePath)).toEqual([
      "submodules/uu_energygateway_httpendpointg01",
      "submodules/usy_idsmari_commong01",
    ]);
    const common = http?.children.find((child) => child.relativePath.endsWith("usy_idsmari_commong01"));
    expect(common?.children.map((child) => child.relativePath)).toEqual([
      "submodules/uu_energygateway_datagatewayg01",
    ]);
    expect(snapshot.roots.some((root) => root.displayName === "usy_idsmari_commong01")).toBe(false);

    const infra = snapshot.roots.find((root) => root.displayName === "infra-deploy");
    expect(infra?.children).toHaveLength(6);
    const aflex = infra?.children.filter((child) => child.displayName.startsWith("usy_aflex_initdatag01#")) ?? [];
    expect(aflex.map((child) => child.branch.configuredBranch)).toEqual([
      "feature/t1-deployment",
      "feature/t2-deployment",
      "feature/prod-deployment",
    ]);
    expect(new Set(aflex.map((child) => child.rootPath)).size).toBe(3);

    expect(snapshot.roots.find((root) => root.displayName === "plain-app")?.children).toEqual([]);
    expect(snapshot.roots.find((root) => root.displayName === "plain-lib")?.children).toEqual([]);
  }, 60_000);

  it("computes staged and unstaged adopted diffs on direct and nested pointers", async () => {
    const snapshot = await model.snapshot();
    const http = snapshot.roots.find((root) => root.displayName === "httpendpoint");
    const httplib = byRel(http?.children, "submodules/uu_energygateway_httpendpointg01");
    const common = byRel(http?.children, "submodules/usy_idsmari_commong01");
    const nested = byRel(common?.children, "submodules/uu_energygateway_datagatewayg01");

    expect(httplib?.adoptedChanges.staged).not.toBeNull();
    expect(httplib?.adoptedChanges.unstaged).toBeNull();
    expect(common?.adoptedChanges.unstaged).not.toBeNull();
    expect(nested?.workingState.dirty).toBe(true);
    expect(nested?.workingState.detached).toBe(true);
    expect(nested?.adoptedChanges.unstaged).not.toBeNull();

    const stagedFiles = await model.listNameStatus({
      repoRoot: httplib!.rootPath,
      fromSha: httplib!.adoptedChanges.staged!.fromSha,
      toSha: httplib!.adoptedChanges.staged!.toSha,
      kind: "staged",
    });
    expect(stagedFiles.some((entry) => entry.path.replace(/\\/g, "/").includes("index.js"))).toBe(true);

    const unstagedFiles = await model.listNameStatus({
      repoRoot: common!.rootPath,
      fromSha: common!.adoptedChanges.unstaged!.fromSha,
      toSha: common!.adoptedChanges.unstaged!.toSha,
      kind: "unstaged",
    });
    expect(unstagedFiles.some((entry) => entry.path.replace(/\\/g, "/").includes("notes.txt"))).toBe(true);
    const nestedGitlinkEntry = unstagedFiles.find(
      (entry) => entry.path.replace(/\\/g, "/") === "submodules/uu_energygateway_datagatewayg01",
    );
    expect(nestedGitlinkEntry).toMatchObject({
      status: "modified",
      oldMode: "160000",
      newMode: "160000",
    });
    expect(nestedGitlinkEntry?.oldSha).toMatch(/^[0-9a-f]{40}$/);
    expect(nestedGitlinkEntry?.newSha).toMatch(/^[0-9a-f]{40}$/);
    expect(nestedGitlinkEntry?.oldSha).not.toBe(nestedGitlinkEntry?.newSha);

    const nestedFiles = await model.listNameStatus({
      repoRoot: nested!.rootPath,
      fromSha: nested!.adoptedChanges.unstaged!.fromSha,
      toSha: nested!.adoptedChanges.unstaged!.toSha,
      kind: "unstaged",
    });
    expect(nestedFiles.length).toBeGreaterThan(0);

    const historicalNestedFiles = await model.listNameStatus({
      repoRoot: nested!.rootPath,
      fromSha: nestedGitlinkEntry!.oldSha!,
      toSha: nestedGitlinkEntry!.newSha!,
      kind: "unstaged",
    });
    expect(historicalNestedFiles.some((entry) => entry.path.includes("SaveMessage"))).toBe(true);
  }, 60_000);

  it("keeps repeated source checkouts independent across branches", async () => {
    const snapshot = await model.snapshot();
    const infra = snapshot.roots.find((root) => root.displayName === "infra-deploy");
    const t1 = byRel(infra?.children, "submodules/usy_aflex_initdatag01#t1");
    const t2 = byRel(infra?.children, "submodules/usy_aflex_initdatag01#t2");
    const prod = byRel(infra?.children, "submodules/usy_aflex_initdatag01#prod");

    expect(t1?.rootPath).not.toBe(t2?.rootPath);
    expect(t1?.branch.configuredBranch).toBe("feature/t1-deployment");
    expect(t2?.branch.configuredBranch).toBe("feature/t2-deployment");
    expect(prod?.branch.configuredBranch).toBe("feature/prod-deployment");
    expect(t1?.workingState.dirty).toBe(true);
    expect(t2?.workingState.detached).toBe(true);
    expect(prod?.workingState.dirty).toBe(false);
    expect(path.basename(t1!.rootPath)).toBe("usy_aflex_initdatag01#t1");
  }, 60_000);

  it("builds httpendpoint Staged/Changes order with gitlink rows that nest pointer diffs", async () => {
    const snapshot = await model.snapshot();
    const tree = buildAdoptedTree(
      toSubmoduleViewModel(snapshot),
      collectRepositorySnapshots(snapshot),
      DEFAULT_CHANGES_TREE_SETTINGS,
    );
    const http = tree.find((node) => node.label === "httpendpoint");
    expect(http?.kind).toBe("workspace-root");
    expect(labels(http)).toEqual([
      CHANGE_GROUP_LABELS.index,
      CHANGE_GROUP_LABELS.workingTree,
      "uu_energygateway_httpendpointg01",
      "usy_idsmari_commong01",
    ]);
    expect(http?.children.map((child) => child.kind)).toEqual([
      "change-group",
      "change-group",
      "submodule",
      "submodule",
    ]);

    const staged = byLabel(http, CHANGE_GROUP_LABELS.index);
    const changes = byLabel(http, CHANGE_GROUP_LABELS.workingTree);
    const stagedGitlink = findByRelativePath(staged, "submodules/uu_energygateway_httpendpointg01");
    const unstagedGitlink = findByRelativePath(changes, "submodules/usy_idsmari_commong01");
    expect(stagedGitlink?.decoration?.badge).toBe("S");
    expect(stagedGitlink?.children[0]?.label).toBe("Adopted Changes");
    expect(stagedGitlink?.children[0]?.diffSpec?.kind).toBe("staged");
    expect(unstagedGitlink?.decoration?.badge).toBe("S");
    expect(unstagedGitlink?.children[0]?.diffSpec?.kind).toBe("unstaged");
    expect(byLabel(http, "Adopted Changes")).toBeUndefined();
    expect(byLabel(http, CHANGE_GROUP_LABELS.merge)).toBeUndefined();
    expect(byLabel(http, CHANGE_GROUP_LABELS.untracked)).toBeUndefined();

    const libNode = byLabel(http, "uu_energygateway_httpendpointg01");
    const commonNode = byLabel(http, "usy_idsmari_commong01");
    expect(byKind(libNode, "adopted-group")).toEqual([]);
    const nestedGitlink = findByRelativePath(
      byLabel(commonNode, CHANGE_GROUP_LABELS.workingTree),
      "submodules/uu_energygateway_datagatewayg01",
    );
    expect(nestedGitlink?.decoration?.badge).toBe("S");
    expect(nestedGitlink?.children[0]?.diffSpec?.kind).toBe("unstaged");
    const nested = byLabel(commonNode, "uu_energygateway_datagatewayg01");
    expect(byKind(nested, "adopted-group")).toEqual([]);
    expect(nested?.children.some((child) => child.kind === "change-group")).toBe(true);

    const controller = new AdoptedTreeController(model, () => undefined, () => collectRepositorySnapshots(snapshot));
    await controller.refresh();
    const controllerRoots = await controller.getRootNodes();
    const controllerHttp = controllerRoots.find((node) => node.label === "httpendpoint");
    const controllerChanges = byLabel(controllerHttp, CHANGE_GROUP_LABELS.workingTree);
    const controllerCommonGitlink = findByRelativePath(controllerChanges, "submodules/usy_idsmari_commong01");
    const commonAdopted = controllerCommonGitlink?.children[0];
    expect(commonAdopted?.kind).toBe("adopted-group");
    const commonAdoptedChildren = await controller.getChildren(commonAdopted!);
    const historicalPointer = findPointerByPath(commonAdoptedChildren, "submodules/uu_energygateway_datagatewayg01");
    expect(historicalPointer?.decoration?.badge).toBe("S");
    expect(historicalPointer?.children[0]?.kind).toBe("adopted-group");
    expect(historicalPointer?.children[0]?.diffSpec?.repoRoot).toBe(nested?.repositoryRoot);
    const nestedAdoptedFiles = await controller.getChildren(historicalPointer!.children[0]!);
    expect(
      nestedAdoptedFiles.some((node) =>
        collectLabels(node).some((label) => label.includes("SaveMessage")),
      ),
    ).toBe(true);
  }, 60_000);

  it("keeps infra-deploy nested checkouts and multi-root siblings without parent Adopted Changes", async () => {
    const snapshot = await model.snapshot();
    const tree = buildAdoptedTree(
      toSubmoduleViewModel(snapshot),
      collectRepositorySnapshots(snapshot),
      DEFAULT_CHANGES_TREE_SETTINGS,
    );
    expect(tree.map((node) => node.label)).toEqual(["httpendpoint", "infra-deploy", "plain-app", "plain-lib"]);

    const infra = tree.find((node) => node.label === "infra-deploy");
    expect(byLabel(infra, "Adopted Changes")).toBeUndefined();
    expect(labels(infra)[0]).toBe(CHANGE_GROUP_LABELS.workingTree);
    expect(infra?.children.filter((child) => child.kind === "submodule").map((child) => child.label)).toEqual([
      "usy_aflex_initdatag01#t1",
      "usy_aflex_initdatag01#t2",
      "usy_aflex_initdatag01#prod",
      "usy_iedc_initdatag01#t1",
      "usy_iedc_initdatag01#t2",
      "usy_iedc_initdatag01#prod",
    ]);
    const t1 = byLabel(infra, "usy_aflex_initdatag01#t1");
    const t2 = byLabel(infra, "usy_aflex_initdatag01#t2");
    expect(t1?.repositoryRoot).not.toBe(t2?.repositoryRoot);
    expect(t1?.children.some((child) => child.kind === "change-group")).toBe(true);

    const app = tree.find((node) => node.label === "plain-app");
    const lib = tree.find((node) => node.label === "plain-lib");
    expect(byLabel(app, "Adopted Changes")).toBeUndefined();
    expect(byLabel(lib, "Adopted Changes")).toBeUndefined();
    expect(app?.children.every((child) => child.kind !== "submodule")).toBe(true);
    expect(lib?.children.every((child) => child.kind !== "submodule")).toBe(true);
  }, 60_000);

  it("previews a message-only httpendpoint submodule chore without committing", async () => {
    const snapshot = await model.snapshot();
    const http = snapshot.roots.find((root) => root.displayName === "httpendpoint");
    const before = shaOrEmpty(http!.rootPath);
    const chore = new SubmoduleChoreReadService(createGitCli());
    const preview = await chore.preview(http!.rootPath);
    expect(preview).not.toBeNull();
    expect(preview?.message).toContain("submodules/uu_energygateway_httpendpointg01");
    expect(preview?.message).toContain("submodules/usy_idsmari_commong01");
    expect(preview?.updates.some((update) => update.staged)).toBe(true);
    expect(preview?.updates.some((update) => !update.staged)).toBe(true);
    expect(preview?.message).toContain("nested submodule submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01");
    expect(preview?.message).toContain("T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support");
    expect(preview?.message).not.toContain("Note:");
    expect(preview?.message).not.toMatch(/not staged/i);
    expect(shaOrEmpty(http!.rootPath)).toBe(before);
  }, 60_000);
});

function byRel(nodes: readonly SubmoduleNode[] | undefined, relativePath: string): SubmoduleNode | undefined {
  return nodes?.find((node) => node.relativePath === relativePath);
}

function labels(node: AdoptedTreeNode | undefined): string[] {
  return node?.children.map((child) => child.label) ?? [];
}

function byLabel(node: AdoptedTreeNode | undefined, label: string): AdoptedTreeNode | undefined {
  return node?.children.find((child) => child.label === label);
}

function findByRelativePath(node: AdoptedTreeNode | undefined, relativePath: string): AdoptedTreeNode | undefined {
  if (!node) {
    return undefined;
  }
  if (node.change?.resource.relativePath === relativePath) {
    return node;
  }
  for (const child of node.children) {
    const nested = findByRelativePath(child, relativePath);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function findPointerByPath(nodes: readonly AdoptedTreeNode[], relativePath: string): AdoptedTreeNode | undefined {
  for (const node of nodes) {
    if (node.kind === "pointer" && (node.pointerPath === relativePath || node.label === relativePath.split("/").pop())) {
      return node;
    }
    const nested = findPointerByPath(node.children, relativePath);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function collectLabels(node: AdoptedTreeNode): string[] {
  return [node.label, node.fileDiff?.path ?? "", ...node.children.flatMap(collectLabels)].filter(Boolean);
}

function byKind(node: AdoptedTreeNode | undefined, kind: AdoptedTreeNode["kind"]): AdoptedTreeNode[] {
  return node?.children.filter((child) => child.kind === kind) ?? [];
}

function shaOrEmpty(rootPath: string): string {
  return runGit(rootPath, ["rev-parse", "HEAD"]);
}

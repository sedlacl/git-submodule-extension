import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUiFixture, type FixtureManifest } from "../../scripts/create-ui-fixture.js";
import { createGitModelService } from "../../src/git/gitModelService.js";
import type { SubmoduleNode } from "../../src/git/types.js";
import { createGitCli, makeTempRoot, removeTempRoot } from "./helpers.js";

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

    const nestedFiles = await model.listNameStatus({
      repoRoot: nested!.rootPath,
      fromSha: nested!.adoptedChanges.unstaged!.fromSha,
      toSha: nested!.adoptedChanges.unstaged!.toSha,
      kind: "unstaged",
    });
    expect(nestedFiles.length).toBeGreaterThan(0);
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
});

function byRel(nodes: readonly SubmoduleNode[] | undefined, relativePath: string): SubmoduleNode | undefined {
  return nodes?.find((node) => node.relativePath === relativePath);
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildScenarioRecords,
  buildWorkspaceFile,
  createUiFixture,
  MANIFEST_FILE_NAME,
  WORKSPACE_FILE_NAME,
} from "../../scripts/create-ui-fixture.js";
import { runGit } from "../../scripts/lib/git-fixture.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-submodule-ui-fixture-"));
  tempRoots.push(root);
  return root;
}

describe("create-ui-fixture", () => {
  it("builds a multi-root workspace definition", () => {
    const fixtureRoot = makeTempFixtureRoot();
    const workspaceFile = buildWorkspaceFile(fixtureRoot, [
      { name: "httpendpoint", relativePath: "httpendpoint" },
      { name: "plain-app", relativePath: "plain-app" },
    ]);

    const workspace = JSON.parse(fs.readFileSync(workspaceFile, "utf8")) as {
      folders: Array<{ name: string; path: string }>;
      settings: Record<string, unknown>;
    };

    expect(workspace.folders).toHaveLength(2);
    expect(workspace.folders[0]?.path).toBe("httpendpoint");
    expect(workspace.settings["git.detectSubmodules"]).toBe(true);
    expect(workspace.settings["gitSubmodule.restore.enabled"]).toBe(false);
  });

  it("lists representative scenario markers", () => {
    const scenarios = buildScenarioRecords();
    const states = new Set(scenarios.map((scenario) => scenario.state));
    expect(states.has("staged-pointer")).toBe(true);
    expect(states.has("unstaged-pointer")).toBe(true);
    expect(states.has("dirty")).toBe(true);
    expect(states.has("detached")).toBe(true);
    expect(states.has("diverged")).toBe(true);
  });

  it("generates local git topologies without network remotes", async () => {
    const fixtureRoot = makeTempFixtureRoot();
    const manifest = await createUiFixture({ force: true, fixtureRoot });

    expect(fs.existsSync(path.join(fixtureRoot, MANIFEST_FILE_NAME))).toBe(true);
    expect(fs.existsSync(manifest.workspaceFile)).toBe(true);
    expect(fs.existsSync(manifest.topologies.httpendpoint)).toBe(true);
    expect(fs.existsSync(manifest.topologies.infraDeploy)).toBe(true);

    const httpGitmodules = fs.readFileSync(
      path.join(manifest.topologies.httpendpoint, ".gitmodules"),
      "utf8",
    );
    expect(httpGitmodules).toContain("submodules/uu_energygateway_httpendpointg01");
    expect(httpGitmodules).toContain("submodules/usy_idsmari_commong01");
    expect(httpGitmodules).toContain("url = file://");

    const infraGitmodules = fs.readFileSync(
      path.join(manifest.topologies.infraDeploy, ".gitmodules"),
      "utf8",
    );
    expect(infraGitmodules).toContain("usy_aflex_initdatag01#t1");
    expect(infraGitmodules).toContain("usy_iedc_initdatag01#prod");
    expect(infraGitmodules).not.toMatch(/^url = (https?|ssh):/m);

    const workspace = JSON.parse(fs.readFileSync(manifest.workspaceFile, "utf8")) as {
      folders: Array<{ path: string }>;
    };
    expect(workspace.folders.length).toBeGreaterThanOrEqual(4);

    const nestedPath = path.join(
      manifest.topologies.httpendpoint,
      "submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01",
    );
    expect(fs.existsSync(path.join(nestedPath, ".git"))).toBe(true);
    expect(runGit(nestedPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");

    const headSha = runGit(manifest.topologies.httpendpoint, [
      "rev-parse",
      "HEAD:submodules/uu_energygateway_httpendpointg01",
    ]);
    const indexSha = runGit(manifest.topologies.httpendpoint, [
      "rev-parse",
      ":0:submodules/uu_energygateway_httpendpointg01",
    ]);
    expect(indexSha).not.toBe(headSha);
  }, 120_000);

  it("reuses an existing manifest unless force is requested", async () => {
    const fixtureRoot = makeTempFixtureRoot();
    const first = await createUiFixture({ force: true, fixtureRoot });
    const marker = path.join(fixtureRoot, WORKSPACE_FILE_NAME);
    const mtime = fs.statSync(marker).mtimeMs;
    const second = await createUiFixture({ fixtureRoot });
    expect(second.createdAt).toBe(first.createdAt);
    expect(fs.statSync(marker).mtimeMs).toBe(mtime);
  }, 120_000);
});

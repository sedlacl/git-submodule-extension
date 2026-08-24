import * as fs from "node:fs";
import * as path from "node:path";
import {
  addSubmodule,
  checkout,
  commitAll,
  commitFile,
  createBranch,
  ensureDir,
  initRepo,
  removeDir,
  runGit,
  stageGitlink,
  submoduleUpdate,
  writeFile,
} from "./lib/git-fixture.js";
import { getProjectRoot, toFileUrl } from "./lib/paths.js";

export const FIXTURE_VERSION = 1 as const;
export const FIXTURE_DIR_NAME = "ui";
export const WORKSPACE_FILE_NAME = "ui-dev.code-workspace";
export const MANIFEST_FILE_NAME = "manifest.json";

export interface ScenarioRecord {
  topology: "httpendpoint" | "infra-deploy" | "multi-root";
  repo: string;
  submodule?: string;
  state: "clean" | "staged-pointer" | "unstaged-pointer" | "dirty" | "detached" | "diverged";
  detail?: string;
}

export interface FixtureManifest {
  version: typeof FIXTURE_VERSION;
  createdAt: string;
  fixtureRoot: string;
  workspaceFile: string;
  sourcesRoot: string;
  topologies: {
    httpendpoint: string;
    infraDeploy: string;
  };
  workspaceFolders: Array<{ name: string; path: string }>;
  scenarios: ScenarioRecord[];
}

export interface CreateUiFixtureOptions {
  force?: boolean;
  fixtureRoot?: string;
}

function sourcesRoot(fixtureRoot: string): string {
  return path.join(fixtureRoot, "sources");
}

function repoPath(fixtureRoot: string, ...segments: string[]): string {
  return path.join(fixtureRoot, ...segments);
}

function createSourceRepo(
  dir: string,
  initialBranch: string,
  files: Array<{ path: string; content: string; message: string }>,
): Record<string, string> {
  initRepo(dir, initialBranch);
  const commits: Record<string, string> = {};
  for (const file of files) {
    commits[file.message] = commitFile(dir, file.path, file.content, file.message);
  }
  return commits;
}

/**
 * Deployment branches must diverge from `startPoint`, not from whatever the
 * previous call left checked out; otherwise they stack into one chain and a
 * diff between two of them accumulates the commits in between.
 */
function createBranchCommits(
  repoDir: string,
  branch: string,
  files: Array<{ path: string; content: string; message: string }>,
  startPoint = "main",
): Record<string, string> {
  createBranch(repoDir, branch, startPoint);
  checkout(repoDir, branch);
  const commits: Record<string, string> = {};
  for (const file of files) {
    commits[file.message] = commitFile(repoDir, file.path, file.content, file.message);
  }
  return commits;
}

function buildHttpendpointSources(root: string): {
  httpendpointLib: string;
  mariCommon: string;
  datagateway: string;
} {
  const httpendpointLib = path.join(root, "uu_energygateway_httpendpointg01");
  createSourceRepo(httpendpointLib, "aflex/6.3", [
    { path: "README.md", content: "# httpendpoint lib v1\n", message: "init httpendpoint lib" },
    { path: "src/index.js", content: "module.exports = { version: 1 };\n", message: "add index v1" },
  ]);
  commitFile(
    httpendpointLib,
    "src/index.js",
    "module.exports = { version: 2 };\n",
    "add index v2",
  );

  const datagateway = path.join(root, "uu_energygateway_datagatewayg01");
  createSourceRepo(datagateway, "aflex/6.3-production", [
    { path: "README.md", content: "# datagateway v1\n", message: "init datagateway" },
    { path: "gateway.txt", content: "mode=production\n", message: "gateway config v1" },
  ]);
  commitFile(datagateway, "gateway.txt", "mode=production\nfeature=enabled\n", "gateway config v2");

  const mariCommon = path.join(root, "usy_idsmari_commong01");
  createSourceRepo(mariCommon, "development/AFLEX", [
    { path: "README.md", content: "# mari common\n", message: "init mari common" },
  ]);
  addSubmodule(
    mariCommon,
    "submodules/uu_energygateway_datagatewayg01",
    toFileUrl(datagateway),
    "aflex/6.3-production",
  );
  commitAll(mariCommon, "add nested datagateway submodule");

  return { httpendpointLib, mariCommon, datagateway };
}

function buildInfraSources(root: string): { aflexInit: string; iedcInit: string } {
  const aflexInit = path.join(root, "usy_aflex_initdatag01");
  createSourceRepo(aflexInit, "main", [
    { path: "README.md", content: "# aflex init base\n", message: "init aflex" },
    { path: "env/base.env", content: "ENV=base\n", message: "base env" },
  ]);

  createBranchCommits(aflexInit, "feature/t1-deployment", [
    { path: "env/t1.env", content: "ENV=t1\n", message: "t1 env" },
  ]);
  createBranchCommits(aflexInit, "feature/t2-deployment", [
    { path: "env/t2.env", content: "ENV=t2\n", message: "t2 env" },
  ]);
  createBranchCommits(aflexInit, "feature/prod-deployment", [
    { path: "env/prod.env", content: "ENV=prod\n", message: "prod env" },
  ]);

  const iedcInit = path.join(root, "usy_iedc_initdatag01");
  createSourceRepo(iedcInit, "main", [
    { path: "README.md", content: "# iedc init base\n", message: "init iedc" },
  ]);
  createBranchCommits(iedcInit, "feature/t1-deployment", [
    { path: "env/t1.env", content: "IEDC=t1\n", message: "iedc t1" },
  ]);
  createBranchCommits(iedcInit, "feature/t2-deployment", [
    { path: "env/t2.env", content: "IEDC=t2\n", message: "iedc t2" },
  ]);
  createBranchCommits(iedcInit, "feature/prod-deployment", [
    { path: "env/prod.env", content: "IEDC=prod\n", message: "iedc prod" },
  ]);

  return { aflexInit, iedcInit };
}

function buildPlainRepos(fixtureRoot: string): { plainApp: string; plainLib: string } {
  const plainApp = repoPath(fixtureRoot, "plain-app");
  createSourceRepo(plainApp, "main", [
    { path: "README.md", content: "# plain app\n", message: "init plain app" },
    { path: "app.js", content: "console.log('plain');\n", message: "add app entry" },
  ]);

  const plainLib = repoPath(fixtureRoot, "plain-lib");
  createSourceRepo(plainLib, "main", [
    { path: "README.md", content: "# plain lib\n", message: "init plain lib" },
  ]);

  return { plainApp, plainLib };
}

function buildHttpendpointTopology(
  fixtureRoot: string,
  sources: ReturnType<typeof buildHttpendpointSources>,
): string {
  const parent = repoPath(fixtureRoot, "httpendpoint");
  initRepo(parent, "main");
  addSubmodule(
    parent,
    "submodules/uu_energygateway_httpendpointg01",
    toFileUrl(sources.httpendpointLib),
    "aflex/6.3",
  );
  addSubmodule(
    parent,
    "submodules/usy_idsmari_commong01",
    toFileUrl(sources.mariCommon),
    "development/AFLEX",
  );
  submoduleUpdate(parent);
  commitAll(parent, "pin httpendpoint submodules");

  const httpPath = "submodules/uu_energygateway_httpendpointg01";
  const mariPath = "submodules/usy_idsmari_commong01";
  const nestedRelativePath = "submodules/uu_energygateway_datagatewayg01";
  const httpAbs = path.join(parent, httpPath);
  const mariAbs = path.join(parent, mariPath);
  const nestedAbs = path.join(mariAbs, nestedRelativePath);

  checkout(httpAbs, "aflex/6.3");
  const stagedSha = commitFile(
    httpAbs,
    "src/index.js",
    "module.exports = { version: 3 };\n",
    "local v3 for staged pointer",
  );
  stageGitlink(parent, httpPath, stagedSha);
  checkout(httpAbs, stagedSha);

  checkout(mariAbs, "development/AFLEX");
  const unstagedSha = commitFile(mariAbs, "notes.txt", "fixture pointer bump\n", "pointer bump");
  checkout(mariAbs, unstagedSha);

  checkout(nestedAbs, "aflex/6.3-production");
  writeFile(path.join(nestedAbs, "dirty-local.txt"), "uncommitted nested change\n");
  const nestedUnstagedSha = runGit(nestedAbs, ["rev-parse", "HEAD~1"]);
  runGit(nestedAbs, ["checkout", "--detach", nestedUnstagedSha]);

  return parent;
}

function buildInfraDeployTopology(
  fixtureRoot: string,
  sources: ReturnType<typeof buildInfraSources>,
): string {
  const parent = repoPath(fixtureRoot, "infra-deploy");
  initRepo(parent, "main");
  commitFile(parent, "README.md", "# infra deploy fixture\n", "init infra deploy");

  const entries: Array<{ path: string; url: string; branch: string }> = [
    { path: "submodules/usy_aflex_initdatag01#t1", url: sources.aflexInit, branch: "feature/t1-deployment" },
    { path: "submodules/usy_aflex_initdatag01#t2", url: sources.aflexInit, branch: "feature/t2-deployment" },
    { path: "submodules/usy_aflex_initdatag01#prod", url: sources.aflexInit, branch: "feature/prod-deployment" },
    { path: "submodules/usy_iedc_initdatag01#t1", url: sources.iedcInit, branch: "feature/t1-deployment" },
    { path: "submodules/usy_iedc_initdatag01#t2", url: sources.iedcInit, branch: "feature/t2-deployment" },
    { path: "submodules/usy_iedc_initdatag01#prod", url: sources.iedcInit, branch: "feature/prod-deployment" },
  ];

  for (const entry of entries) {
    addSubmodule(parent, entry.path, toFileUrl(entry.url), entry.branch);
  }
  submoduleUpdate(parent);
  commitAll(parent, "add infra deploy submodule matrix");

  const t1Path = "submodules/usy_aflex_initdatag01#t1";
  const t2Path = "submodules/usy_aflex_initdatag01#t2";
  const t1Abs = path.join(parent, t1Path);
  const t2Abs = path.join(parent, t2Path);
  const pinnedT2Sha = runGit(t2Abs, ["rev-parse", "HEAD"]);

  checkout(t1Abs, "feature/t1-deployment");
  runGit(t1Abs, ["commit", "--allow-empty", "-m", "t1 pointer-only bump"]);
  writeFile(path.join(t1Abs, "local/t1-wip.txt"), "uncommitted t1 change\n");

  checkout(t2Abs, "feature/t2-deployment");
  runGit(t2Abs, ["checkout", "--detach", pinnedT2Sha]);

  return parent;
}

export function buildWorkspaceFile(
  fixtureRoot: string,
  folders: Array<{ name: string; relativePath: string }>,
): string {
  const workspacePath = path.join(fixtureRoot, WORKSPACE_FILE_NAME);
  const payload = {
    folders: folders.map((folder) => ({
      name: folder.name,
      path: folder.relativePath.replace(/\\/g, "/"),
    })),
    settings: {
      "git.autoRepositoryDetection": true,
      "git.detectSubmodules": true,
      "git.detectSubmodulesLimit": 20,
      "gitSubmodule.restore.enabled": false,
    },
  };
  writeFile(workspacePath, `${JSON.stringify(payload, null, 2)}\n`);
  return workspacePath;
}

export function buildScenarioRecords(): ScenarioRecord[] {
  return [
    { topology: "httpendpoint", repo: "httpendpoint", submodule: "submodules/uu_energygateway_httpendpointg01", state: "staged-pointer", detail: "index gitlink ahead of HEAD" },
    { topology: "httpendpoint", repo: "httpendpoint", submodule: "submodules/usy_idsmari_commong01", state: "unstaged-pointer", detail: "checkout differs from index" },
    { topology: "httpendpoint", repo: "httpendpoint", submodule: "submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01", state: "unstaged-pointer", detail: "nested checkout differs from parent gitlink" },
    { topology: "httpendpoint", repo: "httpendpoint", submodule: "submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01", state: "dirty", detail: "uncommitted file in nested submodule" },
    { topology: "httpendpoint", repo: "httpendpoint", submodule: "submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01", state: "detached", detail: "detached HEAD at pin" },
    { topology: "infra-deploy", repo: "infra-deploy", submodule: "submodules/usy_aflex_initdatag01#t1", state: "diverged", detail: "branch commits ahead of parent pin" },
    { topology: "infra-deploy", repo: "infra-deploy", submodule: "submodules/usy_aflex_initdatag01#t1", state: "dirty", detail: "checkout behind branch tip with dirty tree at pin" },
    { topology: "infra-deploy", repo: "infra-deploy", submodule: "submodules/usy_aflex_initdatag01#t2", state: "detached" },
    { topology: "infra-deploy", repo: "infra-deploy", state: "clean", detail: "prod checkouts pinned cleanly" },
    { topology: "multi-root", repo: "plain-app", state: "clean" },
    { topology: "multi-root", repo: "plain-lib", state: "clean" },
  ];
}

export async function createUiFixture(options: CreateUiFixtureOptions = {}): Promise<FixtureManifest> {
  const projectRoot = getProjectRoot();
  const fixtureRoot = options.fixtureRoot ?? path.join(projectRoot, "fixtures", FIXTURE_DIR_NAME);
  const manifestPath = path.join(fixtureRoot, MANIFEST_FILE_NAME);

  if (!options.force && fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as FixtureManifest;
  }

  if (options.force && fs.existsSync(fixtureRoot)) {
    removeDir(fixtureRoot);
  }

  ensureDir(fixtureRoot);
  const srcRoot = sourcesRoot(fixtureRoot);
  ensureDir(srcRoot);

  const httpSources = buildHttpendpointSources(srcRoot);
  const infraSources = buildInfraSources(srcRoot);
  buildPlainRepos(fixtureRoot);

  const httpendpoint = buildHttpendpointTopology(fixtureRoot, httpSources);
  const infraDeploy = buildInfraDeployTopology(fixtureRoot, infraSources);

  const workspaceFolders = [
    { name: "httpendpoint", relativePath: "httpendpoint" },
    { name: "infra-deploy", relativePath: "infra-deploy" },
    { name: "plain-app", relativePath: "plain-app" },
    { name: "plain-lib", relativePath: "plain-lib" },
  ];
  const workspaceFile = buildWorkspaceFile(fixtureRoot, workspaceFolders);

  const manifest: FixtureManifest = {
    version: FIXTURE_VERSION,
    createdAt: new Date().toISOString(),
    fixtureRoot,
    workspaceFile,
    sourcesRoot: srcRoot,
    topologies: { httpendpoint, infraDeploy },
    workspaceFolders: workspaceFolders.map((folder) => ({
      name: folder.name,
      path: path.join(fixtureRoot, folder.relativePath),
    })),
    scenarios: buildScenarioRecords(),
  };

  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const manifest = await createUiFixture({ force });
  console.log(`UI fixture ready at ${manifest.fixtureRoot}`);
  console.log(`Workspace: ${manifest.workspaceFile}`);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("create-ui-fixture.ts") ||
    process.argv[1].endsWith("create-ui-fixture.js"));

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

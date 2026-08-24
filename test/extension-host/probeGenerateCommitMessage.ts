import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { API, Repository } from "../../src/git/git.js";

const COMMAND = "cursor.generateGitCommitMessage";
const WAIT_MS = 3_000;
const TARGET_SUFFIX = `${path.sep}usy_aflex_initdatag01#t1`;
const SIBLING_SUFFIX = `${path.sep}usy_aflex_initdatag01#t2`;
const DEFAULT_TARGET_REL = path.join("infra-deploy", "submodules", "usy_aflex_initdatag01#t1");
const DEFAULT_SIBLING_REL = path.join("infra-deploy", "submodules", "usy_aflex_initdatag01#t2");

const AUTH_ERROR_PATTERN =
  /unauthenticated|not logged in|authorization header|sign in|sign-in|login required|UserNotLoggedIn/i;

export type ProbeOutcome =
  | "command-not-registered"
  | "command-threw"
  | "command-ran-no-draft-change"
  | "draft-changed-target"
  | "draft-changed-different-repo"
  | "blocked-by-auth-inconclusive";

export interface ProbeAttemptResult {
  label: string;
  outcome: ProbeOutcome;
  error?: string;
  authSignals: string[];
  changedRoots: string[];
  targetChanged: boolean;
  siblingUnchanged: boolean;
}

export interface ProbeAuthState {
  likelyUnauthenticated: boolean;
  signals: string[];
}

export interface ProbeStaticAnalysis {
  menuContribution: string;
  expectedFirstArgument: string;
  handlerResolution: string;
  source: string;
}

export interface ProbeReport {
  command: string;
  targetRoot: string;
  siblingRoot: string;
  openRepositories: string[];
  commandAvailable: boolean;
  authState: ProbeAuthState;
  staticAnalysis: ProbeStaticAnalysis;
  liveVerificationInconclusive: boolean;
  attempts: ProbeAttemptResult[];
}

export async function runGenerateCommitMessageProbe(outputPath: string): Promise<void> {
  const git = vscode.extensions.getExtension<{ getAPI(version: number): API }>("vscode.git");
  assert.ok(git, "vscode.git extension missing");
  if (!git.isActive) {
    await git.activate();
  }
  const api = git.exports.getAPI(1);
  await vscode.commands.executeCommand("workbench.view.scm");
  await ensureFixtureRepositories(api);
  await waitForTargetRepository(api, TARGET_SUFFIX, 90_000);

  const commands = await vscode.commands.getCommands(true);
  const commandAvailable = commands.includes(COMMAND);
  const authState = await detectAuthState(commands);

  const repositories = api.repositories.map((repository) => repository.rootUri.fsPath);
  const targetRoot = findRepoRoot(repositories, TARGET_SUFFIX);
  const siblingRoot = findRepoRoot(repositories, SIBLING_SUFFIX);
  assert.ok(targetRoot, `Target repo ending with ${TARGET_SUFFIX} not found among ${repositories.length} repos`);
  assert.ok(siblingRoot, `Sibling repo ending with ${SIBLING_SUFFIX} not found among ${repositories.length} repos`);

  const targetRepository = api.getRepository(vscode.Uri.file(targetRoot))!;
  assert.ok(targetRepository, "Target repository handle missing");
  await targetRepository.status();

  const attempts: ProbeAttemptResult[] = [];
  if (commandAvailable) {
    const candidates = buildCandidates(targetRoot, targetRepository);
    for (const candidate of candidates) {
      clearAllDrafts(api);
      attempts.push(await runAttempt(api, targetRoot, siblingRoot, candidate.label, candidate.args, authState));
    }
  } else {
    attempts.push({
      label: "(skipped)",
      outcome: "command-not-registered",
      authSignals: [],
      changedRoots: [],
      targetChanged: false,
      siblingUnchanged: true,
    });
  }

  const report: ProbeReport = {
    command: COMMAND,
    targetRoot,
    siblingRoot,
    openRepositories: repositories,
    commandAvailable,
    authState,
    staticAnalysis: cursorStaticAnalysis(),
    liveVerificationInconclusive: authState.likelyUnauthenticated,
    attempts,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** Safety check usable even when auth blocks generation: Uri targeting must not mutate sibling drafts. */
export async function verifyUriTargetingSafety(): Promise<void> {
  const git = vscode.extensions.getExtension<{ getAPI(version: number): API }>("vscode.git");
  assert.ok(git, "vscode.git extension missing");
  if (!git.isActive) {
    await git.activate();
  }
  const api = git.exports.getAPI(1);
  await ensureFixtureRepositories(api);
  await waitForTargetRepository(api, TARGET_SUFFIX, 90_000);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(COMMAND), `${COMMAND} is not registered`);

  const repositories = api.repositories.map((repository) => repository.rootUri.fsPath);
  const targetRoot = findRepoRoot(repositories, TARGET_SUFFIX)!;
  const siblingRoot = findRepoRoot(repositories, SIBLING_SUFFIX)!;
  clearAllDrafts(api);

  const attempt = await runAttempt(
    api,
    targetRoot,
    siblingRoot,
    "Uri.file(rootPath) safety",
    [vscode.Uri.file(targetRoot)],
    await detectAuthState(commands),
  );

  assert.ok(attempt.siblingUnchanged, "Uri targeting must not change the sibling repository draft");
  assert.notEqual(
    attempt.outcome,
    "draft-changed-different-repo",
    "Uri targeting must not fill a different repository draft",
  );
}

function cursorStaticAnalysis(): ProbeStaticAnalysis {
  return {
    menuContribution: 'scm/inputBox menu entry when "scmProvider == git" (cursor-always-local/package.json)',
    expectedFirstArgument:
      "vscode.Uri rootUri whose toString() matches the target SCM repository provider.rootUri",
    handlerResolution:
      "handler selects repositories.find(r => r.provider.rootUri?.toString() === rootUri.toString()) then writes repository.input",
    source: "Cursor workbench.desktop.main.js cursor.generateGitCommitMessage handler",
  };
}

async function detectAuthState(commands: readonly string[]): Promise<ProbeAuthState> {
  const signals: string[] = [];
  if (process.env.GIT_SUBMODULE_PROBE_ISOLATED_PROFILE === "1") {
    signals.push("isolated-extension-host-profile");
  }
  if (commands.some((command) => /sign.?in|login|authenticate/i.test(command))) {
    signals.push("auth-related-commands-present");
  }
  try {
    const session = await vscode.authentication.getSession("cursor", [], { createIfNone: false });
    if (!session) {
      signals.push("no-cursor-auth-session");
    }
  } catch {
    signals.push("cursor-auth-provider-unavailable");
  }
  return {
    likelyUnauthenticated: signals.length > 0,
    signals,
  };
}

function buildCandidates(
  targetRoot: string,
  repository: Repository,
): Array<{ label: string; args: unknown[] }> {
  const rootUri = vscode.Uri.file(targetRoot);
  const resourceGroups =
    (repository.state as { groups?: Array<{ id: string; resources: Array<{ resourceUri: vscode.Uri }> }> }).groups?.map(
      (group) => ({
        resourceGroupId: group.id,
        resources: group.resources.map((resource) => resource.resourceUri),
      }),
    ) ?? [];
  const inputBox = repository.inputBox;

  return [
    { label: "no args", args: [] },
    { label: "Uri.file(rootPath)", args: [rootUri] },
    { label: "{ rootUri }", args: [{ rootUri }] },
    { label: "Repository (git API)", args: [repository] },
    { label: "inputBox", args: [inputBox] },
    { label: "{ inputBox }", args: [{ inputBox }] },
    { label: "{ repository }", args: [{ repository }] },
    { label: "Uri + resourceGroups", args: [rootUri, resourceGroups] },
    { label: "{ rootUri, resourceGroups }", args: [{ rootUri, resourceGroups }] },
  ];
}

async function runAttempt(
  api: API,
  targetRoot: string,
  siblingRoot: string,
  label: string,
  args: unknown[],
  authState: ProbeAuthState,
): Promise<ProbeAttemptResult> {
  const before = readDrafts(api);
  const authSignals = [...authState.signals];

  let error: string | undefined;
  try {
    await vscode.commands.executeCommand(COMMAND, ...args);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (AUTH_ERROR_PATTERN.test(error)) {
      authSignals.push("thrown-auth-error");
    }
  }

  const after = await waitForDraftDelta(api, before, WAIT_MS);
  const changedRoots = Object.entries(after)
    .filter(([root, value]) => before[root] !== value)
    .map(([root]) => root);
  const targetChanged = changedRoots.some((root) => sameRepoPath(root, targetRoot));
  const siblingBefore = before[siblingRoot] ?? "";
  const siblingAfter = after[siblingRoot] ?? "";
  const siblingUnchanged = siblingBefore === siblingAfter;
  const differentRepoChanged = changedRoots.some((root) => !sameRepoPath(root, targetRoot));

  const outcome = classifyOutcome({
    threw: Boolean(error),
    targetChanged,
    differentRepoChanged,
    anyDraftChanged: changedRoots.length > 0,
    authSignals,
    authState,
  });

  return {
    label,
    outcome,
    error,
    authSignals: [...new Set(authSignals)],
    changedRoots: changedRoots.map((root) => path.basename(root)),
    targetChanged,
    siblingUnchanged,
  };
}

function classifyOutcome(input: {
  threw: boolean;
  targetChanged: boolean;
  differentRepoChanged: boolean;
  anyDraftChanged: boolean;
  authSignals: string[];
  authState: ProbeAuthState;
}): ProbeOutcome {
  if (input.threw) {
    return "command-threw";
  }
  if (input.targetChanged) {
    return "draft-changed-target";
  }
  if (input.differentRepoChanged) {
    return "draft-changed-different-repo";
  }
  if (!input.anyDraftChanged && (input.authState.likelyUnauthenticated || input.authSignals.length > 0)) {
    return "blocked-by-auth-inconclusive";
  }
  if (!input.anyDraftChanged) {
    return "command-ran-no-draft-change";
  }
  return "command-ran-no-draft-change";
}

function clearAllDrafts(api: API): void {
  for (const repository of api.repositories) {
    repository.inputBox.value = "";
  }
}

function readDrafts(api: API): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const repository of api.repositories) {
    drafts[repository.rootUri.fsPath] = repository.inputBox.value;
  }
  return drafts;
}

async function waitForDraftDelta(
  api: API,
  before: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readDrafts(api);
    if (Object.keys(current).some((root) => current[root] !== before[root])) {
      return current;
    }
    await sleep(50);
  }
  return readDrafts(api);
}

async function ensureFixtureRepositories(api: API): Promise<void> {
  const fixtureRoot = process.env.GIT_SUBMODULE_FIXTURE_ROOT?.trim();
  if (!fixtureRoot) {
    return;
  }
  const targetRoot = path.join(fixtureRoot, DEFAULT_TARGET_REL);
  const siblingRoot = path.join(fixtureRoot, DEFAULT_SIBLING_REL);
  const targetFile = path.join(targetRoot, "local", "t1-wip.txt");
  if (fs.existsSync(targetFile)) {
    await vscode.window.showTextDocument(vscode.Uri.file(targetFile), { preview: false, preserveFocus: true });
  }
  const infraDeploy = path.join(fixtureRoot, "infra-deploy");
  const infraRepository = api.getRepository(vscode.Uri.file(infraDeploy));
  if (infraRepository) {
    await infraRepository.status();
  }
  await waitForAnyRepository(api, siblingRoot, 30_000);
  if (!findRepoRoot(api.repositories.map((repository) => repository.rootUri.fsPath), TARGET_SUFFIX)) {
    await waitForAnyRepository(api, targetRoot, 30_000);
  }
}

async function waitForAnyRepository(api: API, rootPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (api.getRepository(vscode.Uri.file(rootPath))) {
      return;
    }
    await sleep(250);
  }
}

async function waitForTargetRepository(api: API, suffix: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const roots = api.repositories.map((repository) => repository.rootUri.fsPath);
    if (findRepoRoot(roots, suffix)) {
      await sleep(500);
      return;
    }
    await sleep(250);
  }
  const roots = api.repositories.map((repository) => repository.rootUri.fsPath);
  throw new Error(
    `Timed out waiting for repo ending with ${suffix} (have ${roots.length}: ${roots.map((root) => path.basename(root)).join(", ")})`,
  );
}

function findRepoRoot(repositories: readonly string[], suffix: string): string | undefined {
  const marker = suffix.replace(/^.*[/\\]/, "");
  return repositories.find((root) => root.endsWith(suffix) || root.endsWith(marker));
}

function sameRepoPath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

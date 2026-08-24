import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { runGenerateCommitMessageProbe, verifyUriTargetingSafety } from "./probeGenerateCommitMessage.js";

const EXTENSION_ID = "qjohn.git-submodule-extension";
const REQUIRED_COMMANDS = [
  "gitSubmodule.refresh",
  "gitSubmodule.openDiff",
  "gitSubmodule.openChange",
  "gitSubmodule.openAllChanges",
  "gitSubmodule.stage",
  "gitSubmodule.unstage",
  "gitSubmodule.clean",
  "gitSubmodule.commit",
  "gitSubmodule.generateSubmoduleChore",
  "gitSubmodule.sync",
  "gitSubmodule.publish",
  "gitSubmodule.retryRestore",
  "gitSubmodule.fetchRemote",
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not found in the Extension Development Host.`);

  await extension.activate();
  assert.equal(extension.isActive, true, "Extension did not activate.");

  const git = vscode.extensions.getExtension("vscode.git");
  assert.ok(git, "Built-in vscode.git is not available; the isolated host must keep that provider.");
  if (!git.isActive) {
    await git.activate();
  }

  const commands = await vscode.commands.getCommands(true);
  for (const command of REQUIRED_COMMANDS) {
    assert.ok(commands.includes(command), `Missing command ${command}`);
  }

  const restoreEnabled = vscode.workspace.getConfiguration("gitSubmodule").get("restore.enabled");
  assert.equal(typeof restoreEnabled, "boolean");
  assert.equal(
    restoreEnabled,
    false,
    "UI fixture workspace must keep restore disabled so detached/dirty scenarios stay inspectable.",
  );

  const verifyTargeting = process.env.GIT_SUBMODULE_VERIFY_GENERATE_TARGET?.trim();
  if (verifyTargeting) {
    await verifyUriTargetingSafety();
    return;
  }

  const probeReportPath = process.env.GIT_SUBMODULE_PROBE_GENERATE_COMMIT?.trim();
  if (probeReportPath) {
    await runGenerateCommitMessageProbe(probeReportPath);
    return;
  }

  await vscode.commands.executeCommand("workbench.view.scm");
  if (process.env.GIT_SUBMODULE_TIMING_FILE) {
    await vscode.commands.executeCommand("gitSubmodule.repos.focus");
    await runProfileRefreshes();
  } else {
    await vscode.commands.executeCommand("gitSubmodule.refresh");
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.ok(folders.length >= 4, `Expected multi-root fixture, received ${folders.length} folders.`);
  const names = folders.map((folder) => folder.name);
  assert.ok(names.includes("httpendpoint"), "httpendpoint folder missing");
  assert.ok(names.includes("infra-deploy"), "infra-deploy folder missing");
  assert.ok(names.includes("plain-app"), "plain-app folder missing");
}

async function runProfileRefreshes(): Promise<void> {
  const timingFile = process.env.GIT_SUBMODULE_TIMING_FILE;
  const refreshCount = Number(process.env.GIT_SUBMODULE_PROFILE_REFRESHES ?? 0);
  if (!timingFile || !Number.isInteger(refreshCount) || refreshCount < 0) {
    return;
  }

  let completedBatches = countMatches(readTimingFile(timingFile), /adopted counts .*\)/g);
  await vscode.commands.executeCommand("gitSubmodule.refresh");
  await waitForTimingFile(timingFile, (content) => {
    const hasFinal = /\[changes #\d+\] final .*\)/.test(content);
    const batches = countMatches(content, /adopted counts .*\)/g);
    return hasFinal && batches > completedBatches;
  });
  completedBatches = countMatches(readTimingFile(timingFile), /adopted counts .*\)/g);

  for (let index = 0; index < refreshCount; index += 1) {
    let measured = false;
    for (let attempt = 0; attempt < 5 && !measured; attempt += 1) {
      const before = readTimingFile(timingFile);
      const finalsBefore = countMatches(before, /\[changes #\d+\] final .*\)/g);
      const explicitBefore = countMatches(before, /\[changes #\d+\] final .*reason: [^;]*explicit refresh/g);
      const batchesBefore = countMatches(before, /adopted counts .*\)/g);
      await vscode.commands.executeCommand("gitSubmodule.refresh");
      await waitForTimingFile(timingFile, (content) => {
        return (
          countMatches(content, /\[changes #\d+\] final .*\)/g) > finalsBefore &&
          countMatches(content, /adopted counts .*\)/g) > batchesBefore
        );
      });
      const after = readTimingFile(timingFile);
      measured =
        countMatches(after, /\[changes #\d+\] final .*reason: [^;]*explicit refresh/g) > explicitBefore;
      completedBatches = countMatches(after, /adopted counts .*\)/g);
    }
    if (!measured) {
      throw new Error(`Could not obtain warm explicit refresh ${index + 1}/${refreshCount}`);
    }
  }
}

async function waitForTimingFile(
  filePath: string,
  predicate: (content: string) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(readTimingFile(filePath))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for complete UI timing evidence in ${filePath}`);
}

function readTimingFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

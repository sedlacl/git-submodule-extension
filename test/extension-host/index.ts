import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "qjohn.git-submodule-extension";
const REQUIRED_COMMANDS = [
  "gitSubmodule.refresh",
  "gitSubmodule.openDiff",
  "gitSubmodule.openAllChanges",
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

  await vscode.commands.executeCommand("workbench.view.scm");
  await vscode.commands.executeCommand("gitSubmodule.refresh");

  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.ok(folders.length >= 4, `Expected multi-root fixture, received ${folders.length} folders.`);
  const names = folders.map((folder) => folder.name);
  assert.ok(names.includes("httpendpoint"), "httpendpoint folder missing");
  assert.ok(names.includes("infra-deploy"), "infra-deploy folder missing");
  assert.ok(names.includes("plain-app"), "plain-app folder missing");
}

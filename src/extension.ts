import * as vscode from "vscode";
import { GitCliRunner } from "./git/gitCli.js";
import { createGitModelService } from "./git/gitModelService.js";
import { activateVsCodeGitApi } from "./git/vscodeGitApi.js";
import { registerBranchRestore } from "./restore/registerBranchRestore.js";
import { registerAdoptedView } from "./views/registerAdoptedView.js";

/**
 * Activates the git model, hierarchical SCM Changes tree, and fail-closed branch restore.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let gitApi;
  try {
    gitApi = await activateVsCodeGitApi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Git Submodule Extension: ${message}`);
    return;
  }

  const cli = new GitCliRunner(gitApi.gitPath);
  const model = createGitModelService({
    gitPath: gitApi.gitPath,
    cli,
    getWorkspaceFolderPaths: () => gitApi.getWorkspaceFolderPaths(),
  });

  const restore = registerBranchRestore({ cli, gitApi });
  context.subscriptions.push(
    restore,
    registerAdoptedView({ model, gitApi, cli, restoreStatus: restore.status, extensionUri: context.extensionUri }),
  );
}

export function deactivate(): void {}

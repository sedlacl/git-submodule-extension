import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { ActionDiagnostics } from "./actionDiagnostics.js";
import { GitCliRunner } from "./git/gitCli.js";
import { createGitModelService } from "./git/gitModelService.js";
import { activateVsCodeGitApi } from "./git/vscodeGitApi.js";
import { registerBranchRestore } from "./restore/registerBranchRestore.js";
import { createChangesDiagnosticWriter } from "./views/changesLoadDiagnostics.js";
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

  const output = vscode.window.createOutputChannel("Git Submodule");
  const timingFile = process.env.GIT_SUBMODULE_TIMING_FILE?.trim();
  const writeDiagnostic = createChangesDiagnosticWriter((line) => {
    output.appendLine(line);
    if (timingFile) {
      void fs.appendFile(timingFile, `${line}\n`, "utf8").catch(() => undefined);
    }
  });
  const actionDiagnostics = new ActionDiagnostics(writeDiagnostic);
  const restore = registerBranchRestore({
    cli,
    gitApi,
    output,
    writeDiagnostic,
    actionDiagnostics,
  });
  context.subscriptions.push(
    output,
    restore,
    registerAdoptedView({
      model,
      gitApi,
      cli,
      restoreStatus: restore.status,
      extensionUri: context.extensionUri,
      writeDiagnostic,
      actionDiagnostics,
    }),
  );
}

export function deactivate(): void {}

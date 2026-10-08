import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { ActionDiagnostics } from "./actionDiagnostics.js";
import { GitCliRunner } from "./git/gitCli.js";
import { createGitModelService } from "./git/gitModelService.js";
import { activateVsCodeGitApi } from "./git/vscodeGitApi.js";
import { registerBranchRestore } from "./restore/registerBranchRestore.js";
import { VIEW_ID } from "./views/constants.js";
import { createChangesDiagnosticWriter, formatDuration } from "./views/changesLoadDiagnostics.js";
import { registerAdoptedView } from "./views/registerAdoptedView.js";

const GIT_WAIT_HEARTBEAT_MS = 5_000;
const GIT_WAIT_NOTICE_MS = 15_000;

/**
 * Activates the git model, hierarchical SCM Changes tree, and fail-closed branch restore.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Git Submodule");
  const timingFile = process.env.GIT_SUBMODULE_TIMING_FILE?.trim();
  const writeDiagnostic = createChangesDiagnosticWriter((line) => {
    output.appendLine(line);
    if (timingFile) {
      void fs.appendFile(timingFile, `${line}\n`, "utf8").catch(() => undefined);
    }
  });
  let alive = true;
  context.subscriptions.push(output, {
    dispose() {
      alive = false;
    },
  });

  writeDiagnostic("waiting for vscode.git");
  const waitStarted = Date.now();
  const heartbeat = setInterval(() => {
    writeDiagnostic(`still waiting for vscode.git (${formatDuration(Date.now() - waitStarted)})`);
  }, GIT_WAIT_HEARTBEAT_MS);
  const slowNotice = setTimeout(() => {
    output.show(true);
    void vscode.window.showInformationMessage(
      "Git Submodule is still waiting for Git to finish opening this workspace. Progress is in the Output channel Git Submodule.",
    );
  }, GIT_WAIT_NOTICE_MS);
  const stopWaitingUi = (): void => {
    clearInterval(heartbeat);
    clearTimeout(slowNotice);
  };
  context.subscriptions.push({ dispose: stopWaitingUi });

  let gitApi;
  try {
    gitApi = await activateVsCodeGitApi();
  } catch (error) {
    stopWaitingUi();
    const message = error instanceof Error ? error.message : String(error);
    writeDiagnostic(`activation stopped: ${message}`);
    if (alive) {
      context.subscriptions.push(registerActivationMessageView(message));
      void vscode.window.showWarningMessage(`Git Submodule Extension: ${message}`);
    }
    return;
  }
  stopWaitingUi();
  if (!alive) {
    return;
  }
  writeDiagnostic(`vscode.git ready (${formatDuration(Date.now() - waitStarted)})`);

  const cli = new GitCliRunner(gitApi.gitPath);
  const model = createGitModelService({
    gitPath: gitApi.gitPath,
    cli,
    getWorkspaceFolderPaths: () => gitApi.getWorkspaceFolderPaths(),
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
    restore,
    registerAdoptedView({
      model,
      gitApi,
      cli,
      restoreStatus: restore.status,
      extensionUri: context.extensionUri,
      workspaceState: context.workspaceState,
      writeDiagnostic,
      actionDiagnostics,
    }),
  );
}

export function deactivate(): void {}

function registerActivationMessageView(message: string): vscode.Disposable {
  const text = escapeHtml(message);
  return vscode.window.registerWebviewViewProvider(
    VIEW_ID,
    {
      resolveWebviewView(webviewView) {
        webviewView.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  body {
    margin: 0;
    padding: 12px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
</style>
</head>
<body><p role="alert">${text}</p></body>
</html>`;
      },
    },
    { webviewOptions: { retainContextWhenHidden: true } },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

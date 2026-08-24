import * as vscode from "vscode";
import type { GitCli } from "../git/gitCli.js";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import { BranchReconciler } from "./branchReconciler.js";
import { SafeBranchRestoreService, type RestoreRequest } from "./branchRestoreService.js";
import { RestoreCoordinator } from "./restoreCoordinator.js";
import { RestoreStatusStore } from "./restoreStatusStore.js";
import {
  fetchConfirmMessage,
  RESTORE_COMMANDS,
  RESTORE_DEFAULTS,
  restoreOutputLine,
  type RestoreCommandContext,
} from "./settings.js";

export interface RegisterBranchRestoreOptions {
  cli: GitCli;
  gitApi: VsCodeGitApiAdapter;
}

export interface BranchRestoreRegistration extends vscode.Disposable {
  readonly status: RestoreStatusStore;
  readonly output: vscode.OutputChannel;
  retry(parentRootPath: string): Promise<void>;
  retryAll(): Promise<void>;
  fetch(request: RestoreRequest): Promise<void>;
  isAutoEnabled(): boolean;
}

export function registerBranchRestore(options: RegisterBranchRestoreOptions): BranchRestoreRegistration {
  const status = new RestoreStatusStore();
  const output = vscode.window.createOutputChannel("Git Submodule");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = RESTORE_COMMANDS.retry;
  statusBar.tooltip = "Git Submodule restore";
  statusBar.show();

  const restore = new SafeBranchRestoreService(options.cli);
  const reconciler = new BranchReconciler(options.cli, restore, {
    debounceMs: () => readDebounceMs(),
    onResult: (result) => {
      status.put(result);
      output.appendLine(restoreOutputLine(result));
    },
    onRunStart: () => status.beginRun(),
    onRunEnd: () => status.endRun(),
  });
  const coordinator = new RestoreCoordinator(reconciler, restore, isAutoEnabled);

  const renderStatusBar = (): void => {
    if (!isAutoEnabled()) {
      statusBar.text = "$(circle-slash) Submodule restore off";
      statusBar.tooltip = "Automatic branch restore is disabled. Retry and fetch remain available as explicit commands.";
      return;
    }
    const blocked = status.blocked();
    if (status.isRunning) {
      statusBar.text = "$(sync~spin) Restoring submodules";
      statusBar.tooltip = "Fail-closed branch restore is running. No fetch/pull/push/commit/discard.";
      return;
    }
    if (blocked.length > 0) {
      statusBar.text = `$(warning) ${blocked.length} submodule restore blocked`;
      statusBar.tooltip = blocked.map((item) => `${item.path}: ${item.detail}`).join("\n");
      return;
    }
    statusBar.text = "$(file-submodule) Submodules";
    statusBar.tooltip = "Automatic fail-closed restore is idle.";
  };

  const disposables: vscode.Disposable[] = [
    output,
    statusBar,
    status.subscribe(renderStatusBar),
    new vscode.Disposable(() => reconciler.dispose()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("gitSubmodule.restore")) {
        renderStatusBar();
      }
    }),
    options.gitApi.subscribe({
      onOpenRepository: (rootPath) => coordinator.onRepositoryEvent(rootPath),
      onDidChangeRepository: (rootPath) => coordinator.onRepositoryEvent(rootPath),
    }),
    vscode.commands.registerCommand(RESTORE_COMMANDS.retry, (arg?: unknown) => {
      const target = asRestoreContext(arg);
      return target ? coordinator.retry(target.parentRootPath) : coordinator.retryMany(options.gitApi.getWorkspaceFolderPaths());
    }),
    vscode.commands.registerCommand(RESTORE_COMMANDS.fetch, (arg?: unknown) => fetchWithConfirmation(coordinator, arg)),
  ];

  renderStatusBar();

  return {
    status,
    output,
    retry: (parentRootPath) => coordinator.retry(parentRootPath),
    retryAll: () => coordinator.retryMany(options.gitApi.getWorkspaceFolderPaths()),
    fetch: (request) => coordinator.fetch(request),
    isAutoEnabled,
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}

function isAutoEnabled(): boolean {
  return vscode.workspace.getConfiguration("gitSubmodule").get("restore.enabled", RESTORE_DEFAULTS.enabled);
}

function readDebounceMs(): number {
  const value = vscode.workspace.getConfiguration("gitSubmodule").get("restore.debounceMs", RESTORE_DEFAULTS.debounceMs);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return RESTORE_DEFAULTS.debounceMs;
  }
  return Math.min(10_000, Math.max(0, Math.floor(value)));
}

async function fetchWithConfirmation(coordinator: RestoreCoordinator, arg: unknown): Promise<void> {
  const target = asRestoreContext(arg);
  if (!target?.branch || !target.pin) {
    void vscode.window.showWarningMessage("Select a submodule with a committed branch and parent gitlink to fetch its remote.");
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(fetchConfirmMessage(target.relativePath, target.branch), {
    modal: true,
  }, "Fetch");
  if (confirmed !== "Fetch") {
    return;
  }

  const request: RestoreRequest = {
    parentRootPath: target.parentRootPath,
    relativePath: target.relativePath,
    childRootPath: target.childRootPath,
    branch: target.branch,
    pin: target.pin,
  };
  try {
    await coordinator.fetch(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Fetch failed for ${target.relativePath}: ${detail}`);
    return;
  }

  const next = await vscode.window.showInformationMessage(
    `Fetched origin/${target.branch} for '${target.relativePath}'.`,
    "Retry restore",
  );
  if (next === "Retry restore") {
    await coordinator.retry(target.parentRootPath);
  }
}

function asRestoreContext(arg: unknown): RestoreCommandContext | undefined {
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  const candidate = arg as { restoreTarget?: RestoreCommandContext } & Partial<RestoreCommandContext>;
  const target = candidate.restoreTarget ?? candidate;
  if (!target.parentRootPath || !target.relativePath || !target.childRootPath) {
    return undefined;
  }
  return {
    parentRootPath: target.parentRootPath,
    relativePath: target.relativePath,
    childRootPath: target.childRootPath,
    branch: target.branch ?? null,
    pin: target.pin ?? null,
  };
}

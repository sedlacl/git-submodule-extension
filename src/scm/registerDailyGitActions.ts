import * as path from "node:path";
import * as vscode from "vscode";
import {
  ActionDiagnostics,
  type ActionDetails,
  type ActionOutcome,
  type ActionRun,
} from "../actionDiagnostics.js";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import type { AdoptedTreeNode } from "../views/adoptedViewModel.js";
import { COMMANDS } from "../views/constants.js";
import { BusyRepositoryError, DailyGitActions, type DailyGitActionsUi } from "./dailyGitActions.js";
import {
  buildPublicGenerateCommitMessageCommandArgs,
  generateCommitSubject,
  isPublicCommitMessageTargetSupported,
} from "./generateCommitMessage.js";
import type { SubmoduleChoreReadService } from "./submoduleChoreTypes.js";

export interface RegisterDailyGitActionsOptions {
  gitApi: VsCodeGitApiAdapter;
  choreService: SubmoduleChoreReadService;
  actionDiagnostics: ActionDiagnostics;
  postActionRefresh(): void;
  explicitRefresh(): void;
}

export function registerDailyGitActions(options: RegisterDailyGitActionsOptions): vscode.Disposable {
  const actions = new DailyGitActions(options.gitApi, createUi(options.gitApi), options.choreService);
  const register = (
    command: string,
    actionKind: string,
    title: string,
    handler: (
      node: AdoptedTreeNode | undefined,
      selected: readonly AdoptedTreeNode[] | undefined,
      action: ActionRun,
    ) => Promise<ActionOutcome>,
  ): vscode.Disposable =>
    vscode.commands.registerCommand(
      command,
      (node: AdoptedTreeNode | undefined, selected: readonly AdoptedTreeNode[] | undefined) =>
        runCommand(options.actionDiagnostics, actionKind, title, actionContext(node, selected), async (action) => {
          const outcome = await handler(node, selected, action);
          if (
            outcome.result === "completed" &&
            (actionKind !== "generate message" || outcome.details?.["draft changed"] === true)
          ) {
            if (actionKind === "refresh") {
              options.explicitRefresh();
            } else {
              options.postActionRefresh();
            }
          }
          return outcome;
        }),
    );

  const changeHandler =
    (kind: "stage" | "unstage" | "discard") =>
    async (
      node: AdoptedTreeNode | undefined,
      selected: readonly AdoptedTreeNode[] | undefined,
    ): Promise<ActionOutcome> => {
      const nodes = commandNodes(node, selected);
      return await actions[kind](nodes);
    };

  const repositoryHandler =
    (kind: "commit" | "prepareSubmoduleChore" | "checkoutBranch" | "fetch" | "pull" | "sync" | "publish") =>
    async (
      node: AdoptedTreeNode | undefined,
      _selected: readonly AdoptedTreeNode[] | undefined,
      action: ActionRun,
    ): Promise<ActionOutcome> => {
      const rootPath = await resolveRepositoryRoot(options.gitApi, node);
      if (!rootPath) {
        return { result: "cancelled", reason: "repository picker dismissed" };
      }
      return kind === "prepareSubmoduleChore"
        ? await actions.prepareSubmoduleChore(rootPath, action)
        : await actions[kind](rootPath);
    };

  const stage = changeHandler("stage");
  const unstage = changeHandler("unstage");
  const discard = changeHandler("discard");

  return vscode.Disposable.from(
    register(COMMANDS.stage, "stage", "Stage Changes", stage),
    register(COMMANDS.stageAll, "stage all", "Stage All Changes", stage),
    register(COMMANDS.stageAllTracked, "stage all tracked", "Stage All Tracked Changes", stage),
    register(COMMANDS.stageAllUntracked, "stage all untracked", "Stage All Untracked Changes", stage),
    register(COMMANDS.stageAllMerge, "stage all merge", "Stage All Merge Changes", stage),
    register(COMMANDS.unstage, "unstage", "Unstage Changes", unstage),
    register(COMMANDS.unstageAll, "unstage all", "Unstage All Changes", unstage),
    register(COMMANDS.clean, "discard", "Discard Changes", discard),
    register(COMMANDS.cleanAll, "discard all", "Discard All Changes", discard),
    register(COMMANDS.cleanAllTracked, "discard all tracked", "Discard All Tracked Changes", discard),
    register(COMMANDS.cleanAllUntracked, "discard all untracked", "Discard All Untracked Changes", discard),
    register(COMMANDS.commit, "commit", "Commit", repositoryHandler("commit")),
    register(
      COMMANDS.generateSubmoduleChore,
      "generate message",
      "Generate Submodule Chore",
      repositoryHandler("prepareSubmoduleChore"),
    ),
    register(COMMANDS.checkoutBranch, "checkout branch", "Checkout Branch", repositoryHandler("checkoutBranch")),
    register(COMMANDS.fetch, "fetch", "Fetch", repositoryHandler("fetch")),
    register(COMMANDS.pull, "pull", "Pull", repositoryHandler("pull")),
    register(COMMANDS.sync, "sync", "Sync", repositoryHandler("sync")),
    register(COMMANDS.publish, "publish", "Publish Branch", repositoryHandler("publish")),
    register(COMMANDS.refresh, "refresh", "Refresh", async (node) => {
      const rootPath = node?.repositoryRoot;
      const roots = rootPath ? [rootPath] : options.gitApi.getOpenRepositoryPaths();
      return await actions.refresh(roots);
    }),
  );
}

function commandNodes(
  node: AdoptedTreeNode | undefined,
  selected: readonly AdoptedTreeNode[] | undefined,
): AdoptedTreeNode[] {
  if (!node) {
    return [];
  }
  if (selected && selected.length > 1 && selected.some((item) => item.id === node.id)) {
    return [...selected];
  }
  return [node];
}

async function resolveRepositoryRoot(
  gitApi: VsCodeGitApiAdapter,
  node: AdoptedTreeNode | undefined,
): Promise<string | undefined> {
  if (node?.repositoryRoot) {
    return node.repositoryRoot;
  }

  const repositories = gitApi.getOpenRepositories();
  if (repositories.length === 0) {
    void vscode.window.showInformationMessage("No open Git repositories.");
    return undefined;
  }
  if (repositories.length === 1) {
    return repositories[0]!.rootPath;
  }

  const selected = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      label: path.basename(repository.rootPath),
      description: repository.rootPath,
      rootPath: repository.rootPath,
    })),
    { placeHolder: "Choose a repository" },
  );
  return selected?.rootPath;
}

function gitConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("git");
}

function createUi(gitApi: VsCodeGitApiAdapter): DailyGitActionsUi {
  return {
    confirm: async (message, actions) =>
      await vscode.window.showWarningMessage(message, { modal: true }, ...actions),
    gitConfirmSync: () => gitConfig().get("confirmSync") === true,
    disableGitConfirmSync: async () => {
      await gitConfig().update("confirmSync", false, vscode.ConfigurationTarget.Global);
    },
    input: async (options) =>
      await vscode.window.showInputBox({
        value: options.value,
        placeHolder: options.placeHolder,
        prompt: options.prompt,
        ignoreFocusOut: true,
      }),
    generateCommitSubject: async (rootPath) =>
      await generateCommitSubject(
        {
          listCommands: async () => await vscode.commands.getCommands(true),
          executeCommand: async (command, targetRoot) => {
            const args = buildPublicGenerateCommitMessageCommandArgs(command, targetRoot, vscode.Uri.file);
            await vscode.commands.executeCommand(command, ...args);
          },
          supportsTarget: (command, targetRoot) =>
            isPublicCommitMessageTargetSupported(gitApi.getOpenRepositories(), targetRoot, command),
          readDraft: () => gitApi.getRepositoryHandle(rootPath)?.inputBoxValue,
          waitForDraftChange: async (before, timeoutMs) =>
            await waitForTargetDraftChange(gitApi, rootPath, before, timeoutMs),
          isCancellationError: (error) => error instanceof vscode.CancellationError,
        },
        rootPath,
      ),
    pickRemote: async (remotes) => {
      const selected = await vscode.window.showQuickPick(
        remotes.map((remote) => ({
          label: remote.name,
          description: remote.description,
          name: remote.name,
        })),
        { placeHolder: "Choose a remote to publish the branch" },
      );
      return selected?.name;
    },
    pickBranch: async (branches) => {
      const selected = await vscode.window.showQuickPick(
        branches.map((branch) => ({
          label: branch.current ? `$(check) ${branch.name}` : `$(git-branch) ${branch.name}`,
          description: branch.description,
          name: branch.name,
        })),
        {
          placeHolder: "Choose a branch to check out",
          matchOnDescription: true,
        },
      );
      return selected?.name;
    },
    info: (message) => {
      void vscode.window.showInformationMessage(message);
    },
  };
}

async function waitForTargetDraftChange(
  gitApi: VsCodeGitApiAdapter,
  rootPath: string,
  before: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const draft = gitApi.getRepositoryHandle(rootPath)?.inputBoxValue;
    if (draft === undefined || draft !== before) {
      return draft;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return gitApi.getRepositoryHandle(rootPath)?.inputBoxValue;
}

function actionContext(
  node: AdoptedTreeNode | undefined,
  selected: readonly AdoptedTreeNode[] | undefined,
): ActionDetails {
  const roots = [
    ...new Set(
      commandNodes(node, selected)
        .map((item) => item.repositoryRoot)
        .filter((root): root is string => Boolean(root)),
    ),
  ];
  if (roots.length === 1) {
    return { repository: path.basename(roots[0]!) };
  }
  return roots.length > 1 ? { repositories: roots.length } : {};
}

async function runCommand(
  diagnostics: ActionDiagnostics,
  kind: string,
  title: string,
  context: ActionDetails,
  operation: (action: ActionRun) => Promise<ActionOutcome>,
): Promise<void> {
  const action = diagnostics.start(kind, context);
  try {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${title}…` },
      async () => await operation(action),
    );
    finishAction(action, outcome);
  } catch (error) {
    if (error instanceof BusyRepositoryError) {
      action.cancelled("busy", { repository: path.basename(error.rootPath) });
      void vscode.window.showInformationMessage(error.message);
      return;
    }
    action.failed(error);
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`${title} failed: ${detail}`);
  }
}

function finishAction(action: ActionRun, outcome: ActionOutcome): void {
  if (outcome.result === "completed") {
    action.completed(outcome.details);
  } else if (outcome.result === "unavailable") {
    action.unavailable(outcome.reason ?? "unavailable", outcome.details);
  } else if (outcome.result === "cancelled") {
    action.cancelled(outcome.reason ?? "cancelled", outcome.details);
  } else {
    action.failed(outcome.error ?? outcome.reason ?? "Action failed", outcome.details);
  }
}

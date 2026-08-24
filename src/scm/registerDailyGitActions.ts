import * as path from "node:path";
import * as vscode from "vscode";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import type { AdoptedTreeNode } from "../views/adoptedViewModel.js";
import { COMMANDS } from "../views/constants.js";
import { BusyRepositoryError, DailyGitActions, type DailyGitActionsUi } from "./dailyGitActions.js";
import { firstCommitLine, pickPublicGenerateCommitMessageCommand } from "./generateCommitMessage.js";
import type { SubmoduleChoreReadService } from "./submoduleChoreTypes.js";

export interface RegisterDailyGitActionsOptions {
  gitApi: VsCodeGitApiAdapter;
  choreService: SubmoduleChoreReadService;
  refreshTree(): void;
  beforeRefreshCommand?(): void;
}

export function registerDailyGitActions(options: RegisterDailyGitActionsOptions): vscode.Disposable {
  const actions = new DailyGitActions(options.gitApi, createUi(options.gitApi), options.choreService);
  const register = (
    command: string,
    title: string,
    handler: (node?: AdoptedTreeNode, selected?: readonly AdoptedTreeNode[]) => Promise<void>,
  ): vscode.Disposable =>
    vscode.commands.registerCommand(
      command,
      (node: AdoptedTreeNode | undefined, selected: readonly AdoptedTreeNode[] | undefined) =>
        runCommand(title, async () => {
          await handler(node, selected);
          options.refreshTree();
        }),
    );

  const changeHandler =
    (kind: "stage" | "unstage" | "discard") =>
    async (node?: AdoptedTreeNode, selected?: readonly AdoptedTreeNode[]): Promise<void> => {
      const nodes = commandNodes(node, selected);
      await actions[kind](nodes);
    };

  const repositoryHandler =
    (kind: "commit" | "prepareSubmoduleChore" | "checkoutBranch" | "fetch" | "pull" | "sync" | "publish") =>
    async (node?: AdoptedTreeNode): Promise<void> => {
      const rootPath = await resolveRepositoryRoot(options.gitApi, node);
      if (rootPath) {
        await actions[kind](rootPath);
      }
    };

  const stage = changeHandler("stage");
  const unstage = changeHandler("unstage");
  const discard = changeHandler("discard");

  return vscode.Disposable.from(
    register(COMMANDS.stage, "Stage Changes", stage),
    register(COMMANDS.stageAll, "Stage All Changes", stage),
    register(COMMANDS.stageAllTracked, "Stage All Tracked Changes", stage),
    register(COMMANDS.stageAllUntracked, "Stage All Untracked Changes", stage),
    register(COMMANDS.stageAllMerge, "Stage All Merge Changes", stage),
    register(COMMANDS.unstage, "Unstage Changes", unstage),
    register(COMMANDS.unstageAll, "Unstage All Changes", unstage),
    register(COMMANDS.clean, "Discard Changes", discard),
    register(COMMANDS.cleanAll, "Discard All Changes", discard),
    register(COMMANDS.cleanAllTracked, "Discard All Tracked Changes", discard),
    register(COMMANDS.cleanAllUntracked, "Discard All Untracked Changes", discard),
    register(COMMANDS.commit, "Commit", repositoryHandler("commit")),
    register(COMMANDS.generateSubmoduleChore, "Generate Submodule Chore", repositoryHandler("prepareSubmoduleChore")),
    register(COMMANDS.checkoutBranch, "Checkout Branch", repositoryHandler("checkoutBranch")),
    register(COMMANDS.fetch, "Fetch", repositoryHandler("fetch")),
    register(COMMANDS.pull, "Pull", repositoryHandler("pull")),
    register(COMMANDS.sync, "Sync", repositoryHandler("sync")),
    register(COMMANDS.publish, "Publish Branch", repositoryHandler("publish")),
    register(COMMANDS.refresh, "Refresh", async (node) => {
      options.beforeRefreshCommand?.();
      const rootPath = node?.repositoryRoot;
      const roots = rootPath ? [rootPath] : options.gitApi.getOpenRepositoryPaths();
      await actions.refresh(roots);
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

function createUi(gitApi: VsCodeGitApiAdapter): DailyGitActionsUi {
  return {
    confirm: async (message, actions) =>
      await vscode.window.showWarningMessage(message, { modal: true }, ...actions),
    input: async (options) =>
      await vscode.window.showInputBox({
        value: options.value,
        placeHolder: options.placeHolder,
        prompt: options.prompt,
        ignoreFocusOut: true,
      }),
    generateCommitSubject: async (rootPath) => await tryPublicGenerateCommitSubject(gitApi, rootPath),
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

async function tryPublicGenerateCommitSubject(
  gitApi: VsCodeGitApiAdapter,
  rootPath: string,
): Promise<string | undefined> {
  let commands: string[];
  try {
    commands = await vscode.commands.getCommands(true);
  } catch {
    return undefined;
  }
  const command = pickPublicGenerateCommitMessageCommand(commands);
  if (!command) {
    return undefined;
  }
  const before = gitApi.getRepositoryHandle(rootPath)?.inputBoxValue ?? "";
  try {
    await vscode.commands.executeCommand(command);
  } catch {
    return undefined;
  }
  const after = gitApi.getRepositoryHandle(rootPath)?.inputBoxValue ?? "";
  const subject = firstCommitLine(after).trim();
  if (subject && after !== before) {
    return subject;
  }
  return undefined;
}

async function runCommand(title: string, operation: () => Promise<void>): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${title}…` },
      operation,
    );
  } catch (error) {
    if (error instanceof BusyRepositoryError) {
      void vscode.window.showInformationMessage(error.message);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`${title} failed: ${detail}`);
  }
}

import * as vscode from "vscode";
import type { GitCli } from "../git/gitCli.js";
import type { AdoptedDiffReader, GitModelProvider } from "../git/interfaces.js";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import type { RestoreStatusStore } from "../restore/restoreStatusStore.js";
import { registerDailyGitActions } from "../scm/registerDailyGitActions.js";
import { SubmoduleChoreReadService } from "../scm/submoduleChoreService.js";
import { AdoptedTreeController } from "./adoptedTreeController.js";
import {
  openAllTitle,
  openPreparedChanges,
  prepareFileDiff,
  prepareOpenAll,
} from "./adoptedDiffPrep.js";
import type { AdoptedTreeNode, ChangeFileRef } from "./adoptedViewModel.js";
import { changeOpenPlan } from "./changeOpenPlan.js";
import { readChangesTreeSettings } from "./changesTreeSettings.js";
import { COMMANDS, GIT_SHOW_SCHEME, VIEW_ID } from "./constants.js";
import { GitShowContentProvider } from "./gitShowContentProvider.js";
import { AdoptedFileDecorationProvider, SubmoduleTreeProvider, toVscodeUri } from "./submoduleTree.js";

const REFRESH_DEBOUNCE_MS = 300;

export interface RegisterAdoptedViewOptions {
  model: GitModelProvider & AdoptedDiffReader;
  gitApi: VsCodeGitApiAdapter;
  cli: GitCli;
  restoreStatus?: RestoreStatusStore;
}

export function registerAdoptedView(options: RegisterAdoptedViewOptions): vscode.Disposable {
  const controller = new AdoptedTreeController(
    options.model,
    (childRootPath) => options.restoreStatus?.get(childRootPath),
    () => options.gitApi.snapshotAll(),
    () =>
      readChangesTreeSettings((section, key, fallback) =>
        vscode.workspace.getConfiguration(section).get(key, fallback),
      ),
  );
  const treeProvider = new SubmoduleTreeProvider(controller);
  const decorations = new AdoptedFileDecorationProvider();
  const contentProvider = new GitShowContentProvider(options.cli);

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });

  const refresh = (): void => {
    void controller.refresh().then(() => {
      treeProvider.refresh();
      decorations.refresh();
      const count = controller.countBadge();
      treeView.badge = count > 0 ? { value: count, tooltip: `${count}` } : undefined;
    });
  };

  const scheduleRefresh = debounce(refresh, REFRESH_DEBOUNCE_MS);

  const disposables: vscode.Disposable[] = [
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(GIT_SHOW_SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorations),
    registerDailyGitActions({
      gitApi: options.gitApi,
      choreService: new SubmoduleChoreReadService(options.cli),
      refreshTree: refresh,
    }),
    vscode.commands.registerCommand(
      COMMANDS.openDiff,
      (node: AdoptedTreeNode | undefined, selected: readonly AdoptedTreeNode[] | undefined) =>
        openSelected(options.gitApi, controller, node, selected),
    ),
    vscode.commands.registerCommand(
      COMMANDS.openChange,
      (node: AdoptedTreeNode | undefined, selected: readonly AdoptedTreeNode[] | undefined) =>
        openSelected(options.gitApi, controller, node, selected),
    ),
    vscode.commands.registerCommand(COMMANDS.openFile, (node: AdoptedTreeNode | undefined) => openFile(node)),
    vscode.commands.registerCommand(COMMANDS.openHEADFile, (node: AdoptedTreeNode | undefined) =>
      openHeadFile(options.gitApi, node),
    ),
    vscode.commands.registerCommand(
      COMMANDS.openAllChanges,
      (node: AdoptedTreeNode | undefined, selected: readonly AdoptedTreeNode[] | undefined) =>
        openSelected(options.gitApi, controller, node, selected),
    ),
    options.gitApi.subscribe({
      onOpenRepository: scheduleRefresh.run,
      onCloseRepository: scheduleRefresh.run,
      onDidChangeRepository: scheduleRefresh.run,
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh.run()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("git.untrackedChanges") ||
        event.affectsConfiguration("git.alwaysShowStagedChangesResourceGroup") ||
        event.affectsConfiguration("git.countBadge") ||
        event.affectsConfiguration("git.openDiffOnClick") ||
        event.affectsConfiguration("git.showInlineOpenFileAction") ||
        event.affectsConfiguration("git.decorations.enabled") ||
        event.affectsConfiguration("scm.defaultViewMode") ||
        event.affectsConfiguration("scm.compactFolders")
      ) {
        scheduleRefresh.run();
      }
    }),
    options.restoreStatus?.subscribe(scheduleRefresh.run) ?? { dispose() {} },
    new vscode.Disposable(() => scheduleRefresh.dispose()),
  ];

  scheduleRefresh.run();

  return new vscode.Disposable(() => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
  });
}

async function openChange(gitApi: VsCodeGitApiAdapter, node: AdoptedTreeNode | undefined): Promise<void> {
  if (node?.fileDiff) {
    const prepared = prepareFileDiff(node.fileDiff);
    await vscode.commands.executeCommand(
      "vscode.diff",
      toVscodeUri(prepared.original),
      toVscodeUri(prepared.modified),
      prepared.title,
    );
    return;
  }
  if (!node?.change) {
    return;
  }
  await openChangeResource(gitApi, node.change);
}

async function openSelected(
  gitApi: VsCodeGitApiAdapter,
  controller: AdoptedTreeController,
  node: AdoptedTreeNode | undefined,
  selected: readonly AdoptedTreeNode[] | undefined,
): Promise<void> {
  if (!node) {
    return;
  }
  const nodes =
    selected && selected.length > 1 && selected.some((item) => item.id === node.id)
      ? selected
      : [node];
  for (const selectedNode of nodes) {
    if (selectedNode.fileDiff || selectedNode.change) {
      await openChange(gitApi, selectedNode);
    } else {
      await openAll(gitApi, controller, selectedNode);
    }
  }
}

async function openFile(node: AdoptedTreeNode | undefined): Promise<void> {
  const uri = node?.change?.resource.uri ?? node?.resourceUri;
  if (!uri) {
    return;
  }
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(uri));
}

async function openHeadFile(gitApi: VsCodeGitApiAdapter, node: AdoptedTreeNode | undefined): Promise<void> {
  const filePath = node?.change?.resource.originalUri;
  if (!filePath) {
    return;
  }
  await vscode.commands.executeCommand("vscode.open", gitApi.toGitUri(filePath, "HEAD"));
}

async function openAll(
  gitApi: VsCodeGitApiAdapter,
  controller: AdoptedTreeController,
  node: AdoptedTreeNode | undefined,
): Promise<void> {
  if (!node) {
    return;
  }

  const changeRefs = controller.changesForOpenAll(node);
  if (changeRefs.length > 0) {
    for (const change of changeRefs) {
      await openChangeResource(gitApi, change);
    }
  }

  const files = await controller.filesForOpenAll(node);
  if (files.length === 0) {
    return;
  }
  const prepared = prepareOpenAll(openAllTitle(node.label, files.length), files);
  const useChanges = await commandExists("vscode.changes");
  await openPreparedChanges(
    prepared.title,
    prepared.files,
    toVscodeUri,
    (command, ...args) => vscode.commands.executeCommand(command, ...args),
    useChanges,
  );
}

async function openChangeResource(gitApi: VsCodeGitApiAdapter, change: ChangeFileRef): Promise<void> {
  const plan = changeOpenPlan(change);
  const fileUri = vscode.Uri.file(change.resource.uri);
  const rightRef =
    plan.right === "index"
      ? ""
      : plan.right === "ours"
        ? "~2"
        : plan.right === "theirs"
          ? "~3"
          : "HEAD";
  const right = plan.right === "file" ? fileUri : gitApi.toGitUri(change.resource.uri, rightRef);
  if (!plan.leftRef) {
    await vscode.commands.executeCommand("vscode.open", right);
    return;
  }
  const leftPath = plan.leftPath === "original" ? change.resource.originalUri : change.resource.uri;
  const left = gitApi.toGitUri(leftPath, plan.leftRef);
  await vscode.commands.executeCommand("vscode.diff", left, right, plan.title);
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes(command);
  } catch {
    return false;
  }
}

function debounce(fn: () => void, waitMs: number): { run: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    run: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, waitMs);
    },
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

import * as vscode from "vscode";
import type { GitCli } from "../git/gitCli.js";
import type { AdoptedDiffReader, GitModelProvider } from "../git/interfaces.js";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import type { RestoreStatusStore } from "../restore/restoreStatusStore.js";
import { AdoptedTreeController } from "./adoptedTreeController.js";
import {
  openAllTitle,
  openPreparedChanges,
  prepareFileDiff,
  prepareOpenAll,
} from "./adoptedDiffPrep.js";
import type { AdoptedTreeNode } from "./adoptedViewModel.js";
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
  const controller = new AdoptedTreeController(options.model, (childRootPath) =>
    options.restoreStatus?.get(childRootPath),
  );
  const treeProvider = new SubmoduleTreeProvider(controller);
  const decorations = new AdoptedFileDecorationProvider();
  const contentProvider = new GitShowContentProvider(options.cli);

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const refresh = (): void => {
    void controller.refresh().then(() => {
      treeProvider.refresh();
      decorations.refresh();
    });
  };

  const scheduleRefresh = debounce(refresh, REFRESH_DEBOUNCE_MS);

  const disposables: vscode.Disposable[] = [
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(GIT_SHOW_SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand(COMMANDS.refresh, refresh),
    vscode.commands.registerCommand(COMMANDS.openDiff, (node: AdoptedTreeNode | undefined) => openDiff(node)),
    vscode.commands.registerCommand(COMMANDS.openAllChanges, (node: AdoptedTreeNode | undefined) =>
      openAll(controller, node),
    ),
    options.gitApi.subscribe({
      onOpenRepository: scheduleRefresh.run,
      onCloseRepository: scheduleRefresh.run,
      onDidChangeRepository: scheduleRefresh.run,
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh.run()),
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

async function openDiff(node: AdoptedTreeNode | undefined): Promise<void> {
  if (!node?.fileDiff) {
    return;
  }
  const prepared = prepareFileDiff(node.fileDiff);
  await vscode.commands.executeCommand("vscode.diff", toVscodeUri(prepared.original), toVscodeUri(prepared.modified), prepared.title);
}

async function openAll(controller: AdoptedTreeController, node: AdoptedTreeNode | undefined): Promise<void> {
  if (!node) {
    return;
  }
  const files = await controller.filesForOpenAll(node);
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

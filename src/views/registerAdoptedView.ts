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
import { changeOpenTarget } from "./changeOpenPlan.js";
import { readChangesTreeSettings, type ScmViewMode } from "./changesTreeSettings.js";
import { COMMANDS, GIT_SHOW_SCHEME, VIEW_ID } from "./constants.js";
import { GitShowContentProvider } from "./gitShowContentProvider.js";
import { AdoptedFileDecorationProvider, SubmoduleTreeProvider, toVscodeUri } from "./submoduleTree.js";

/** Coalesce bursty vscode.git events before a full gitlink/HEAD rediscovery. File overlays stay immediate. */
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
    (timings) => {
      console.debug(
        `[git-submodule] tree ${timings.usedCachedModel ? "overlay" : "discovery"} ${timings.durationMs}ms`,
      );
    },
  );
  const treeProvider = new SubmoduleTreeProvider(controller);
  const decorations = new AdoptedFileDecorationProvider();
  const contentProvider = new GitShowContentProvider(options.cli);

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });

  const render = (): void => {
    treeProvider.refresh();
    decorations.refresh();
    const count = controller.countBadge();
    treeView.badge = count > 0 ? { value: count, tooltip: `${count}` } : undefined;
  };

  const overlayRefresh = coalesce(() => {
    void controller.refresh().then(render);
  });

  const scheduleDiscovery = debounce(() => {
    controller.invalidateModel();
    overlayRefresh.run();
  }, REFRESH_DEBOUNCE_MS);

  const disposables: vscode.Disposable[] = [
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(GIT_SHOW_SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorations),
    registerDailyGitActions({
      gitApi: options.gitApi,
      choreService: new SubmoduleChoreReadService(options.cli),
      refreshTree: overlayRefresh.run,
      beforeRefreshCommand: () => controller.invalidateModel(),
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
    vscode.commands.registerCommand(COMMANDS.viewAsTree, () => setScmViewMode("tree")),
    vscode.commands.registerCommand(COMMANDS.viewAsList, () => setScmViewMode("list")),
    options.gitApi.subscribe({
      onOpenRepository: scheduleDiscovery.run,
      onCloseRepository: scheduleDiscovery.run,
      onDidChangeRepositoryState: (snapshot) => {
        if (controller.consumeRepositoryState(snapshot)) {
          scheduleDiscovery.run();
        }
        overlayRefresh.run();
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleDiscovery.run()),
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
        syncViewModeContext();
        overlayRefresh.run();
      }
    }),
    options.restoreStatus?.subscribe(overlayRefresh.run) ?? { dispose() {} },
    new vscode.Disposable(() => {
      overlayRefresh.dispose();
      scheduleDiscovery.dispose();
    }),
  ];

  syncViewModeContext();
  overlayRefresh.run();

  return new vscode.Disposable(() => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
  });
}

function currentViewMode(): ScmViewMode {
  return readChangesTreeSettings((section, key, fallback) =>
    vscode.workspace.getConfiguration(section).get(key, fallback),
  ).viewMode;
}

function syncViewModeContext(): void {
  void vscode.commands.executeCommand("setContext", "gitSubmodule.viewMode", currentViewMode());
}

async function setScmViewMode(mode: ScmViewMode): Promise<void> {
  await vscode.workspace.getConfiguration("scm").update("defaultViewMode", mode, vscode.ConfigurationTarget.Workspace);
  syncViewModeContext();
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
  const target = changeOpenTarget(change);
  const right = toVscodeChangeUri(gitApi, target.right);
  if (target.command === "vscode.open" || !target.left) {
    await vscode.commands.executeCommand("vscode.open", right, { preview: true }, target.title);
    return;
  }
  const left = toVscodeChangeUri(gitApi, target.left);
  await vscode.commands.executeCommand("vscode.diff", left, right, target.title);
}

function toVscodeChangeUri(
  gitApi: VsCodeGitApiAdapter,
  side: { kind: "file" | "git"; fsPath: string; ref?: string },
): vscode.Uri {
  // Uri.file keeps `#` / `?` in the path; Uri.parse('file://' + fsPath) would treat them as fragment/query.
  return side.kind === "file" ? vscode.Uri.file(side.fsPath) : gitApi.toGitUri(side.fsPath, side.ref ?? "");
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes(command);
  } catch {
    return false;
  }
}

function coalesce(fn: () => void): { run: () => void; dispose: () => void } {
  let scheduled = false;
  let disposed = false;
  return {
    run: () => {
      if (disposed || scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!disposed) {
          fn();
        }
      });
    },
    dispose: () => {
      disposed = true;
    },
  };
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

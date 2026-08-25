import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import { commitMessagePlaceholder } from "../scm/dailyGitActions.js";
import { isPublicCommitMessageTargetSupported } from "../scm/generateCommitMessage.js";
import type { AdoptedCountPatch, AdoptedTreeController } from "./adoptedTreeController.js";
import { buildBootstrapRepoNodes, treeItemCommand, type AdoptedTreeNode } from "./adoptedViewModel.js";
import { type RowActionConfig, contextActions } from "./changesRowActions.js";
import { readChangesTreeSettings, type ChangesTreeSettings } from "./changesTreeSettings.js";
import {
  changesWebviewErrorHtml,
  changesWebviewLoadingHtml,
  changesWebviewPage,
  renderChangesTree,
  toChangesWebviewRows,
  UNSUPPORTED_COMMIT_MESSAGE_TOOLTIP,
} from "./changesWebviewHtml.js";
import {
  ChangesRenderProtocol,
  type ChangesRenderState,
  type ChangesRenderVersion,
} from "./changesRenderProtocol.js";
import { COMMANDS, VIEW_ID } from "./constants.js";
import { PACKAGED_CODICONS_SEGMENTS } from "./codiconsAssets.js";
import {
  fileIconWebviewSrc,
  loadActiveFileIconTheme,
  type LoadedFileIconTheme,
} from "./fileIconThemeHost.js";
import {
  formatAdoptedCountBatch,
  formatAdoptedExpansion,
  formatChangesLoadSummary,
  type ChangesDiagnosticWriter,
  type ChangesLoadReason,
  type ChangesLoadResult,
} from "./changesLoadDiagnostics.js";
import {
  BootstrapPostGuard,
  ChangesRefreshCoordinator,
  type ChangesRefreshBatch,
  formatChangesRefreshEvents,
} from "./changesRefreshCoordinator.js";

export interface ChangesWebviewProviderOptions {
  controller: AdoptedTreeController;
  gitApi: VsCodeGitApiAdapter;
  extensionUri: vscode.Uri;
  writeDiagnostic: ChangesDiagnosticWriter;
  getGenerateCommitMessageCommand?(): string | undefined;
}

type WebviewMessage =
  | ({ type: "ready" } & ChangesRenderVersion)
  | ({ type: "rendered" } & ChangesRenderVersion)
  | { type: "retry" }
  | { type: "retryAdopted"; id: string }
  | { type: "toggle"; id: string }
  | { type: "click"; id: string; additive?: boolean }
  | { type: "branch"; id: string }
  | { type: "command"; command: string; id: string; additive?: boolean }
  | { type: "commit"; id: string; message: string }
  | { type: "generate"; id: string }
  | { type: "explainGenerate"; id: string }
  | { type: "draft"; rootPath: string; value: string }
  | { type: "context"; id: string };

export class ChangesWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly expansion = new Map<string, boolean>();
  private readonly selected = new Set<string>();
  private readonly nodes = new Map<string, AdoptedTreeNode>();
  private htmlReady = false;
  private lastTreeHtml: string | undefined;
  private lastRoots: AdoptedTreeNode[] = [];
  private readonly renderProtocol = new ChangesRenderProtocol();
  private readonly adoptedCountPatches = new Map<string, AdoptedCountEnvelope>();
  private latestRender: RenderEnvelope | undefined;
  private progressCompletion: { generation: number; resolve: () => void } | undefined;
  private renderTiming: RenderTiming | undefined;
  private renderCompletion: { generation: number; promise: Promise<void>; resolve: () => void } | undefined;
  private pendingBootstrapTiming: BootstrapTiming | undefined;
  private readonly bootstrapPostGuard = new BootstrapPostGuard();
  private readonly refreshCoordinator: ChangesRefreshCoordinator;
  private fileIcons: LoadedFileIconTheme | undefined;

  constructor(private readonly options: ChangesWebviewProviderOptions) {
    this.refreshCoordinator = new ChangesRefreshCoordinator((batch) => this.runRefresh(batch));
    void this.reloadFileIcons();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.htmlReady = false;
    this.applyWebviewRoots(webviewView);
    const nonce = crypto.randomBytes(16).toString("hex");
    const immediate = this.lastTreeHtml ? emptyImmediatePaint() : this.nodesForImmediatePaint();
    const serializationStarted = performance.now();
    const rootHtml =
      this.lastTreeHtml ?? (immediate.nodes ? this.renderTreeHtml(immediate.nodes, false) : changesWebviewLoadingHtml());
    const version = this.renderProtocol.version();
    const bootstrapTiming = this.lastTreeHtml
      ? undefined
      : {
          bootstrapSnapshotMs: immediate.snapshotMs,
          bootstrapTreeMs: immediate.treeBuildMs,
          serializationMs: performance.now() - serializationStarted,
          bootstrapPostMs: 0,
        };
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.onMessage(message);
    });
    webviewView.onDidChangeVisibility(() => {
      if (this.view === webviewView && webviewView.visible) {
        this.htmlReady = true;
        this.refresh("view visible", false);
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.htmlReady = false;
        this.renderCompletion?.resolve();
        this.finishProgress();
      }
    });
    // Install listeners before assigning HTML: the page can post `ready` synchronously while loading.
    const bootstrapPostStarted = performance.now();
    webviewView.webview.html = changesWebviewPage({
      nonce,
      cspSource: webviewView.webview.cspSource,
      codiconCssHref: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.codiconsDir(), "codicon.css")).toString(),
      rootHtml,
      ...version,
    });
    if (bootstrapTiming && this.bootstrapPostGuard.claim()) {
      bootstrapTiming.bootstrapPostMs = performance.now() - bootstrapPostStarted;
      this.recordBootstrapTiming(bootstrapTiming);
    }
    this.refresh("view resolve", false);
  }

  async reloadFileIcons(): Promise<void> {
    this.fileIcons = await loadActiveFileIconTheme();
    if (this.view) {
      this.applyWebviewRoots(this.view);
      this.refresh("file icon theme", false);
    }
  }

  refresh(
    reason: ChangesLoadReason = "explicit refresh",
    rediscover: boolean | (() => boolean) = reason === "explicit refresh",
  ): void {
    this.refreshCoordinator.request({
      reason,
      rediscover: typeof rediscover === "boolean" ? rediscover : false,
      shouldRediscover: typeof rediscover === "function" ? rediscover : undefined,
      immediate: reason === "explicit refresh" || reason === "retry",
    });
  }

  dispose(): void {
    this.refreshCoordinator.dispose();
    this.renderCompletion?.resolve();
    this.finishProgress();
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.htmlReady = true;
        await this.sendLatestRender();
        return;
      case "rendered":
        if (this.renderProtocol.acknowledge(message)) {
          this.logRenderTiming(message.generation);
          if (this.renderCompletion?.generation === message.generation) {
            this.renderCompletion.resolve();
          }
        }
        return;
      case "retry": {
        this.refresh("retry", true);
        return;
      }
      case "retryAdopted":
        await this.retryAdoptedCount(message.id);
        return;
      case "toggle":
        await this.toggle(message.id);
        return;
      case "click":
        await this.onClick(message.id, Boolean(message.additive));
        return;
      case "branch":
        await this.runCommand(COMMANDS.checkoutBranch, message.id, false);
        return;
      case "command":
        await this.runCommand(message.command, message.id, Boolean(message.additive));
        return;
      case "commit":
        await this.commit(message.id, message.message);
        return;
      case "generate":
        await this.runCommand(COMMANDS.generateSubmoduleChore, message.id, false);
        return;
      case "explainGenerate":
        void vscode.window.showInformationMessage(UNSUPPORTED_COMMIT_MESSAGE_TOOLTIP);
        return;
      case "draft":
        this.writeDraft(message.rootPath, message.value);
        return;
      case "context":
        await this.showContext(message.id);
        return;
    }
  }

  private async onClick(id: string, additive: boolean): Promise<void> {
    if (additive) {
      if (this.selected.has(id)) {
        this.selected.delete(id);
      } else {
        this.selected.add(id);
      }
    } else {
      this.selected.clear();
      this.selected.add(id);
    }
    const node = this.nodes.get(id);
    if (!additive && node && node.kind !== "workspace-root" && node.kind !== "submodule") {
      const command = treeItemCommand(node);
      if (command) {
        await vscode.commands.executeCommand(command.command, ...command.arguments);
      }
    }
    await this.repaint();
  }

  private async commit(id: string, message: string): Promise<void> {
    const node = this.nodes.get(id);
    const rootPath = node?.repositoryRoot;
    if (!rootPath) {
      return;
    }
    this.writeDraft(rootPath, message);
    await vscode.commands.executeCommand(COMMANDS.commit, node);
  }

  private writeDraft(rootPath: string, value: string): void {
    const handle = this.options.gitApi.getRepositoryHandle(rootPath);
    if (handle) {
      handle.inputBoxValue = value;
    }
  }

  private async runCommand(command: string, id: string, additive: boolean): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      return;
    }
    await vscode.commands.executeCommand(command, node, this.selectedNodes(id, additive));
  }

  private selectedNodes(id: string, additive: boolean): AdoptedTreeNode[] {
    if (!additive && this.selected.size <= 1) {
      const node = this.nodes.get(id);
      return node ? [node] : [];
    }
    if (!this.selected.has(id)) {
      this.selected.add(id);
    }
    return [...this.selected]
      .map((selectedId) => this.nodes.get(selectedId))
      .filter((node): node is AdoptedTreeNode => Boolean(node));
  }

  private async showContext(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      return;
    }
    const actions = contextActions(node.contextValue, this.rowConfig());
    if (actions.length === 0) {
      return;
    }
    const picked = await vscode.window.showQuickPick(
      actions.map((action) => ({ label: action.title, description: action.command, action })),
      { placeHolder: node.label },
    );
    if (picked) {
      await vscode.commands.executeCommand(picked.action.command, node, this.selectedNodes(id, true));
    }
  }

  private beginLoad(batch: ChangesRefreshBatch): ChangesRenderVersion {
    const version = this.renderProtocol.begin(this.lastTreeHtml ? "loading" : "bootstrap");
    this.adoptedCountPatches.clear();
    this.latestRender = undefined;
    const bootstrap = this.pendingBootstrapTiming ?? emptyBootstrapTiming();
    this.pendingBootstrapTiming = undefined;
    this.renderTiming = {
      generation: version.generation,
      startedAt: batch.requestedAt,
      reason: batch.reason,
      inFlightWaitMs: batch.inFlightWaitMs,
      eventSummary: formatChangesRefreshEvents(batch.eventCounts),
      hasFollowUp: batch.hasFollowUp,
      bootstrapSnapshotMs: bootstrap.bootstrapSnapshotMs,
      bootstrapTreeMs: bootstrap.bootstrapTreeMs,
      serializationMs: bootstrap.serializationMs,
      bootstrapPostMs: bootstrap.bootstrapPostMs,
      finalPostMs: 0,
      renderAckMs: 0,
      discoveryMs: 0,
      treeBuildMs: 0,
      logged: false,
    };
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.renderCompletion = { generation: version.generation, promise, resolve };
    this.startProgress(version.generation);
    return version;
  }

  private async runRefresh(batch: ChangesRefreshBatch): Promise<void> {
    const version = this.beginLoad(batch);
    if (batch.rediscover) {
      this.options.controller.invalidateModel();
    }
    await this.options.controller.refresh(primaryReason(batch.eventCounts));
    const view = this.view;
    if (!view || !this.isCurrentRender(version.generation, view)) {
      this.renderCompletion?.resolve();
      this.finishProgress(version.generation);
      return;
    }
    await this.completeRender(version.generation, view);
    if (this.renderCompletion?.generation === version.generation) {
      await this.renderCompletion.promise;
    }
    if (!this.refreshCoordinator.hasPendingRefresh()) {
      this.finishProgress(version.generation);
    }
  }

  private recordBootstrapTiming(bootstrap: BootstrapTiming): void {
    const timing = this.renderTiming;
    if (timing && this.renderProtocol.isPending()) {
      timing.bootstrapSnapshotMs += bootstrap.bootstrapSnapshotMs;
      timing.bootstrapTreeMs += bootstrap.bootstrapTreeMs;
      timing.serializationMs += bootstrap.serializationMs;
      timing.bootstrapPostMs += bootstrap.bootstrapPostMs;
      return;
    }
    this.pendingBootstrapTiming = bootstrap;
  }

  private async completeRender(generation: number, view: vscode.WebviewView): Promise<void> {
    try {
      const roots = await this.options.controller.getRootNodes();
      if (!this.isCurrentRender(generation, view)) {
        return;
      }
      const rootError = this.options.controller.rootLoadError();
      const rootTiming = this.options.controller.rootTiming();
      if (this.renderTiming?.generation === generation && rootTiming) {
        this.renderTiming.startedAt = Math.min(this.renderTiming.startedAt, rootTiming.startedAt);
        this.renderTiming.discoveryMs = rootTiming.modelDiscoveryMs;
        this.renderTiming.treeBuildMs = rootTiming.treeBuildMs;
      }
      if (rootError) {
        if (this.renderTiming?.generation === generation) {
          this.renderTiming.errorPhase = "recursive discovery";
          this.renderTiming.errorMessage = rootError;
        }
        await this.publishRender(generation, "error", changesWebviewErrorHtml(rootError));
        return;
      }
      const count = this.options.controller.countBadge();
      view.badge = count > 0 ? { value: count, tooltip: `${count}` } : undefined;
      const html = this.measureSerialization(generation, () => this.renderTreeHtml(roots, true));
      await this.publishRender(generation, "final", html);
      void this.hydrateAdoptedCounts(generation, view, roots);
      void this.hydrateExpandedAdopted(generation, view, roots);
    } catch (error) {
      if (!this.isCurrentRender(generation, view)) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (this.renderTiming?.generation === generation) {
        this.renderTiming.errorPhase = "tree load";
        this.renderTiming.errorMessage = detail;
      }
      await this.publishRender(generation, "error", changesWebviewErrorHtml(detail));
    }
  }

  private async toggle(id: string): Promise<void> {
    const node = this.nodes.get(id);
    const expanded = !this.isExpanded(node);
    this.expansion.set(id, expanded);
    if (expanded && node?.diffSpec && node.kind === "adopted-group" && this.view && this.lastRoots.length > 0) {
      const version = this.renderProtocol.version();
      const expansionStarted = performance.now();
      const cacheHit = this.options.controller.hasCachedFiles(node);
      const html = this.measureSerialization(version.generation, () => this.renderTreeHtml(this.lastRoots, true));
      await this.publishRender(version.generation, version.renderState, html);
      await this.hydrateExpandedAdopted(version.generation, this.view, this.lastRoots, {
        nodeId: node.id,
        startedAt: expansionStarted,
        cacheHit,
      });
      return;
    }
    await this.repaint();
  }

  private async repaint(): Promise<void> {
    if (!this.view || this.lastRoots.length === 0) {
      this.refresh();
      return;
    }
    const version = this.renderProtocol.version();
    const html = this.measureSerialization(version.generation, () => this.renderTreeHtml(this.lastRoots, true));
    await this.publishRender(version.generation, version.renderState, html);
  }

  private nodesForImmediatePaint(): ImmediatePaint {
    const peek = this.options.controller.peekRoots();
    if (peek && peek.length > 0) {
      return { nodes: peek, snapshotMs: 0, treeBuildMs: 0 };
    }
    const snapshotStarted = Date.now();
    const snapshots = this.options.gitApi.snapshotAll();
    const workspaceFolders = this.options.gitApi.getWorkspaceFolderPaths();
    const snapshotMs = Date.now() - snapshotStarted;
    const treeStarted = Date.now();
    const bootstrap = buildBootstrapRepoNodes(
      snapshots,
      workspaceFolders,
      this.treeSettings(),
    );
    return {
      nodes: bootstrap.length > 0 ? bootstrap : undefined,
      snapshotMs,
      treeBuildMs: Date.now() - treeStarted,
    };
  }

  private renderTreeHtml(roots: AdoptedTreeNode[], final: boolean): string {
    this.nodes.clear();
    this.indexNodes(roots);
    this.applyDefaultExpansion(roots);
    const html = renderChangesTree(
      toChangesWebviewRows(roots, {
        expanded: this.expandedSet(),
        selected: this.selected,
        drafts: this.readDrafts(),
        placeholders: this.readPlaceholders(),
        generateCommitMessageSupportedRoots: this.generateCommitMessageSupportedRoots(),
        fileIconSrc: this.fileIconSrcBound(),
        config: this.rowConfig(),
      }),
    );
    if (final) {
      this.lastRoots = roots;
      this.lastTreeHtml = html;
    }
    return html;
  }

  private async publishRender(
    generation: number,
    renderState: ChangesRenderState,
    html: string,
  ): Promise<void> {
    const version = { generation, renderState };
    if (!this.renderProtocol.advance(version)) {
      return;
    }
    this.latestRender = { type: "setTree", html, ...version };
    if (renderState === "final" || renderState === "error") {
      if (this.renderTiming?.generation === generation) {
        this.renderTiming.finalPublishedAt = performance.now();
      }
    }
    await this.sendLatestRender();
  }

  private async sendLatestRender(): Promise<void> {
    const view = this.view;
    const render = this.latestRender;
    if (!view || !this.htmlReady || !render) {
      return;
    }
    const postStarted = performance.now();
    const accepted = await view.webview.postMessage(render);
    if (this.renderTiming?.generation === render.generation) {
      const postMs = performance.now() - postStarted;
      if (render.renderState === "loading" || render.renderState === "bootstrap") {
        this.renderTiming.bootstrapPostMs += postMs;
      } else {
        this.renderTiming.finalPostMs += postMs;
      }
      if (render.renderState === "final" || render.renderState === "error") {
        this.renderTiming.finalPostAt = performance.now();
      }
    }
    if (!accepted) {
      this.htmlReady = false;
      return;
    }
    await this.sendAdoptedCountPatches(render.generation, view);
  }

  private isCurrentRender(generation: number, view: vscode.WebviewView): boolean {
    return this.renderProtocol.isCurrent(generation) && this.view === view;
  }

  private async hydrateAdoptedCounts(
    generation: number,
    view: vscode.WebviewView,
    roots: AdoptedTreeNode[],
  ): Promise<void> {
    const timing = await this.options.controller.hydrateAdoptedCounts(roots, (patch) => {
      void this.publishAdoptedCountPatch(generation, view, patch);
    });
    this.options.writeDiagnostic(formatAdoptedCountBatch({ generation, ...timing }));
  }

  private async retryAdoptedCount(id: string): Promise<void> {
    const view = this.view;
    const node = this.nodes.get(id);
    if (!view || !node || node.kind !== "adopted-group") {
      return;
    }
    const generation = this.renderProtocol.version().generation;
    await this.publishAdoptedCountPatch(generation, view, { id, state: "loading" });
    const patch = await this.options.controller.retryAdoptedCount(node);
    if (patch) {
      await this.publishAdoptedCountPatch(generation, view, patch);
    }
  }

  private async publishAdoptedCountPatch(
    generation: number,
    view: vscode.WebviewView,
    patch: AdoptedCountPatch,
  ): Promise<void> {
    if (!this.isCurrentRender(generation, view)) {
      return;
    }
    const envelope: AdoptedCountEnvelope = { type: "adoptedCount", generation, ...patch };
    this.adoptedCountPatches.set(patch.id, envelope);
    applyAdoptedCountPatch(this.lastRoots, patch);
    const indexed = this.nodes.get(patch.id);
    if (indexed) {
      applyAdoptedCountPatch([indexed], patch);
    }
    if (!this.htmlReady) {
      return;
    }
    if (!(await view.webview.postMessage(envelope))) {
      this.htmlReady = false;
    }
  }

  private async sendAdoptedCountPatches(generation: number, view: vscode.WebviewView): Promise<void> {
    for (const patch of this.adoptedCountPatches.values()) {
      if (!this.isCurrentRender(generation, view) || patch.generation !== generation) {
        return;
      }
      if (!(await view.webview.postMessage(patch))) {
        this.htmlReady = false;
        return;
      }
    }
  }

  private startProgress(generation: number): void {
    if (this.progressCompletion) {
      this.progressCompletion.generation = generation;
      return;
    }
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    this.progressCompletion = { generation, resolve };
    void vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () => completion);
  }

  private finishProgress(generation?: number): void {
    if (!this.progressCompletion || (generation !== undefined && this.progressCompletion.generation !== generation)) {
      return;
    }
    this.progressCompletion.resolve();
    this.progressCompletion = undefined;
  }

  private codiconsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.options.extensionUri, ...PACKAGED_CODICONS_SEGMENTS);
  }

  private applyWebviewRoots(view: vscode.WebviewView): void {
    const roots = [this.codiconsDir()];
    if (this.fileIcons) {
      roots.push(this.fileIcons.extensionUri);
    }
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: roots,
    };
  }

  private fileIconSrcBound(): ((node: AdoptedTreeNode, expanded: boolean) => string | undefined) | undefined {
    const view = this.view;
    const loaded = this.fileIcons;
    if (!view || !loaded) {
      return undefined;
    }
    return (node, expanded) => fileIconWebviewSrc(loaded, view.webview, node, expanded);
  }

  private treeSettings(): ChangesTreeSettings {
    return readChangesTreeSettings((section, key, fallback) =>
      vscode.workspace.getConfiguration(section).get(key, fallback),
    );
  }

  private async hydrate(nodes: AdoptedTreeNode[]): Promise<AdoptedTreeNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        let current = node;
        if (
          this.isExpanded(node) &&
          node.diffSpec &&
          (node.kind === "staged" || node.kind === "unstaged" || node.kind === "adopted-group")
        ) {
          current = { ...node, children: await this.options.controller.getChildren(node) };
        }
        return { ...current, children: await this.hydrate(current.children) };
      }),
    );
  }

  private async hydrateExpandedAdopted(
    generation: number,
    view: vscode.WebviewView,
    roots: AdoptedTreeNode[],
    expansion?: { nodeId: string; startedAt: number; cacheHit: boolean },
  ): Promise<void> {
    if (!this.hasExpandedAdopted(roots)) {
      return;
    }
    const hydrated = await this.hydrate(roots);
    if (!this.isCurrentRender(generation, view)) {
      if (expansion) {
        this.options.writeDiagnostic(
          formatAdoptedExpansion({
            generation,
            durationMs: performance.now() - expansion.startedAt,
            fileCount: 0,
            cacheHit: expansion.cacheHit,
            ok: false,
          }),
        );
      }
      return;
    }
    if (expansion) {
      const expanded = findNode(hydrated, expansion.nodeId);
      this.options.writeDiagnostic(
        formatAdoptedExpansion({
          generation,
          durationMs: performance.now() - expansion.startedAt,
          fileCount: expanded ? countFileNodes(expanded.children) : 0,
          cacheHit: expansion.cacheHit,
          ok: true,
        }),
      );
    }
    const html = this.measureSerialization(generation, () => this.renderTreeHtml(hydrated, true));
    await this.publishRender(generation, "final", html);
  }

  private hasExpandedAdopted(nodes: readonly AdoptedTreeNode[]): boolean {
    return nodes.some(
      (node) =>
        (node.kind === "adopted-group" && Boolean(node.diffSpec) && this.isExpanded(node)) ||
        this.hasExpandedAdopted(node.children),
    );
  }

  private measureSerialization<T>(generation: number, serialize: () => T): T {
    const started = performance.now();
    const result = serialize();
    if (this.renderTiming?.generation === generation) {
      this.renderTiming.serializationMs += performance.now() - started;
    }
    return result;
  }

  private logRenderTiming(generation: number): void {
    const timing = this.renderTiming;
    if (!timing || timing.generation !== generation) {
      return;
    }
    const now = performance.now();
    timing.renderAckMs = timing.finalPostAt === undefined ? 0 : now - timing.finalPostAt;
    const state = this.renderProtocol.version().renderState;
    this.writeLoadSummary(timing, state === "error" ? "error" : "final", now);
  }

  private writeLoadSummary(timing: RenderTiming, result: ChangesLoadResult, finishedAt: number): void {
    if (timing.logged) {
      return;
    }
    timing.logged = true;
    const totalMs = finishedAt - timing.startedAt;
    const measuredMs =
      timing.inFlightWaitMs +
      timing.bootstrapSnapshotMs +
      timing.bootstrapTreeMs +
      timing.bootstrapPostMs +
      timing.discoveryMs +
      timing.treeBuildMs +
      timing.serializationMs +
      timing.finalPostMs +
      timing.renderAckMs;
    this.options.writeDiagnostic(
      formatChangesLoadSummary({
        generation: timing.generation,
        reason: timing.reason,
        result,
        totalMs,
        queuedCoalescedMs: Math.max(0, totalMs - measuredMs),
        inFlightWaitMs: timing.inFlightWaitMs,
        eventSummary: timing.eventSummary,
        followUp: timing.hasFollowUp(),
        bootstrapSnapshotMs: timing.bootstrapSnapshotMs,
        bootstrapBuildMs: timing.bootstrapTreeMs,
        bootstrapPostMs: timing.bootstrapPostMs,
        discoveryMs: timing.discoveryMs,
        treeBuildMs: timing.treeBuildMs,
        serializationMs: timing.serializationMs,
        finalPostMs: timing.finalPostMs,
        renderAckMs: timing.renderAckMs,
        errorPhase: timing.errorPhase,
        errorMessage: timing.errorMessage,
      }),
    );
  }

  private indexNodes(nodes: readonly AdoptedTreeNode[]): void {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.indexNodes(node.children);
    }
  }

  private applyDefaultExpansion(nodes: readonly AdoptedTreeNode[]): void {
    for (const node of nodes) {
      if (!this.expansion.has(node.id) && node.expandByDefault) {
        this.expansion.set(node.id, true);
      }
      this.applyDefaultExpansion(node.children);
    }
  }

  private isExpanded(node: AdoptedTreeNode | undefined): boolean {
    if (!node?.collapsible) {
      return false;
    }
    return this.expansion.get(node.id) ?? node.expandByDefault;
  }

  private expandedSet(): Set<string> {
    const ids = new Set<string>();
    for (const node of this.nodes.values()) {
      if (this.isExpanded(node)) {
        ids.add(node.id);
      }
    }
    return ids;
  }

  private readDrafts(): Map<string, string> {
    const drafts = new Map<string, string>();
    for (const repository of this.options.gitApi.getOpenRepositories()) {
      drafts.set(repository.rootPath, repository.inputBoxValue);
    }
    return drafts;
  }

  private readPlaceholders(): Map<string, string> {
    const placeholders = new Map<string, string>();
    for (const repository of this.options.gitApi.getOpenRepositories()) {
      placeholders.set(repository.rootPath, commitMessagePlaceholder(repository.snapshot().head?.name));
    }
    return placeholders;
  }

  private generateCommitMessageSupportedRoots(): Set<string> {
    const repositories = this.options.gitApi.getOpenRepositories();
    const command = this.options.getGenerateCommitMessageCommand?.();
    return new Set(
      repositories
        .filter((repository) =>
          isPublicCommitMessageTargetSupported(repositories, repository.rootPath, command),
        )
        .map((repository) => repository.rootPath),
    );
  }

  private rowConfig(): RowActionConfig {
    const settings = this.treeSettings();
    return {
      untrackedChanges: settings.untrackedChanges,
      showInlineOpenFileAction: settings.showInlineOpenFileAction,
      openDiffOnClick: settings.openDiffOnClick,
    };
  }
}

interface RenderEnvelope extends ChangesRenderVersion {
  type: "setTree";
  html: string;
}

type AdoptedCountEnvelope = AdoptedCountPatch & {
  type: "adoptedCount";
  generation: number;
};

interface ImmediatePaint {
  nodes?: AdoptedTreeNode[];
  snapshotMs: number;
  treeBuildMs: number;
}

interface RenderTiming {
  generation: number;
  startedAt: number;
  reason: string;
  inFlightWaitMs: number;
  eventSummary: string;
  hasFollowUp: () => boolean;
  bootstrapSnapshotMs: number;
  bootstrapTreeMs: number;
  serializationMs: number;
  bootstrapPostMs: number;
  discoveryMs: number;
  treeBuildMs: number;
  finalPostMs: number;
  renderAckMs: number;
  finalPublishedAt?: number;
  finalPostAt?: number;
  errorPhase?: string;
  errorMessage?: string;
  logged: boolean;
}

interface BootstrapTiming {
  bootstrapSnapshotMs: number;
  bootstrapTreeMs: number;
  serializationMs: number;
  bootstrapPostMs: number;
}

function emptyImmediatePaint(): ImmediatePaint {
  return { snapshotMs: 0, treeBuildMs: 0 };
}

function emptyBootstrapTiming(): BootstrapTiming {
  return {
    bootstrapSnapshotMs: 0,
    bootstrapTreeMs: 0,
    serializationMs: 0,
    bootstrapPostMs: 0,
  };
}

function primaryReason(counts: ReadonlyMap<ChangesLoadReason, number>): ChangesLoadReason {
  return counts.keys().next().value ?? "explicit refresh";
}

function applyAdoptedCountPatch(nodes: readonly AdoptedTreeNode[], patch: AdoptedCountPatch): boolean {
  for (const node of nodes) {
    if (node.id === patch.id) {
      if (patch.state === "resolved") {
        node.description = String(patch.count);
        node.adoptedCountError = undefined;
      } else if (patch.state === "error") {
        node.description = undefined;
        node.adoptedCountError = patch.message;
      } else {
        node.description = undefined;
        node.adoptedCountError = undefined;
      }
      return true;
    }
    if (applyAdoptedCountPatch(node.children, patch)) {
      return true;
    }
  }
  return false;
}

function findNode(nodes: readonly AdoptedTreeNode[], id: string): AdoptedTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const child = findNode(node.children, id);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function countFileNodes(nodes: readonly AdoptedTreeNode[]): number {
  return nodes.reduce(
    (count, node) => count + (node.kind === "file" ? 1 : 0) + countFileNodes(node.children),
    0,
  );
}

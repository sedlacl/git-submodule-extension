import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import { commitMessagePlaceholder } from "../scm/dailyGitActions.js";
import type { AdoptedTreeController } from "./adoptedTreeController.js";
import { buildBootstrapRepoNodes, treeItemCommand, type AdoptedTreeNode } from "./adoptedViewModel.js";
import { type RowActionConfig, contextActions } from "./changesRowActions.js";
import { readChangesTreeSettings, type ChangesTreeSettings } from "./changesTreeSettings.js";
import {
  changesWebviewErrorHtml,
  changesWebviewLoadingHtml,
  changesWebviewPage,
  renderChangesTree,
  toChangesWebviewRows,
} from "./changesWebviewHtml.js";
import {
  ChangesRenderProtocol,
  type ChangesRenderState,
  type ChangesRenderVersion,
} from "./changesRenderProtocol.js";
import { COMMANDS, VIEW_ID } from "./constants.js";

export interface ChangesWebviewProviderOptions {
  controller: AdoptedTreeController;
  gitApi: VsCodeGitApiAdapter;
  extensionUri: vscode.Uri;
}

type WebviewMessage =
  | ({ type: "ready" } & ChangesRenderVersion)
  | ({ type: "rendered" } & ChangesRenderVersion)
  | { type: "retry" }
  | { type: "toggle"; id: string }
  | { type: "click"; id: string; additive?: boolean }
  | { type: "branch"; id: string }
  | { type: "command"; command: string; id: string; additive?: boolean }
  | { type: "commit"; id: string; message: string }
  | { type: "generate"; id: string }
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
  private latestRender: RenderEnvelope | undefined;
  private progressCompletion: { generation: number; resolve: () => void } | undefined;
  private renderTiming: RenderTiming | undefined;

  constructor(private readonly options: ChangesWebviewProviderOptions) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.htmlReady = false;
    const dist = vscode.Uri.joinPath(this.options.extensionUri, "node_modules", "@vscode", "codicons", "dist");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [dist],
    };
    const nonce = crypto.randomBytes(16).toString("hex");
    const startedAt = Date.now();
    const immediate = this.lastTreeHtml ? emptyImmediatePaint() : this.nodesForImmediatePaint();
    const serializationStarted = Date.now();
    const rootHtml =
      this.lastTreeHtml ?? (immediate.nodes ? this.renderTreeHtml(immediate.nodes, false) : changesWebviewLoadingHtml());
    const version = this.beginRender(
      rootHtml === changesWebviewLoadingHtml() ? "loading" : "bootstrap",
      rootHtml,
      {
        startedAt,
        bootstrapSnapshotMs: immediate.snapshotMs,
        bootstrapTreeMs: immediate.treeBuildMs,
        serializationMs: Date.now() - serializationStarted,
      },
    );
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.onMessage(message);
    });
    webviewView.onDidChangeVisibility(() => {
      if (this.view === webviewView && webviewView.visible) {
        this.htmlReady = true;
        void this.sendLatestRender();
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.htmlReady = false;
        this.finishProgress();
      }
    });
    // Install listeners before assigning HTML: the page can post `ready` synchronously while loading.
    webviewView.webview.html = changesWebviewPage({
      nonce,
      cspSource: webviewView.webview.cspSource,
      codiconCssHref: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(dist, "codicon.css")).toString(),
      rootHtml,
      ...version,
    });
    void this.completeRender(version.generation, webviewView);
  }

  refresh(): void {
    const view = this.view;
    if (!view) {
      void this.options.controller.getRootNodes();
      return;
    }
    const startedAt = Date.now();
    const immediate = this.lastTreeHtml ? emptyImmediatePaint() : this.nodesForImmediatePaint();
    const serializationStarted = Date.now();
    const html =
      this.lastTreeHtml ??
      (immediate.nodes ? this.renderTreeHtml(immediate.nodes, false) : changesWebviewLoadingHtml());
    const version = this.beginRender(html === changesWebviewLoadingHtml() ? "loading" : "bootstrap", html, {
      startedAt,
      bootstrapSnapshotMs: immediate.snapshotMs,
      bootstrapTreeMs: immediate.treeBuildMs,
      serializationMs: Date.now() - serializationStarted,
    });
    void this.sendLatestRender();
    void this.completeRender(version.generation, view);
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.htmlReady = true;
        await this.sendLatestRender();
        return;
      case "rendered":
        if (this.renderProtocol.acknowledge(message)) {
          this.finishProgress(message.generation);
          this.logRenderTiming(message.generation);
        }
        return;
      case "retry": {
        this.options.controller.invalidateModel();
        const loading = this.options.controller.refresh();
        this.refresh();
        await loading;
        return;
      }
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

  private beginRender(
    renderState: "loading" | "bootstrap",
    html: string,
    timing: Omit<RenderTiming, "generation" | "postMs">,
  ): ChangesRenderVersion {
    const version = this.renderProtocol.begin(renderState);
    this.latestRender = { type: "setTree", html, ...version };
    this.renderTiming = { generation: version.generation, postMs: 0, ...timing };
    this.startProgress(version.generation);
    return version;
  }

  private async completeRender(generation: number, view: vscode.WebviewView): Promise<void> {
    try {
      const roots = await this.options.controller.getRootNodes();
      if (!this.isCurrentRender(generation, view)) {
        return;
      }
      const rootError = this.options.controller.rootLoadError();
      if (rootError) {
        await this.publishRender(generation, "error", changesWebviewErrorHtml(rootError));
        return;
      }
      const count = this.options.controller.countBadge();
      view.badge = count > 0 ? { value: count, tooltip: `${count}` } : undefined;
      const html = this.measureSerialization(generation, () => this.renderTreeHtml(roots, true));
      await this.publishRender(generation, "final", html);
      void this.hydrateExpandedAdopted(generation, view, roots);
    } catch (error) {
      if (!this.isCurrentRender(generation, view)) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      await this.publishRender(generation, "error", changesWebviewErrorHtml(detail));
    }
  }

  private async toggle(id: string): Promise<void> {
    const node = this.nodes.get(id);
    const expanded = !this.isExpanded(node);
    this.expansion.set(id, expanded);
    if (expanded && node?.diffSpec && node.kind === "adopted-group" && this.view && this.lastRoots.length > 0) {
      const version = this.renderProtocol.version();
      const html = this.measureSerialization(version.generation, () => this.renderTreeHtml(this.lastRoots, true));
      await this.publishRender(version.generation, version.renderState, html);
      await this.hydrateExpandedAdopted(version.generation, this.view, this.lastRoots);
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
        this.renderTiming.finalPublishedAt = Date.now();
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
    const postStarted = Date.now();
    const accepted = await view.webview.postMessage(render);
    if (this.renderTiming?.generation === render.generation) {
      this.renderTiming.postMs += Date.now() - postStarted;
      if (render.renderState === "final" || render.renderState === "error") {
        this.renderTiming.finalPostAt = Date.now();
      }
    }
    if (!accepted) {
      this.htmlReady = false;
    }
  }

  private isCurrentRender(generation: number, view: vscode.WebviewView): boolean {
    return this.renderProtocol.isCurrent(generation) && this.view === view;
  }

  private startProgress(generation: number): void {
    this.finishProgress();
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
  ): Promise<void> {
    if (!this.hasExpandedAdopted(roots)) {
      return;
    }
    const started = Date.now();
    const hydrated = await this.hydrate(roots);
    if (!this.isCurrentRender(generation, view)) {
      return;
    }
    console.debug(`[git-submodule] adopted hydration ${Date.now() - started}ms`);
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
    const started = Date.now();
    const result = serialize();
    if (this.renderTiming?.generation === generation) {
      this.renderTiming.serializationMs += Date.now() - started;
    }
    return result;
  }

  private logRenderTiming(generation: number): void {
    const timing = this.renderTiming;
    if (!timing || timing.generation !== generation) {
      return;
    }
    const now = Date.now();
    const ackMs = timing.finalPostAt === undefined ? 0 : now - timing.finalPostAt;
    console.debug(
      `[git-submodule] render generation=${generation} vscodeSnapshot=${timing.bootstrapSnapshotMs}ms bootstrapTree=${timing.bootstrapTreeMs}ms serialize=${timing.serializationMs}ms post=${timing.postMs}ms ack=${ackMs}ms total=${now - timing.startedAt}ms`,
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

interface ImmediatePaint {
  nodes?: AdoptedTreeNode[];
  snapshotMs: number;
  treeBuildMs: number;
}

interface RenderTiming {
  generation: number;
  startedAt: number;
  bootstrapSnapshotMs: number;
  bootstrapTreeMs: number;
  serializationMs: number;
  postMs: number;
  finalPublishedAt?: number;
  finalPostAt?: number;
}

function emptyImmediatePaint(): ImmediatePaint {
  return { snapshotMs: 0, treeBuildMs: 0 };
}

import type { AdoptedTreeNode } from "./adoptedViewModel.js";
import { repoHasOwnCommitChanges } from "./adoptedViewModel.js";
import { compactFolderDisplayLabel } from "./fileIconTheme.js";
import { repoMapGet, repoSetHas } from "../git/pathUtils.js";
import type { RowAction, RowActionConfig } from "./changesRowActions.js";
import { inlineActions } from "./changesRowActions.js";
import { COMMANDS } from "./constants.js";
import type { ChangesRenderState } from "./changesRenderProtocol.js";

export interface ChangesWebviewRow {
  id: string;
  kind: string;
  label: string;
  description?: string;
  tooltip: string;
  collapsible: boolean;
  expanded: boolean;
  selected: boolean;
  depth: number;
  iconId: string;
  iconSrc?: string;
  iconColor?: string;
  labelColor?: string;
  decorationBadge?: string;
  decorationColor?: string;
  countPill?: string;
  adoptedCountState?: "loading" | "error";
  adoptedCountError?: string;
  dirtyDot: boolean;
  contextValue: string;
  showCommitChrome: boolean;
  commitPlaceholder: string;
  commitDraft: string;
  generateCommitMessageSupported: boolean;
  repositoryRoot?: string;
  inlineActions: RowAction[];
  children: ChangesWebviewRow[];
}

export interface ChangesWebviewTreeState {
  expanded: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  drafts: ReadonlyMap<string, string>;
  placeholders: ReadonlyMap<string, string>;
  generateCommitMessageSupportedRoots?: ReadonlySet<string>;
  fileIconSrc?: (node: AdoptedTreeNode, expanded: boolean) => string | undefined;
  config: RowActionConfig;
}

export const UNSUPPORTED_COMMIT_MESSAGE_TOOLTIP =
  "Cursor AI cannot safely target this repository from a multi-repository view. Use the sparkle in this repository's built-in Source Control input.";

export function toChangesWebviewRows(
  nodes: readonly AdoptedTreeNode[],
  state: ChangesWebviewTreeState,
  depth = 0,
): ChangesWebviewRow[] {
  return nodes.map((node) => {
    const expanded = node.collapsible && state.expanded.has(node.id);
    const showCommitChrome = expanded && repoHasOwnCommitChanges(node);
    const repositoryRoot = node.repositoryRoot;
    const countPill = groupCountPill(node);
    const adoptedCountState =
      node.kind === "adopted-group" && node.diffSpec && !countPill
        ? node.adoptedCountError
          ? "error"
          : "loading"
        : undefined;
    const children = expanded ? toChangesWebviewRows(node.children, state, depth + 1) : [];
    if (
      expanded &&
      node.kind === "adopted-group" &&
      node.diffSpec &&
      node.description === undefined &&
      children.length === 0
    ) {
      children.push(lazyLoadingRow(node.id, depth + 1));
    }
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      description: countPill ? undefined : node.description,
      tooltip: node.tooltip,
      collapsible: node.collapsible,
      expanded,
      selected: state.selected.has(node.id),
      depth,
      iconId: rowIconId(node),
      iconSrc: state.fileIconSrc?.(node, expanded),
      iconColor: rowIconColor(node),
      labelColor: repoLabelColor(node),
      decorationBadge: node.decoration?.badge,
      decorationColor: node.decoration?.themeColorId,
      countPill,
      adoptedCountState,
      adoptedCountError: node.adoptedCountError,
      dirtyDot: node.kind === "folder",
      contextValue: node.contextValue,
      showCommitChrome,
      commitPlaceholder: repositoryRoot
        ? (repoMapGet(state.placeholders, repositoryRoot) ?? "Commit message")
        : "Commit message",
      commitDraft: repositoryRoot ? (repoMapGet(state.drafts, repositoryRoot) ?? "") : "",
      generateCommitMessageSupported: repositoryRoot
        ? (state.generateCommitMessageSupportedRoots
            ? repoSetHas(state.generateCommitMessageSupportedRoots, repositoryRoot)
            : true)
        : false,
      repositoryRoot,
      inlineActions: withSyncLabel(inlineActions(node.contextValue, state.config), node.syncLabel),
      children,
    };
  });
}

function withSyncLabel(actions: readonly RowAction[], syncLabel: string | undefined): RowAction[] {
  if (!syncLabel) {
    return [...actions];
  }
  return actions.map((action) =>
    action.command === COMMANDS.sync ? { ...action, label: syncLabel } : action,
  );
}

export function renderChangesTree(rows: readonly ChangesWebviewRow[]): string {
  if (rows.length === 0) {
    return `<div class="empty">No Git workspace folders found.</div>`;
  }
  return `<div class="tree">${rows.map((row) => renderRow(row)).join("")}</div>`;
}

export function changesWebviewLoadingHtml(): string {
  return `<div class="empty loading" role="status">Loading changes…</div>`;
}

export function changesWebviewErrorHtml(detail: string): string {
  return `<div class="load-error" role="alert"><span>Failed to load changes</span><span class="error-detail">${escapeHtml(detail)}</span><button type="button" class="retry-btn" data-act="retry"><i class="codicon codicon-refresh"></i><span>Retry</span></button></div>`;
}

/** True when `#root` already has visible markup before any model message. */
export function webviewPagePaintsBeforeModel(html: string): boolean {
  return /<div id="root">(?!\s*<\/div>)/.test(html);
}

export function changesWebviewPage(params: {
  nonce: string;
  cspSource: string;
  codiconCssHref: string;
  rootHtml?: string;
  generation?: number;
  renderState?: ChangesRenderState;
}): string {
  const {
    nonce,
    cspSource,
    codiconCssHref,
    rootHtml = changesWebviewLoadingHtml(),
    generation = 0,
    renderState = "loading",
  } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${escapeHtml(codiconCssHref)}" rel="stylesheet" />
  <style>${CHANGES_WEBVIEW_CSS}</style>
</head>
<body data-generation="${generation}" data-render-state="${renderState}">
  <div id="root">${rootHtml}</div>
  <script nonce="${nonce}">${CHANGES_WEBVIEW_JS}</script>
</body>
</html>`;
}

export function groupCountPill(node: AdoptedTreeNode): string | undefined {
  if (node.kind !== "change-group" && node.kind !== "adopted-group") {
    return undefined;
  }
  return node.description !== undefined && /^\d+$/.test(node.description) ? node.description : undefined;
}

function rowIconId(node: AdoptedTreeNode): string {
  if (node.kind === "folder") {
    return "folder";
  }
  if (node.kind === "file" || (node.kind === "change" && node.iconId === "file")) {
    return "file";
  }
  return node.iconId;
}

function rowIconColor(node: AdoptedTreeNode): string | undefined {
  if (node.kind === "folder" || node.kind === "file" || (node.kind === "change" && node.iconId === "file")) {
    return undefined;
  }
  return node.themeColorId ?? node.decoration?.themeColorId;
}

function repoLabelColor(node: AdoptedTreeNode): string | undefined {
  return node.kind === "workspace-root" || node.kind === "submodule"
    ? node.decoration?.themeColorId
    : undefined;
}

function lazyLoadingRow(parentId: string, depth: number): ChangesWebviewRow {
  return {
    id: `${parentId}:loading`,
    kind: "message",
    label: "Loading adopted files…",
    tooltip: "Loading adopted files",
    collapsible: false,
    expanded: false,
    selected: false,
    depth,
    iconId: "loading~spin",
    contextValue: "gitSubmodule.message",
    showCommitChrome: false,
    commitPlaceholder: "Commit message",
    commitDraft: "",
    generateCommitMessageSupported: false,
    inlineActions: [],
    dirtyDot: false,
    children: [],
  };
}

function renderRow(row: ChangesWebviewRow): string {
  const pad = 8 + row.depth * 8;
  const twistie = row.collapsible
    ? `<button type="button" class="twistie" data-act="toggle" aria-label="${row.expanded ? "Collapse" : "Expand"}"><i class="codicon ${row.expanded ? "codicon-chevron-down" : "codicon-chevron-right"}"></i></button>`
    : `<span class="twistie-spacer"></span>`;
  const icon = row.iconSrc
    ? `<img class="file-theme-icon" src="${escapeHtml(row.iconSrc)}" alt="" />`
    : row.iconId
      ? `<i class="codicon ${codiconClass(row.iconId)}"${row.iconColor ? ` style="color:${themeVar(row.iconColor)}"` : ""}></i>`
      : "";
  const adoptedCount = row.countPill
    ? row.kind === "adopted-group"
      ? `<span class="count-pill" data-adopted-count>${escapeHtml(row.countPill)}</span>`
      : `<span class="count-pill">${escapeHtml(row.countPill)}</span>`
    : row.adoptedCountState === "error"
      ? `<button type="button" class="adopted-count adopted-count-error" data-act="retry-adopted" title="${escapeHtml(row.adoptedCountError ?? "Failed to load adopted count. Retry.")}" aria-label="Retry adopted count"><i class="codicon codicon-warning"></i></button>`
      : row.adoptedCountState === "loading"
        ? `<span class="adopted-count adopted-count-loading" title="Loading adopted count" aria-label="Loading adopted count"><i class="codicon codicon-loading codicon-modifier-spin"></i></span>`
        : "";
  const badge = row.decorationBadge
    ? `<span class="badge"${row.decorationColor ? ` style="color:${themeVar(row.decorationColor)}"` : ""}>${escapeHtml(row.decorationBadge)}</span>`
    : "";
  const dirtyDot = row.dirtyDot ? `<span class="dirty-dot" aria-hidden="true"></span>` : "";
  const status = adoptedCount || badge || dirtyDot
    ? `<span class="row-status">${adoptedCount}${badge}${dirtyDot}</span>`
    : "";
  const isRepo = row.kind === "workspace-root" || row.kind === "submodule";
  const isGroup = row.kind === "change-group" || row.kind === "adopted-group";
  const repoKind = isRepo ? `<span class="repo-kind">Git</span>` : "";
  const branch = isRepo && row.description
    ? `<button type="button" class="branch" data-act="branch" title="Checkout Branch...">${escapeHtml(row.description)}</button>`
    : !isRepo && row.description
      ? `<span class="desc">${escapeHtml(row.description)}</span>`
      : "";
  const actions = row.inlineActions
    .map((action) => {
      const label = action.label
        ? `<span class="sync-label">${escapeHtml(action.label)}</span>`
        : "";
      const wide = action.label ? " inline-btn-labeled" : "";
      return `<button type="button" class="inline-btn${wide}" data-act="command" data-command="${escapeHtml(action.command)}" title="${escapeHtml(action.title)}"><i class="codicon ${codiconClass(action.icon)}"></i>${label}</button>`;
    })
    .join("");
  const generate = row.generateCommitMessageSupported
    ? `<button type="button" class="sparkle-btn" data-act="generate" title="Generate Commit Message" aria-label="Generate Commit Message"><i class="codicon codicon-sparkle"></i></button>`
    : `<button type="button" class="sparkle-btn generate-info-btn" data-act="explain-generate" title="${escapeHtml(UNSUPPORTED_COMMIT_MESSAGE_TOOLTIP)}" aria-label="Cursor AI commit message unavailable"><i class="codicon codicon-info"></i></button>`;
  const chrome = row.showCommitChrome
    ? `<div class="commit-chrome" style="padding-left:${pad}px">
           <div class="commit-input-wrap">
             <textarea class="commit-input" data-act="draft" data-root="${escapeHtml(row.repositoryRoot ?? "")}" rows="2" placeholder="${escapeHtml(row.commitPlaceholder)}">${escapeHtml(row.commitDraft)}</textarea>
             ${generate}
           </div>
           <button type="button" class="commit-btn" data-act="commit"><i class="codicon codicon-check"></i><span>Commit</span></button>
         </div>`
    : "";
  const kids = row.children.map((child) => renderRow(child)).join("");
  const labelText = row.kind === "folder" ? compactFolderDisplayLabel(row.label) : row.label;
  return `<div class="node" data-id="${escapeHtml(row.id)}" data-kind="${escapeHtml(row.kind)}">
    <div class="row${row.selected ? " selected" : ""}${isRepo ? " repo-row" : ""}${isGroup ? " group-row" : ""}" role="treeitem" title="${escapeHtml(row.tooltip)}" data-act="row" style="--row-pad:${pad}px;padding-left:${pad}px">
      ${twistie}${icon}<span class="label"${row.labelColor ? ` style="color:${themeVar(row.labelColor)}"` : ""}>${escapeHtml(labelText)}</span>${repoKind}<span class="grow"></span>${branch}<span class="tail"><span class="inline">${actions}</span>${status}</span>
    </div>
    ${chrome}${kids}
  </div>`;
}

function codiconClass(iconId: string): string {
  if (iconId.endsWith("~spin")) {
    return `codicon-${iconId.slice(0, -5)} codicon-modifier-spin`;
  }
  return `codicon-${iconId}`;
}

function themeVar(colorId: string): string {
  return `var(--vscode-${colorId.replaceAll(".", "-")})`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CHANGES_WEBVIEW_CSS = `
html, body {
  height: 100%;
  min-height: 160px;
}
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-sideBar-foreground);
  background: var(--vscode-sideBar-background);
  user-select: none;
}
#root { min-height: 160px; }
.tree { padding: 2px 0 12px; }
.empty { padding: 12px; color: var(--vscode-descriptionForeground); min-height: 80px; }
.load-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  color: var(--vscode-errorForeground);
}
.error-detail { color: var(--vscode-descriptionForeground); user-select: text; }
.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  cursor: pointer;
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  cursor: pointer;
  position: relative;
  box-sizing: border-box;
}
.node .node > .row::before {
  content: "";
  position: absolute;
  left: calc(var(--row-pad) - 5px);
  top: 0;
  bottom: 0;
  width: 1px;
  opacity: .3;
  background: var(--vscode-tree-inactiveIndentGuidesStroke, var(--vscode-tree-indentGuidesStroke));
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row > .codicon,
.file-theme-icon {
  width: 16px;
  height: 16px;
  flex: none;
  font-size: 16px;
  line-height: 16px;
}
.file-theme-icon {
  object-fit: contain;
}
.twistie, .inline-btn, .branch, .commit-btn, .sparkle-btn {
  border: none;
  background: transparent;
  color: inherit;
  /* Buttons do not inherit fonts by default; without this the UA font renders
     digits and the ↓↑ glyphs from different fallbacks at mismatched sizes. */
  font: inherit;
  padding: 0;
  cursor: pointer;
}
.adopted-count-error {
  border: none;
  padding: 0;
  color: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground));
  background: transparent;
  cursor: pointer;
}
.adopted-count-loading, .adopted-count-error {
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  flex: none;
}
.twistie, .twistie-spacer, .inline-btn, .sparkle-btn {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.inline-btn {
  width: 20px;
  min-width: 20px;
  height: 20px;
  box-sizing: border-box;
  border-radius: 5px;
}
.inline-btn-labeled {
  width: auto;
  min-width: 20px;
  padding: 0 4px;
  gap: 3px;
}
.sync-label {
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  color: var(--vscode-descriptionForeground);
}
.inline-btn > .codicon {
  display: block;
  line-height: 16px;
}
.inline-btn:hover {
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
.twistie:focus-visible,
.inline-btn:focus-visible,
.branch:focus-visible,
.sparkle-btn:focus-visible,
.commit-btn:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-kind { flex: none; color: var(--vscode-descriptionForeground); font-size: 11px; }
.grow { flex: 1 1 auto; min-width: 4px; margin-left: auto; }
.desc, .branch {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  padding: 0 2px;
}
.desc { flex: none; }
.branch {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.branch:hover { text-decoration: underline; color: var(--vscode-textLink-foreground); }
.row-status {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  flex: none;
  min-width: 16px;
  margin-left: 2px;
  padding-right: 6px;
  box-sizing: border-box;
}
.badge { flex: none; font-size: 11px; font-weight: 600; min-width: 12px; text-align: right; }
.count-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  color: var(--vscode-scm-providerCountBadge-foreground, var(--vscode-badge-foreground));
  background: var(--vscode-scm-providerCountBadge-background, var(--vscode-badge-background));
}
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--vscode-gitDecoration-modifiedResourceForeground);
}
.tail {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  flex: none;
  position: relative;
}
.inline {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  height: 20px;
}
/* Hover-only toolbars claim no row width; they overlay the label once visible. */
.row:not(.repo-row) .inline {
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  padding: 0 3px;
  border-radius: 4px;
  /* Opaque base under the translucent list state color so the label cannot bleed through. */
  background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
  background-image: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground));
}
.row:not(.repo-row):hover .inline,
.row:not(.repo-row):focus-within .inline,
.row:not(.repo-row).selected .inline {
  opacity: 1;
  pointer-events: auto;
}
.row:not(.repo-row).selected .inline {
  background-image: linear-gradient(
    var(--vscode-list-activeSelectionBackground),
    var(--vscode-list-activeSelectionBackground)
  );
}
.row.repo-row .inline { opacity: 1; }
.commit-chrome { display: flex; flex-direction: column; gap: 4px; padding: 2px 8px 6px; }
.commit-input-wrap { position: relative; }
.commit-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 42px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  line-height: 18px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 0;
  padding: 3px 26px 3px 6px;
}
.commit-input::placeholder { color: var(--vscode-input-placeholderForeground); }
.sparkle-btn {
  position: absolute;
  top: 4px;
  right: 5px;
  color: var(--vscode-icon-foreground);
}
.sparkle-btn:hover { color: var(--vscode-foreground); }
.commit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 22px;
  box-sizing: border-box;
  padding: 2px 12px;
  font-weight: 400;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-radius: 2px;
}
.commit-btn:hover { background: var(--vscode-button-hoverBackground); }
`;

const CHANGES_WEBVIEW_JS = `
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
const stateRank = { loading: 0, bootstrap: 1, final: 2, error: 2 };
let current = {
  generation: Number(document.body.dataset.generation || 0),
  renderState: document.body.dataset.renderState || "loading"
};

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "adoptedCount") {
    if (msg.generation !== current.generation) return;
    applyAdoptedCount(msg);
    return;
  }
  if (msg.type !== "setTree") return;
  if (msg.generation < current.generation) return;
  if (msg.generation === current.generation && stateRank[msg.renderState] < stateRank[current.renderState]) return;
  const active = document.activeElement;
  const keepRoot = active && active.matches && active.matches("textarea.commit-input") ? active.getAttribute("data-root") : null;
  const keepValue = keepRoot ? active.value : null;
  const keepStart = keepRoot ? active.selectionStart : null;
  root.innerHTML = msg.html;
  current = { generation: msg.generation, renderState: msg.renderState };
  if (keepRoot) {
    const next = root.querySelector('textarea.commit-input[data-root="' + CSS.escape(keepRoot) + '"]');
    if (next) {
      next.value = keepValue;
      next.focus();
      if (keepStart != null) next.selectionStart = next.selectionEnd = keepStart;
    }
  }
  vscode.postMessage({ type: "rendered", generation: current.generation, renderState: current.renderState });
});

function applyAdoptedCount(msg) {
  const nodeEl = Array.from(root.querySelectorAll(".node")).find((node) => node.getAttribute("data-id") === msg.id);
  if (!nodeEl) return;
  const row = nodeEl.querySelector(":scope > .row");
  if (!row) return;
  const tail = row.querySelector(":scope > .tail") || row;
  let status = Array.from(tail.children).find((child) => child.classList.contains("row-status"));
  if (!status) {
    status = document.createElement("span");
    status.className = "row-status";
    tail.appendChild(status);
  }
  let indicator = status.querySelector("[data-adopted-count], .adopted-count");
  if (!indicator) {
    indicator = document.createElement("span");
    status.prepend(indicator);
  }
  if (msg.state === "resolved") {
    indicator.outerHTML = '<span class="count-pill" data-adopted-count>' + String(msg.count) + "</span>";
    return;
  }
  if (msg.state === "error") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "adopted-count adopted-count-error";
    button.setAttribute("data-act", "retry-adopted");
    button.title = msg.message || "Failed to load adopted count. Retry.";
    button.setAttribute("aria-label", "Retry adopted count");
    button.innerHTML = '<i class="codicon codicon-warning"></i>';
    indicator.replaceWith(button);
    return;
  }
  indicator.outerHTML = '<span class="adopted-count adopted-count-loading" title="Loading adopted count" aria-label="Loading adopted count"><i class="codicon codicon-loading codicon-modifier-spin"></i></span>';
}

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const actionEl = target.closest("[data-act]");
  if (actionEl && actionEl.getAttribute("data-act") === "retry") {
    vscode.postMessage({ type: "retry" });
    return;
  }
  const nodeEl = target.closest(".node");
  if (!actionEl || !nodeEl) return;
  const id = nodeEl.getAttribute("data-id");
  const act = actionEl.getAttribute("data-act");
  if (act === "toggle") {
    event.stopPropagation();
    vscode.postMessage({ type: "toggle", id });
    return;
  }
  if (act === "retry-adopted") {
    event.stopPropagation();
    vscode.postMessage({ type: "retryAdopted", id });
    return;
  }
  if (act === "branch") {
    event.stopPropagation();
    vscode.postMessage({ type: "branch", id });
    return;
  }
  if (act === "command") {
    event.stopPropagation();
    vscode.postMessage({ type: "command", command: actionEl.getAttribute("data-command"), id, additive: event.ctrlKey || event.metaKey });
    return;
  }
  if (act === "generate") {
    event.stopPropagation();
    vscode.postMessage({ type: "generate", id });
    return;
  }
  if (act === "explain-generate") {
    event.stopPropagation();
    vscode.postMessage({ type: "explainGenerate", id });
    return;
  }
  if (act === "commit") {
    event.stopPropagation();
    const area = nodeEl.querySelector("textarea.commit-input");
    vscode.postMessage({ type: "commit", id, message: area ? area.value : "" });
    return;
  }
  if (act === "row") {
    vscode.postMessage({ type: "click", id, additive: event.ctrlKey || event.metaKey });
  }
});

root.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const nodeEl = event.target instanceof Element ? event.target.closest(".node") : null;
  if (!nodeEl) return;
  vscode.postMessage({ type: "context", id: nodeEl.getAttribute("data-id") });
});

root.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || !target.matches(".commit-input")) return;
  vscode.postMessage({ type: "draft", rootPath: target.getAttribute("data-root"), value: target.value });
});

root.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    const nodeEl = target.closest(".node");
    vscode.postMessage({ type: "commit", id: nodeEl && nodeEl.getAttribute("data-id"), message: target.value });
  }
});

vscode.postMessage({ type: "ready", generation: current.generation, renderState: current.renderState });
vscode.postMessage({ type: "rendered", generation: current.generation, renderState: current.renderState });
`;

import { describe, expect, it } from "vitest";
import type { AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";
import { DEFAULT_ROW_ACTION_CONFIG } from "../../../src/views/changesRowActions.js";
import {
  changesWebviewErrorHtml,
  changesWebviewLoadingHtml,
  changesWebviewPage,
  changesWebviewStatusHtml,
  renderChangesTree,
  toChangesWebviewRows,
  webviewPagePaintsBeforeModel,
} from "../../../src/views/changesWebviewHtml.js";
import { CONTEXT } from "../../../src/views/constants.js";

function repo(partial: Partial<AdoptedTreeNode> & Pick<AdoptedTreeNode, "id" | "kind" | "label">): AdoptedTreeNode {
  return {
    tooltip: partial.label,
    collapsible: true,
    expandByDefault: true,
    contextValue: CONTEXT.workspaceRoot,
    iconId: "repo",
    children: [],
    ...partial,
  };
}

function group(kind: "index" | "workingTree" | "merge", files: number): AdoptedTreeNode {
  return {
    id: `group:${kind}`,
    kind: "change-group",
    changeGroup: kind,
    label: kind,
    tooltip: kind,
    collapsible: true,
    expandByDefault: true,
    contextValue: `gitSubmodule.changeGroup.${kind}`,
    iconId: "",
    description: String(files),
    children: Array.from({ length: files }, (_, index) => ({
      id: `file:${kind}:${index}`,
      kind: "change",
      label: `file-${index}.ts`,
      tooltip: "file",
      collapsible: false,
      expandByDefault: false,
      contextValue: `gitSubmodule.change.${kind}`,
      iconId: "file",
      children: [],
    })),
  };
}

describe("changes webview HTML", () => {
  it("renders commit chrome for a dirty repo and skips merge-only or descendant-only dirt", () => {
    const dirty = repo({
      id: "root:/ws/app",
      kind: "workspace-root",
      label: "app",
      description: "main*",
      repositoryRoot: "/ws/app",
      children: [group("workingTree", 1)],
    });
    const mergeOnly = repo({
      id: "root:/ws/merge",
      kind: "workspace-root",
      label: "merge",
      description: "main!",
      repositoryRoot: "/ws/merge",
      children: [group("merge", 1)],
    });
    const parentOfDirtyChild = repo({
      id: "root:/ws/parent",
      kind: "workspace-root",
      label: "parent",
      description: "main",
      repositoryRoot: "/ws/parent",
      children: [
        repo({
          id: "sub:/ws/parent/mod",
          kind: "submodule",
          label: "mod",
          description: "main*",
          repositoryRoot: "/ws/parent/mod",
          contextValue: CONTEXT.submodule,
          children: [group("index", 1)],
        }),
      ],
    });
    const state = {
      expanded: new Set(["root:/ws/app", "root:/ws/merge", "root:/ws/parent", "sub:/ws/parent/mod"]),
      selected: new Set<string>(),
      drafts: new Map([["/ws/app", "feat: from draft"]]),
      placeholders: new Map([["/ws/app", 'Message (commit on "main")']]),
      config: DEFAULT_ROW_ACTION_CONFIG,
    };
    const html = renderChangesTree(toChangesWebviewRows([dirty, mergeOnly, parentOfDirtyChild], state));
    expect(html).toContain('data-id="root:/ws/app"');
    expect(html).toContain("feat: from draft");
    expect(html).toContain(">Commit<");
    expect(html).toContain('class="branch"');
    expect(html).toContain("main*");
    expect(html.match(/commit-chrome/g)?.length).toBe(2);
    expect(html).toContain('data-id="root:/ws/merge"');
    expect(html).not.toMatch(/data-id="root:\/ws\/merge"[\s\S]*commit-chrome[\s\S]*data-id="root:\/ws\/parent"/);
    expect(html).toContain('data-act="generate"');
    expect(html).toContain("codicon-sparkle");
    expect(html).toContain("Generate Commit Message");
  });

  it("hides collapsed commit chrome and restores the repository draft when expanded", () => {
    const dirty = repo({
      id: "root:/ws/app",
      kind: "workspace-root",
      label: "httpendpoint",
      description: "main*+",
      repositoryRoot: "/ws/app",
      children: [group("workingTree", 2)],
    });
    const collapsed = renderChangesTree(
      toChangesWebviewRows([dirty], {
        expanded: new Set(),
        selected: new Set<string>(),
        drafts: new Map([["/ws/app", "draft survives collapse"]]),
        placeholders: new Map([["/ws/app", 'Message (commit on "main")']]),
        config: DEFAULT_ROW_ACTION_CONFIG,
      }),
    );
    expect(collapsed).toContain("main*+");
    expect(collapsed).toContain('class="repo-kind">Git<');
    expect(collapsed).toContain('class="inline"');
    expect(collapsed).not.toContain("commit-chrome");
    expect(collapsed).not.toContain("commit-input");
    expect(collapsed).not.toContain('data-act="generate"');
    expect(collapsed).not.toContain("draft survives collapse");
    expect(collapsed).not.toContain('data-id="file:workingTree:0"');

    const expanded = renderChangesTree(
      toChangesWebviewRows([dirty], {
        expanded: new Set(["root:/ws/app"]),
        selected: new Set<string>(),
        drafts: new Map([["/ws/app", "draft survives collapse"]]),
        placeholders: new Map([["/ws/app", 'Message (commit on "main")']]),
        config: DEFAULT_ROW_ACTION_CONFIG,
      }),
    );
    expect(expanded).toContain("commit-chrome");
    expect(expanded).toContain("draft survives collapse");
    expect(expanded).toContain('data-act="generate"');
    expect(expanded).toContain(">Commit<");
  });

  it("renders group counts as pills, folder dirty dots, and file status letters", () => {
    const adopted: AdoptedTreeNode = {
      id: "adopted:/ws/app:workingTree:mod",
      kind: "adopted-group",
      label: "Adopted Changes",
      description: "0",
      tooltip: "Adopted Changes",
      collapsible: true,
      expandByDefault: true,
      contextValue: CONTEXT.adoptedGroup,
      iconId: "",
      children: [],
    };
    const folder: AdoptedTreeNode = {
      id: "folder:/ws/app:workingTree:src",
      kind: "folder",
      label: "src",
      tooltip: "src",
      collapsible: true,
      expandByDefault: true,
      contextValue: CONTEXT.resourceFolderWorkingTree,
      iconId: "folder",
      children: [
        {
          id: "file:workingTree:0",
          kind: "change",
          label: "file-0.ts",
          tooltip: "file",
          collapsible: false,
          expandByDefault: false,
          contextValue: CONTEXT.changeWorkingTree,
          iconId: "file",
          decoration: { badge: "M", tooltip: "Modified", themeColorId: "gitDecoration.modifiedResourceForeground" },
          children: [],
        },
      ],
    };
    const changes: AdoptedTreeNode = {
      ...group("workingTree", 0),
      label: "Changes",
      description: "22",
      children: [folder, adopted],
    };
    const dirty = repo({
      id: "root:/ws/app",
      kind: "workspace-root",
      label: "app",
      description: "main*",
      repositoryRoot: "/ws/app",
      children: [changes],
    });
    const html = renderChangesTree(
      toChangesWebviewRows([dirty], {
        expanded: new Set(["root:/ws/app", "group:workingTree", "folder:/ws/app:workingTree:src"]),
        selected: new Set<string>(),
        drafts: new Map(),
        placeholders: new Map(),
        config: DEFAULT_ROW_ACTION_CONFIG,
      }),
    );
    expect(html).toContain('class="count-pill">22<');
    expect(html).toContain('class="count-pill">0<');
    expect(html).not.toMatch(/class="desc">22</);
    expect(html).toContain('class="dirty-dot"');
    expect(html).toContain('class="badge"');
    expect(html).toContain(">M<");
    expect(html).toContain("inline-btn");
    expect(html).toContain("repo-row");
    expect(html).toContain("codicon-check");
    expect(html).toMatch(/data-id="file:workingTree:0"[\s\S]*?class="inline"[\s\S]*?class="badge"/);
  });

  it("paints loading HTML in #root before any model message", () => {
    const page = changesWebviewPage({ nonce: "n", cspSource: "https://example", codiconCssHref: "codicon.css" });
    expect(changesWebviewLoadingHtml()).toContain("Loading changes");
    expect(webviewPagePaintsBeforeModel(page)).toBe(true);
    expect(webviewPagePaintsBeforeModel('<div id="root"></div><script>')).toBe(false);
    expect(page).toContain("Loading changes");
    expect(changesWebviewStatusHtml("loading")).toContain("render-progress");
    expect(page).toContain("min-height: 160px");
  });

  it("keeps progress through bootstrap, clears it at final, and renders retry on error", () => {
    const bootstrap = changesWebviewPage({
      nonce: "n",
      cspSource: "https://example",
      codiconCssHref: "codicon.css",
      rootHtml: "<div>bootstrap tree</div>",
      generation: 4,
      renderState: "bootstrap",
    });
    expect(bootstrap).toContain('data-generation="4"');
    expect(bootstrap).toContain('data-render-state="bootstrap"');
    expect(changesWebviewStatusHtml("bootstrap")).toContain("Discovering submodules");
    expect(changesWebviewStatusHtml("final")).toBe("");
    expect(changesWebviewErrorHtml("git unavailable")).toContain("git unavailable");
    expect(changesWebviewErrorHtml("git unavailable")).toContain('data-act="retry"');
  });

  it("keeps repo toolbar icons visible and hides file/folder icons until hover", () => {
    const page = changesWebviewPage({ nonce: "n", cspSource: "https://example", codiconCssHref: "codicon.css" });
    expect(page).toContain(".row:not(.repo-row) .inline { opacity: 0; }");
    expect(page).toContain(".row:not(.repo-row):hover .inline");
    expect(page).toContain(".row.repo-row .inline { opacity: 1; }");
    expect(page).toContain(".count-pill");
    expect(page).toContain("border-radius: 8px");
    expect(page).toContain("--vscode-scm-providerCountBadge-background");
    expect(page).toContain(".sparkle-btn");
    expect(page).toContain("width: 100%");
  });
});

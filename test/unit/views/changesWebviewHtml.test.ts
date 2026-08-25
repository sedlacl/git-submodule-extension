import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";
import { DEFAULT_ROW_ACTION_CONFIG } from "../../../src/views/changesRowActions.js";
import {
  changesWebviewErrorHtml,
  changesWebviewLoadingHtml,
  changesWebviewPage,
  escapeHtml,
  renderChangesTree,
  toChangesWebviewRows,
  UNSUPPORTED_COMMIT_MESSAGE_TOOLTIP,
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

  it("replaces the misleading AI sparkle for an unsupported multi-repository target", () => {
    const child = repo({
      id: "sub:/ws/parent/usy_aflex_initdatag01#t1",
      kind: "submodule",
      label: "usy_aflex_initdatag01#t1",
      repositoryRoot: "/ws/parent/usy_aflex_initdatag01#t1",
      contextValue: CONTEXT.submodule,
      children: [group("workingTree", 1)],
    });
    const html = renderChangesTree(
      toChangesWebviewRows([child], {
        expanded: new Set([child.id]),
        selected: new Set(),
        drafts: new Map(),
        placeholders: new Map(),
        generateCommitMessageSupportedRoots: new Set(),
        config: DEFAULT_ROW_ACTION_CONFIG,
      }),
    );

    expect(html).toContain('data-act="explain-generate"');
    expect(html).toContain("codicon-info");
    expect(html).toContain(escapeHtml(UNSUPPORTED_COMMIT_MESSAGE_TOOLTIP));
    expect(html).not.toContain('data-act="generate"');
    expect(html).not.toContain("codicon-sparkle");
  });

  it("shows the sparkle when cursor uri targeting supports the repository root", () => {
    const child = repo({
      id: "sub:/ws/parent/usy_aflex_initdatag01#t1",
      kind: "submodule",
      label: "usy_aflex_initdatag01#t1",
      repositoryRoot: "/ws/parent/usy_aflex_initdatag01#t1",
      contextValue: CONTEXT.submodule,
      children: [group("workingTree", 1)],
    });
    const html = renderChangesTree(
      toChangesWebviewRows([child], {
        expanded: new Set([child.id]),
        selected: new Set(),
        drafts: new Map(),
        placeholders: new Map(),
        generateCommitMessageSupportedRoots: new Set(["/ws/parent/usy_aflex_initdatag01#t1"]),
        config: DEFAULT_ROW_ACTION_CONFIG,
      }),
    );

    expect(html).toContain('data-act="generate"');
    expect(html).toContain("codicon-sparkle");
    expect(html).not.toContain('data-act="explain-generate"');
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
    expect(html).toContain('class="count-pill" data-adopted-count>0<');
    expect(html).not.toMatch(/class="desc">22</);
    expect(html).toContain('class="dirty-dot"');
    expect(html).toContain('class="badge"');
    expect(html).toContain(">M<");
    expect(html).toContain("inline-btn");
    expect(html).toContain("repo-row");
    expect(html).toContain("codicon-check");
    expect(html).toMatch(/data-id="file:workingTree:0"[\s\S]*?class="inline"[\s\S]*?class="row-status"[\s\S]*?class="badge"/);
  });

  it("renders file icon theme images and compact folder labels", () => {
    const folder: AdoptedTreeNode = {
      id: "folder:/ws/app:workingTree:src/util",
      kind: "folder",
      label: "src/util",
      tooltip: "src/util",
      collapsible: true,
      expandByDefault: true,
      contextValue: CONTEXT.resourceFolderWorkingTree,
      iconId: "folder",
      children: [
        {
          id: "file:workingTree:app.js",
          kind: "change",
          label: "app.js",
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
    const html = renderChangesTree(
      toChangesWebviewRows([folder], {
        expanded: new Set(["folder:/ws/app:workingTree:src/util"]),
        selected: new Set<string>(),
        drafts: new Map(),
        placeholders: new Map(),
        config: DEFAULT_ROW_ACTION_CONFIG,
        fileIconSrc: (node) =>
          node.kind === "folder" ? "https://theme.example/folder.svg" : "https://theme.example/javascript.svg",
      }),
    );
    expect(html).toContain('src="https://theme.example/folder.svg"');
    expect(html).toContain('src="https://theme.example/javascript.svg"');
    expect(html).toContain("file-theme-icon");
    expect(html).not.toContain("codicon-folder");
    expect(html).not.toContain("codicon-file");
    expect(html).toContain(`src ${path.sep} util`);
  });

  it("paints loading HTML in #root before any model message", () => {
    const page = changesWebviewPage({ nonce: "n", cspSource: "https://example", codiconCssHref: "codicon.css" });
    expect(changesWebviewLoadingHtml()).toContain("Loading changes");
    expect(webviewPagePaintsBeforeModel(page)).toBe(true);
    expect(webviewPagePaintsBeforeModel('<div id="root"></div><script>')).toBe(false);
    expect(page).toContain("Loading changes");
    expect(page).not.toContain("render-progress");
    expect(page).not.toContain('role="progressbar"');
    expect(page).toContain("min-height: 160px");
  });

  it("uses no embedded progress bar and renders retry on error", () => {
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
    expect(bootstrap).not.toContain("render-progress");
    expect(bootstrap).not.toContain('role="progressbar"');
    expect(changesWebviewErrorHtml("git unavailable")).toContain("git unavailable");
    expect(changesWebviewErrorHtml("git unavailable")).toContain('data-act="retry"');
  });

  it("uses compact fixed action targets while preserving hover and keyboard states", () => {
    const page = changesWebviewPage({ nonce: "n", cspSource: "https://example", codiconCssHref: "codicon.css" });
    expect(page).toContain(".row:not(.repo-row) .inline { opacity: 0; }");
    expect(page).toContain(".row:not(.repo-row):hover .inline");
    expect(page).toContain(".row.repo-row .inline { opacity: 1; }");
    expect(page).toMatch(/\.inline-btn \{[\s\S]*?width: 20px;[\s\S]*?min-width: 20px;[\s\S]*?height: 20px;[\s\S]*?box-sizing: border-box;/);
    expect(page).toMatch(/\.inline \{[\s\S]*?gap: 2px;[\s\S]*?flex: none;[\s\S]*?height: 20px;/);
    expect(page).toContain(".inline-btn:hover");
    expect(page).toContain("--vscode-toolbar-hoverBackground");
    expect(page).toContain(".inline-btn:focus-visible");
    expect(page).toContain("outline: 1px solid var(--vscode-focusBorder)");
    expect(page).toContain(".count-pill");
    expect(page).toContain("border-radius: 8px");
    expect(page).toContain("--vscode-scm-providerCountBadge-background");
    expect(page).toContain(".sparkle-btn");
    expect(page).toContain("width: 100%");
  });

  it("keeps group actions before a far-right count without layout jumps", () => {
    const changed = repo({
      id: "root:/ws/app",
      kind: "workspace-root",
      label: "app",
      repositoryRoot: "/ws/app",
      children: [{ ...group("workingTree", 1), label: "Changes", description: "7" }],
    });
    const page = changesWebviewPage({ nonce: "n", cspSource: "https://example", codiconCssHref: "codicon.css" });
    const html = renderChangesTree(
      toChangesWebviewRows([changed], {
        expanded: new Set(["root:/ws/app", "group:workingTree"]),
        selected: new Set(),
        drafts: new Map(),
        placeholders: new Map(),
        config: DEFAULT_ROW_ACTION_CONFIG,
      }),
    );

    expect(html).toMatch(/group-row[\s\S]*class="label">Changes<[\s\S]*class="grow"[\s\S]*class="inline"[\s\S]*class="row-status"[\s\S]*class="count-pill">7</);
    expect(page).toContain(".grow { flex: 1 1 auto; min-width: 4px; margin-left: auto; }");
    expect(page).toContain(".row:not(.repo-row) .inline { opacity: 0; }");
    expect(page).toMatch(/\.row-status \{[\s\S]*?flex: none;[\s\S]*?min-width: 16px;[\s\S]*?margin-left: 2px;[\s\S]*?padding-right: 6px;/);
    expect(page).toMatch(/\.branch \{[\s\S]*?flex: 0 1 auto;[\s\S]*?min-width: 0;[\s\S]*?max-width: 180px;[\s\S]*?text-overflow: ellipsis;/);
  });

  it("preserves propagated repo tint and status colors through lazy adopted hydration", () => {
    const adopted: AdoptedTreeNode = {
      id: "adopted:/ws/app:workingTree:mod",
      kind: "adopted-group",
      label: "Adopted Changes",
      tooltip: "Adopted Changes",
      collapsible: true,
      expandByDefault: false,
      contextValue: CONTEXT.adoptedGroup,
      iconId: "",
      diffSpec: {
        repoRoot: "/ws/app/mod",
        kind: "unstaged",
        fromSha: "a".repeat(40),
        toSha: "b".repeat(40),
      },
      children: [],
    };
    const gitlink: AdoptedTreeNode = {
      id: "change:/ws/app:workingTree:mod",
      kind: "change",
      label: "mod",
      tooltip: "mod",
      collapsible: true,
      expandByDefault: true,
      contextValue: CONTEXT.gitlink,
      iconId: "file",
      decoration: {
        badge: "S",
        tooltip: "Submodule",
        themeColorId: "gitDecoration.submoduleResourceForeground",
      },
      children: [adopted],
    };
    const tinted = repo({
      id: "root:/ws/app",
      kind: "workspace-root",
      label: "app",
      decoration: {
        tooltip: "Submodule changes",
        themeColorId: "gitDecoration.submoduleResourceForeground",
      },
      children: [gitlink],
    });
    const clean = repo({ id: "root:/ws/clean", kind: "workspace-root", label: "clean" });
    const state = {
      expanded: new Set([tinted.id, gitlink.id, adopted.id]),
      selected: new Set<string>(),
      drafts: new Map<string, string>(),
      placeholders: new Map<string, string>(),
      config: DEFAULT_ROW_ACTION_CONFIG,
    };

    const loading = renderChangesTree(toChangesWebviewRows([tinted, clean], state));
    expect(loading).toMatch(/class="label" style="color:var\(--vscode-gitDecoration-submoduleResourceForeground\)">app</);
    expect(loading).toContain("Loading adopted files");
    expect(loading).toContain("adopted-count-loading");
    expect(loading).not.toContain('class="count-pill">0<');
    expect(loading).toContain('class="badge" style="color:var(--vscode-gitDecoration-submoduleResourceForeground)">S');
    expect(loading).not.toMatch(/style="color:[^"]+">clean</);

    adopted.adoptedCountError = "diff failed";
    const failed = renderChangesTree(toChangesWebviewRows([tinted, clean], state));
    expect(failed).toContain('data-act="retry-adopted"');
    expect(failed).toContain("diff failed");
    expect(failed).toContain("codicon-warning");

    adopted.adoptedCountError = undefined;
    adopted.description = "1";
    adopted.children = [{
      id: "file:/ws/app/mod:unstaged:src/a.ts",
      kind: "file",
      label: "a.ts",
      tooltip: "Modified",
      collapsible: false,
      expandByDefault: false,
      contextValue: CONTEXT.file,
      iconId: "diff-modified",
      decoration: {
        badge: "M",
        tooltip: "Modified",
        themeColorId: "gitDecoration.modifiedResourceForeground",
      },
      children: [],
    }];
    const hydrated = renderChangesTree(toChangesWebviewRows([tinted, clean], state));
    expect(hydrated).not.toContain("Loading adopted files");
    expect(hydrated).toContain('class="count-pill" data-adopted-count>1<');
    expect(hydrated).toMatch(/style="color:var\(--vscode-gitDecoration-submoduleResourceForeground\)">app</);
    expect(hydrated).toContain('style="color:var(--vscode-gitDecoration-modifiedResourceForeground)">M');
  });
});

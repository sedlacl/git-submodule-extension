import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AdoptedTreeNode } from "../src/views/adoptedViewModel.js";
import { BUILTIN_GROUP_LABELS, BUILTIN_PANE_NAME } from "../src/views/builtinGitParity.js";
import { DEFAULT_ROW_ACTION_CONFIG } from "../src/views/changesRowActions.js";
import {
  changesWebviewPage,
  renderChangesTree,
  toChangesWebviewRows,
} from "../src/views/changesWebviewHtml.js";
import { CONTEXT } from "../src/views/constants.js";
import { getProjectRoot } from "./lib/paths.js";

const OUTPUT = path.join(getProjectRoot(), "docs", "changes-with-submodules.png");

const VSCODE_DARK_THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-sideBar-background: #252526;
  --vscode-sideBarSectionHeader-background: #252526;
  --vscode-sideBarSectionHeader-foreground: #bbbbbb;
  --vscode-sideBarSectionHeader-border: #454545;
  --vscode-descriptionForeground: #989898;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #989898;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-focusBorder: #007fd4;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-gitDecoration-modifiedResourceForeground: #e2c08d;
  --vscode-gitDecoration-addedResourceForeground: #73c991;
  --vscode-gitDecoration-deletedResourceForeground: #c74e39;
  --vscode-gitDecoration-renamedResourceForeground: #73c991;
  --vscode-gitDecoration-untrackedResourceForeground: #73c991;
  --vscode-gitDecoration-conflictingResourceForeground: #e4676b;
  --vscode-gitDecoration-submoduleResourceForeground: #8db7e8;
  --vscode-tree-indentGuidesStroke: #585858;
}
`;

function changeFile(id: string, label: string, badge: string, color: string, group: "index" | "workingTree"): AdoptedTreeNode {
  const ctx = group === "index" ? CONTEXT.changeIndex : CONTEXT.changeWorkingTree;
  return {
    id,
    kind: "change",
    label,
    tooltip: label,
    collapsible: false,
    expandByDefault: false,
    contextValue: ctx,
    iconId: "file",
    decoration: { badge, tooltip: badge, themeColorId: color },
    children: [],
  };
}

function adoptedFile(id: string, label: string, badge: string): AdoptedTreeNode {
  return {
    id,
    kind: "file",
    label,
    tooltip: label,
    collapsible: false,
    expandByDefault: false,
    contextValue: CONTEXT.file,
    iconId: "file",
    decoration: { badge, tooltip: badge, themeColorId: "gitDecoration.modifiedResourceForeground" },
    children: [],
  };
}

function buildDemoTree(): AdoptedTreeNode[] {
  const httpendpoint = "/fixture/httpendpoint";
  const httpSub = `${httpendpoint}/submodules/uu_energygateway_httpendpointg01`;
  const commonSub = `${httpendpoint}/submodules/usy_idsmari_commong01`;

  return [
    {
      id: `root:${httpendpoint}`,
      kind: "workspace-root",
      label: "httpendpoint",
      description: "main*+",
      tooltip: "httpendpoint",
      repositoryRoot: httpendpoint,
      collapsible: true,
      expandByDefault: true,
      contextValue: CONTEXT.workspaceRoot,
      iconId: "repo",
      children: [
        {
          id: `group:${httpendpoint}:index`,
          kind: "change-group",
          changeGroup: "index",
          label: BUILTIN_GROUP_LABELS.index,
          description: "1",
          tooltip: BUILTIN_GROUP_LABELS.index,
          collapsible: true,
          expandByDefault: true,
          contextValue: CONTEXT.changeGroupIndex,
          iconId: "",
          children: [
            {
              id: `gitlink:${httpSub}:staged`,
              kind: "change",
              label: "submodules/uu_energygateway_httpendpointg01",
              description: "a1b2c3d → feature/api",
              tooltip: "gitlink",
              collapsible: true,
              expandByDefault: true,
              contextValue: CONTEXT.gitlink,
              iconId: "file-submodule",
              decoration: { badge: "S", tooltip: "Submodule", themeColorId: "gitDecoration.submoduleResourceForeground" },
              children: [
                {
                  id: `adopted:${httpSub}:staged`,
                  kind: "adopted-group",
                  label: "Adopted Changes",
                  description: "3",
                  tooltip: "Adopted Changes",
                  collapsible: true,
                  expandByDefault: true,
                  contextValue: CONTEXT.adoptedGroup,
                  iconId: "",
                  children: [
                    adoptedFile(`file:${httpSub}:1`, "src/HttpEndpoint.js", "M"),
                    adoptedFile(`file:${httpSub}:2`, "package.json", "M"),
                    adoptedFile(`file:${httpSub}:3`, "README.md", "A"),
                  ],
                },
              ],
            },
          ],
        },
        {
          id: `group:${httpendpoint}:workingTree`,
          kind: "change-group",
          changeGroup: "workingTree",
          label: BUILTIN_GROUP_LABELS.workingTree,
          description: "2",
          tooltip: BUILTIN_GROUP_LABELS.workingTree,
          collapsible: true,
          expandByDefault: true,
          contextValue: CONTEXT.changeGroupWorkingTree,
          iconId: "",
          children: [
            {
              id: `gitlink:${commonSub}:unstaged`,
              kind: "change",
              label: "submodules/usy_idsmari_commong01",
              description: "e4f5a6b → main",
              tooltip: "gitlink",
              collapsible: true,
              expandByDefault: true,
              contextValue: CONTEXT.gitlink,
              iconId: "file-submodule",
              decoration: { badge: "S", tooltip: "Submodule", themeColorId: "gitDecoration.submoduleResourceForeground" },
              children: [
                {
                  id: `sub:${commonSub}`,
                  kind: "submodule",
                  label: "usy_idsmari_commong01",
                  description: "main*",
                  repositoryRoot: commonSub,
                  tooltip: "usy_idsmari_commong01",
                  collapsible: true,
                  expandByDefault: true,
                  contextValue: CONTEXT.submodule,
                  iconId: "repo",
                  decoration: { themeColorId: "gitDecoration.submoduleResourceForeground", tooltip: "Submodule" },
                  children: [
                    {
                      id: `group:${commonSub}:workingTree`,
                      kind: "change-group",
                      changeGroup: "workingTree",
                      label: BUILTIN_GROUP_LABELS.workingTree,
                      description: "1",
                      tooltip: BUILTIN_GROUP_LABELS.workingTree,
                      collapsible: true,
                      expandByDefault: true,
                      contextValue: CONTEXT.changeGroupWorkingTree,
                      iconId: "",
                      children: [
                        changeFile(
                          `file:${commonSub}:1`,
                          "src/CommonService.js",
                          "M",
                          "gitDecoration.modifiedResourceForeground",
                          "workingTree",
                        ),
                      ],
                    },
                  ],
                },
              ],
            },
            changeFile(
              `file:${httpendpoint}:1`,
              ".gitmodules",
              "M",
              "gitDecoration.modifiedResourceForeground",
              "workingTree",
            ),
          ],
        },
      ],
    },
    {
      id: "root:/fixture/infra-deploy",
      kind: "workspace-root",
      label: "infra-deploy",
      description: "deploy/prod",
      tooltip: "infra-deploy",
      repositoryRoot: "/fixture/infra-deploy",
      collapsible: true,
      expandByDefault: false,
      contextValue: CONTEXT.workspaceRoot,
      iconId: "repo",
      decoration: { themeColorId: "gitDecoration.submoduleResourceForeground", tooltip: "Descendant changes" },
      children: [],
    },
  ];
}

function buildScreenshotHtml(): string {
  const nodes = buildDemoTree();
  const expanded = new Set<string>();
  for (const node of nodes) {
    expanded.add(node.id);
    for (const child of node.children) {
      expanded.add(child.id);
      for (const grand of child.children) {
        expanded.add(grand.id);
        for (const great of grand.children) {
          expanded.add(great.id);
          for (const gg of great.children) {
            expanded.add(gg.id);
            for (const ggg of gg.children) {
              expanded.add(ggg.id);
            }
          }
        }
      }
    }
  }

  const rows = toChangesWebviewRows(nodes, {
    expanded,
    selected: new Set<string>(),
    drafts: new Map([[ "/fixture/httpendpoint", "feat(httpendpoint): bump energy gateway submodule" ]]),
    placeholders: new Map([[ "/fixture/httpendpoint", 'Message (commit on "main")' ]]),
    generateCommitMessageSupportedRoots: new Set(["/fixture/httpendpoint"]),
    config: DEFAULT_ROW_ACTION_CONFIG,
  });
  const treeHtml = renderChangesTree(rows);
  const codiconCss = pathToFileURL(
    path.join(getProjectRoot(), "node_modules", "@vscode/codicons", "dist", "codicon.css"),
  ).href;
  const page = changesWebviewPage({
    nonce: "screenshot",
    cspSource: "file:",
    codiconCssHref: codiconCss,
    rootHtml: treeHtml,
    generation: 1,
    renderState: "final",
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>${VSCODE_DARK_THEME}
  body { background: #1e1e1e; padding: 0; margin: 0; }
  .frame {
    width: 420px;
    border: 1px solid #454545;
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    margin: 16px;
  }
  .scm-header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 6px 8px 4px;
    background: var(--vscode-sideBarSectionHeader-background);
    color: var(--vscode-sideBarSectionHeader-foreground);
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .scm-header .codicon { opacity: 0.9; }
  .pane-body { background: var(--vscode-sideBar-background); }
  </style>
  <link href="${codiconCss}" rel="stylesheet" />
  ${page.match(/<style>([\s\S]*?)<\/style>/)?.[0] ?? ""}
</head>
<body>
  <div class="frame">
    <div class="scm-header"><i class="codicon codicon-git-commit"></i><span>${BUILTIN_PANE_NAME}</span></div>
    <div class="pane-body">${treeHtml}</div>
  </div>
</body>
</html>`;
}

function resolveChromium(): string {
  const candidates = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
  for (const candidate of candidates) {
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    const resolved = result.stdout?.trim();
    if (resolved) {
      return resolved;
    }
  }
  throw new Error("No Chromium/Chrome binary found for screenshot capture.");
}

function main(): void {
  const html = buildScreenshotHtml();
  const tempDir = fs.mkdtempSync(path.join(getProjectRoot(), "temp", "readme-screenshot-"));
  const htmlPath = path.join(tempDir, "changes-with-submodules.html");
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(htmlPath, html, "utf8");

  const chromium = resolveChromium();
  const result = spawnSync(
    chromium,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=460,860`,
      `--screenshot=${OUTPUT}`,
      pathToFileURL(htmlPath).href,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Screenshot failed with exit ${result.status}`);
  }
  if (!fs.existsSync(OUTPUT)) {
    throw new Error(`Screenshot was not written: ${OUTPUT}`);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`Wrote ${OUTPUT}`);
}

main();

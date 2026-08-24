import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AdoptedTreeNode } from "../src/views/adoptedViewModel.js";
import { BUILTIN_PANE_NAME } from "../src/views/builtinGitParity.js";
import { DEFAULT_ROW_ACTION_CONFIG } from "../src/views/changesRowActions.js";
import {
  changesWebviewPage,
  renderChangesTree,
  toChangesWebviewRows,
} from "../src/views/changesWebviewHtml.js";
import { getProjectRoot } from "./lib/paths.js";
import {
  buildReadmeScreenshotDemoTree,
  README_SCREENSHOT_FORBIDDEN_NAMES,
  readmeScreenshotDemoWebviewOptions,
} from "./readmeScreenshotDemo.js";

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

function collectExpandedIds(nodes: AdoptedTreeNode[]): Set<string> {
  const expanded = new Set<string>();
  const walk = (node: AdoptedTreeNode): void => {
    expanded.add(node.id);
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const node of nodes) {
    walk(node);
  }
  return expanded;
}

function assertNoForbiddenNames(html: string): void {
  const hits = README_SCREENSHOT_FORBIDDEN_NAMES.filter((name) => html.includes(name));
  if (hits.length > 0) {
    throw new Error(`Screenshot HTML contains forbidden repository names: ${hits.join(", ")}`);
  }
}

function buildScreenshotHtml(): string {
  const nodes = buildReadmeScreenshotDemoTree();
  const expanded = collectExpandedIds(nodes);
  const { drafts, placeholders, generateCommitMessageSupportedRoots } = readmeScreenshotDemoWebviewOptions();
  const rows = toChangesWebviewRows(nodes, {
    expanded,
    selected: new Set<string>(),
    drafts,
    placeholders,
    generateCommitMessageSupportedRoots,
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
  const html = `<!DOCTYPE html>
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
  assertNoForbiddenNames(html);
  return html;
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
  const stat = fs.statSync(OUTPUT);
  if (stat.size === 0) {
    throw new Error(`Screenshot is empty: ${OUTPUT}`);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`Wrote ${OUTPUT} (${stat.size} bytes)`);
}

main();

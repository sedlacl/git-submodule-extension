/**
 * Built-in Git labels, menu slots, and intentional webview deviations.
 *
 * Reference: microsoft/vscode `extensions/git` tag **1.96.0**
 * (`package.nls.json`, `src/repository.ts`, `package.json` menus).
 * Public `vscode.git` API only — no proposed SCM APIs.
 */

/** Group titles from `l10n.t(...)` in `extensions/git/src/repository.ts`. */
export const BUILTIN_GROUP_LABELS = {
  merge: "Merge Changes",
  index: "Staged Changes",
  workingTree: "Changes",
  untracked: "Untracked Changes",
} as const;

/** Command titles from `extensions/git/package.nls.json` tag 1.96.0. */
export const BUILTIN_COMMAND_TITLES = {
  refresh: "Refresh",
  openChange: "Open Changes",
  openAllChanges: "Open All Changes",
  openFile: "Open File",
  openHEADFile: "Open File (HEAD)",
  stage: "Stage Changes",
  stageAll: "Stage All Changes",
  stageAllTracked: "Stage All Tracked Changes",
  stageAllUntracked: "Stage All Untracked Changes",
  stageAllMerge: "Stage All Merge Changes",
  unstage: "Unstage Changes",
  unstageAll: "Unstage All Changes",
  clean: "Discard Changes",
  cleanAll: "Discard All Changes",
  cleanAllTracked: "Discard All Tracked Changes",
  cleanAllUntracked: "Discard All Untracked Changes",
  commit: "Commit",
  sync: "Sync",
  publish: "Publish Branch...",
} as const;

export const BUILTIN_PANE_NAME = "CHANGES with submodules";

/**
 * Intentional deviations from built-in Git SCM. Keep this list in sync with
 * `docs/builtin-git-parity.md`. Tests assert both sides.
 */
export const BUILTIN_GIT_DEVIATIONS = [
  {
    id: "treeview-not-sourcecontrol",
    summary:
      "Hierarchy uses an SCM webview named CHANGES with submodules; the built-in Git Changes panel is not replaced or hidden (no stable API).",
  },
  {
    id: "no-proposed-scm-api",
    summary:
      "No scmActionButton, scmMultiDiffEditor, scmValidation, merge editor, or internal git.* command/resource contracts.",
  },
  {
    id: "command-ids",
    summary: "Commands are gitSubmodule.* contributed on this view, not built-in git.* IDs.",
  },
  {
    id: "adopted-changes-group",
    summary:
      "Inner gitlink commit diffs nest under the matching Staged/Changes gitlink row as Adopted Changes, always visible with a pill file count (including 0), with an S badge and a gray commit/branch pointer label; there is no parent-level Adopted Changes group.",
  },
  {
    id: "hierarchical-repos",
    summary: "Child repositories nest under their gitlink parent instead of the built-in flat repository list.",
  },
  {
    id: "status-icons",
    summary:
      "When git.decorations.enabled is false, status ThemeIcons are used instead of shipping copies of Git's status-*.svg assets.",
  },
  {
    id: "no-strikethrough",
    summary:
      "Deleted files use the D decoration only; webview rows do not apply SourceControlResourceDecorations.strikeThrough.",
  },
  {
    id: "gitlink-submoduleof",
    summary:
      "Gitlink click uses public toGitUri(uri, ref) only; built-in submoduleOf git URIs are not part of the public API. Inner file diffs nest under the gitlink row.",
  },
  {
    id: "mutation-handlers",
    summary:
      "Daily mutations use only public vscode.git repository operations; conflict/deletion choices unavailable in that API are fail-closed rather than routed through internal git.* commands.",
  },
  {
    id: "count-badge-scope",
    summary:
      "The built-in Git extension remains the sole owner of the Source Control Activity Bar pending-change count; this WebviewView never sets badge.",
  },
  {
    id: "file-icon-theme-webview",
    summary:
      "Webview loads the active file icon theme's SVG icons for file/folder/change rows. Font-based themes such as Seti fall back to generic file/folder codicons.",
  },
  {
    id: "compact-folder-posix",
    summary:
      "Compact folder labels join with POSIX ` / ` on every platform instead of the OS path separator used by built-in SCM.",
  },
  {
    id: "no-viewitem-menus",
    summary:
      "view/item/context menus do not apply to WebviewView; row toolbar and context actions are rendered in HTML from TypeScript rules and invoke the same gitSubmodule.* commands.",
  },
] as const;

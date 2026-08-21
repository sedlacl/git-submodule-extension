/**
 * Built-in Git labels, menu slots, and intentional TreeView deviations.
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
      "Hierarchy uses a native SCM TreeView named CHANGES with submodules; the built-in Git Changes panel is not replaced or hidden (no stable API).",
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
      "Inner gitlink commit diffs nest under the matching Staged/Changes gitlink row as Adopted Changes, with an S badge and a gray commit/branch pointer label; there is no parent-level Adopted Changes group.",
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
      "TreeView items cannot apply SourceControlResourceDecorations.strikeThrough on vscode ^1.85; deleted files use D decoration only.",
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
      "git.countBadge is applied as a single TreeView badge over every hierarchical repository, not per SourceControl instance.",
  },
] as const;

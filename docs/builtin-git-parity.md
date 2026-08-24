/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

# Built-in Git parity

This extension’s **CHANGES with submodules** pane is a native SCM `TreeView`, not a
`SourceControl` provider. It copies everyday built-in Git vocabulary and
layout from microsoft/vscode `extensions/git` tag **1.96.0**
(`src/repository.ts`, `package.nls.json`, `package.json` menus) while using
only the public `vscode.git` API.

Constants in [`src/views/builtinGitParity.ts`](../src/views/builtinGitParity.ts)
are the machine-checked source for labels and the deviation list below.

## What matches

- Group titles and order: Merge Changes → Staged Changes → Changes → Untracked Changes
- Empty-group rules: `hideWhenEmpty` for merge/untracked; Staged respects
  `git.alwaysShowStagedChangesResourceGroup`; Changes stays visible when empty
- `git.untrackedChanges`: mixed / separate / hidden
- Status letters, tooltip text, and `gitDecoration.*` colors from
  `Resource.getStatusLetter` / `getStatusText` / `getStatusColor`, plus `S` /
  `gitDecoration.submoduleResourceForeground` on gitlink rows
- Compact clickable branch description (`name*` unstaged, `+` staged, `!` merge, matching built-in `headLabel`); upstream details are omitted and Checkout/Fetch/Pull live in the row context menu
- Collapsed repository rows use `gitDecoration.submoduleResourceForeground` when a descendant gitlink or child checkout has changes, so submodule activity stays visible without expanding
- File theme icons when `git.decorations.enabled` is true (default)
- `git.openDiffOnClick`, `git.showInlineOpenFileAction`, `scm.defaultViewMode`,
  `scm.compactFolders`, `git.countBadge`
- Menu titles and inline/context slots for Open / Stage / Unstage / Discard /
  Commit / Refresh / Sync / Publish (command IDs are `gitSubmodule.*`)
- Repository rows expose the same hover toolbar as the built-in Git view:
  Commit, Sync (or Publish without an upstream), Refresh

## Intentional deviations

| id | Deviation |
| --- | --- |
| `treeview-not-sourcecontrol` | Hierarchy uses a native SCM TreeView named CHANGES with submodules; the built-in Git Changes panel is not replaced or hidden (no stable API). Hide it manually in the SCM view title menu. |
| `no-proposed-scm-api` | No `scmActionButton`, `scmMultiDiffEditor`, `scmValidation`, merge editor, or internal `git.*` command/resource contracts. |
| `command-ids` | Commands are `gitSubmodule.*` contributed on this view, not built-in `git.*` IDs. |
| `adopted-changes-group` | Inner gitlink commit diffs nest under the matching Staged/Changes gitlink row as Adopted Changes, always visible with a file count (including 0), with an S badge and a gray commit/branch pointer label; there is no parent-level Adopted Changes group. |
| `hierarchical-repos` | Child repositories nest under their gitlink parent instead of the built-in flat repository list. |
| `status-icons` | When `git.decorations.enabled` is false, status ThemeIcons are used instead of shipping copies of Git’s `status-*.svg` assets. |
| `no-strikethrough` | TreeView items cannot apply `SourceControlResourceDecorations.strikeThrough` on `vscode ^1.85`; deleted files use the D decoration only. |
| `gitlink-submoduleof` | Gitlink click uses public `toGitUri(uri, ref)` only; built-in `submoduleOf` git URIs are not part of the public API. Inner file diffs nest under the gitlink row. |
| `mutation-handlers` | Stage/unstage/discard/commit/sync/publish use only public `vscode.git` repository operations. Conflict/deletion choices unavailable in that API fail closed instead of invoking internal `git.*` commands. |
| `count-badge-scope` | `git.countBadge` is applied as a single TreeView badge over every hierarchical repository, not per SourceControl instance. |

Microsoft copyright remains on copied API declarations in `src/git/git.d.ts`.
Behavior described here is adapted, not forked.

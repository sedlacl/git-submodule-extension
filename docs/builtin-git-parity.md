/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

# Built-in Git parity

This extension’s **Changes** pane is a native SCM `TreeView`, not a
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
  `Resource.getStatusLetter` / `getStatusText` / `getStatusColor`
- Branch description `name*+!` plus `↔ remote/branch` ahead/behind
- File theme icons when `git.decorations.enabled` is true (default)
- `git.openDiffOnClick`, `git.showInlineOpenFileAction`, `scm.defaultViewMode`,
  `scm.compactFolders`, `git.countBadge`
- Menu titles and inline/context slots for Open / Stage / Unstage / Discard /
  Commit / Refresh / Sync / Publish (command IDs are `gitSubmodule.*`)

## Intentional deviations

| id | Deviation |
| --- | --- |
| `treeview-not-sourcecontrol` | Hierarchy uses a native SCM TreeView named Changes; the built-in Git Changes panel is not replaced or hidden (no stable API). Hide it manually in the SCM view title menu. |
| `no-proposed-scm-api` | No `scmActionButton`, `scmMultiDiffEditor`, `scmValidation`, merge editor, or internal `git.*` command/resource contracts. |
| `command-ids` | Commands are `gitSubmodule.*` contributed on this view, not built-in `git.*` IDs. |
| `adopted-changes-group` | Adopted Changes is an extra parent-level group that explains gitlink pointer diffs; the gitlink resource also stays in Staged/Changes. |
| `hierarchical-repos` | Child repositories nest under their gitlink parent instead of the built-in flat repository list. |
| `status-icons` | When `git.decorations.enabled` is false, status ThemeIcons are used instead of shipping copies of Git’s `status-*.svg` assets. |
| `no-strikethrough` | TreeView items cannot apply `SourceControlResourceDecorations.strikeThrough` on `vscode ^1.85`; deleted files use the D decoration only. |
| `gitlink-submoduleof` | Gitlink click uses public `toGitUri(uri, ref)` only; built-in `submoduleOf` git URIs are not part of the public API. Inner file diffs live in Adopted Changes. |
| `mutation-handlers` | Stage/unstage/discard/commit/sync/publish use only public `vscode.git` repository operations. Conflict/deletion choices unavailable in that API fail closed instead of invoking internal `git.*` commands. |
| `count-badge-scope` | `git.countBadge` is applied as a single TreeView badge over every hierarchical repository, not per SourceControl instance. |

Microsoft copyright remains on copied API declarations in `src/git/git.d.ts`.
Behavior described here is adapted, not forked.

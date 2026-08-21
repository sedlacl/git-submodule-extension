/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

# Upstream vscode.git API

This extension consumes the **public** `vscode.git` API (version 1). It does not
call built-in Git command IDs or proposed SCM APIs (`scmActionButton`,
`scmMultiDiffEditor`, `scmValidation`, internal provider hierarchy).

## Copied declarations

| Local file | Upstream | Revision |
| --- | --- | --- |
| [`src/git/git.d.ts`](../src/git/git.d.ts) | [microsoft/vscode `extensions/git/src/api/git.d.ts`](https://github.com/microsoft/vscode/blob/1.96.0/extensions/git/src/api/git.d.ts) | tag **1.96.0**, file commit `d085816005ae61fc8f39b3720b3ec4594b35ecd0` |

`git.d.ts` is a focused public subset (repository state, `Change`/`Status`,
HEAD/upstream, and the mutation/diff methods used by the future command layer).
Unused publisher/credential provider surfaces from the upstream file are omitted.

Microsoft copyright remains on that file. The project license is MIT.

## Behavioral references (not copied)

| Behavior | Upstream | How it is used |
| --- | --- | --- |
| `ApiChange` `uri` / `originalUri` / `renameUri` / `status` | `extensions/git/src/api/api1.ts` at tag 1.96.0 | Snapshot fields on `ResourceChange` |
| Group arrays `merge` / `index` / `workingTree` / `untracked` | `ApiRepositoryState` in the same file | `RepositoryChangeGroups` |
| Status letter, tooltip text, decoration color id | `Resource.getStatusLetter` / `getStatusText` / `getStatusColor` in `extensions/git/src/repository.ts` | `resourceStatusLetter`, `resourceStatusText`, `resourceStatusThemeColorId` |
| Group titles Merge / Staged / Changes / Untracked | Git extension `package.nls.json` | `CHANGE_GROUP_LABELS` |

## Host compatibility

`package.json` engines are `vscode ^1.85.0`. `RepositoryState.untrackedChanges`
exists in the 1.96.0 public API and is **optional** in our declarations. When
the property is missing (1.85 hosts), UNTRACKED and IGNORED entries are split
out of `workingTreeChanges`. When the property is present, including as an
empty array (mixed/hidden untracked settings), the adapter does not regroup.

## Out of scope here

Mutating daily Git actions (stage/commit/sync) and submodule chore commit
summary are later plan items. Visual tree rendering of merge/index/working-tree
groups plus parent-level Adopted Changes lives in `src/views/` and is documented
in [`builtin-git-parity.md`](builtin-git-parity.md).

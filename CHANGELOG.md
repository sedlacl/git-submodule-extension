# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-08-27

### Added

- **Adopted Changes** now expands nested submodule pointers recursively. A gitlink row inside an adopted diff (for example `uu_energygateway_datagatewayg01` under `usy_idsmari_commong01`) is collapsible, carries the `S` badge, and reveals its own Adopted Changes group built from the historical tree SHAs instead of the live pin.

### Changed

- Adopted diffs are read with `git diff --raw --no-abbrev`, so file modes and both object SHAs survive the parse and gitlink pointers are no longer flattened into plain file modifications.
- Adopted groups discovered by lazy expansion get their change counts hydrated, so a newly revealed nested group no longer keeps a loading indicator.

## [0.3.0] - 2026-08-27

### Changed

- **Generate Submodule Chore** for nested submodules builds a deterministic commit body from nested gitlink pointers (no "Note" or "not staged" lines). A single updated leaf uses subject `chore: update <direct>: <leaf subject>`; AI generation runs only for the default multi-leaf message, without a custom prompt.
- **View as Tree / List** no longer writes `scm.defaultViewMode` into workspace or `.vscode` settings. The choice is kept for the session in workspace state; the view still reads `scm.defaultViewMode` (default tree).

## [0.2.1] - 2026-08-26

### Added

- Per-repository HEAD, group, and count diagnostics are logged when refresh completes.
- Explicit `gitSubmodule.refresh` logs the `repository.status()` start and outcome.

### Changed

- Removed the custom WebviewView/Activity Bar badge so the count is owned only by built-in Git.

## [0.2.0] - 2026-08-26

### Added

- Repository Sync button shows the built-in Git `syncLabel` (`N↓ M↑`, including zeros) when the branch is ahead or behind its upstream.
- Sync hover uses the built-in Git `syncTooltip` (for example `Push 1 commits to origin/feature/x`) instead of the generic "Sync" command title.

### Changed

- Sync confirmation matches built-in `git.sync`: it is gated by `git.confirmSync`, skipped for read-only remotes, and offers **OK, Don't Show Again**, which turns the prompt off for the built-in Changes panel too.
- Blocked branch restore names the reason on the row (for example `restore blocked: pinned commit is not an ancestor of origin/aflex/6.3`) while the tooltip keeps the untruncated Git detail.

## [0.1.3] - 2026-08-25

### Fixed

- Packaged VSIX now includes Codicon CSS/font, so Commit, chevrons, and row actions show icons after marketplace install.
- Generate-commit sparkle no longer falls back to the "Cursor cannot target this repo" info icon just because the Git model and `vscode.git` spell the same root differently, and the Cursor command is re-detected when the view becomes visible.
- Repository identity (drafts, busy locks, change grouping, Git API listeners) compares roots as POSIX paths with a normalized drive letter, so Windows `C:\\` vs `c:/` spellings no longer miss each other.

### Changed

- File and folder rows use the active file icon theme (for example Material Icon Theme) instead of generic file/folder codicons, while keeping hierarchical submodule nesting and status letters.
- Compact folder labels always show POSIX `src / util` instead of the host OS separator.

## [0.1.2] - 2026-08-24

### Added

- Extension icon (`media/icon.svg`, `media/icon.png`) with a `build:icon` script that rasterizes the SVG source.

### Changed

- README screenshot regenerated from a static demo dataset (`scripts/readmeScreenshotDemo.ts`) so no real repository names are published.

### Fixed

- Release workflow no longer fails while packaging: it runs `package:ci`, which skips the ImageMagick icon rasterization that is unavailable on the runner.

## [0.1.0] - 2026-08-24

First public release.

### Added

- **CHANGES with submodules** — SCM webview with hierarchical workspace folders and nested submodule repositories under their gitlink parents.
- Built-in-like change groups (Merge, Staged, Changes, Untracked) with status letters, count pills, folder dirty dots, and tree/list layout driven by `scm.defaultViewMode` / `scm.compactFolders`.
- **Adopted Changes** — gitlink pointer diffs nested under the matching Staged/Changes row, with inner commit file lists (`HEAD → index` staged, `index → checkout` unstaged).
- Commit chrome on expanded dirty repositories: message textarea, Generate Commit Message sparkle, and Commit button wired to public `vscode.git` APIs.
- **Generate Submodule Chore** — sparkle builds an editable commit message from pointer diffs; uses a public built-in/Copilot generate-commit-message command for the subject when available.
- Stage, unstage, discard, sync, publish, checkout, fetch, and pull via `gitSubmodule.*` commands and HTML row actions.
- Fail-closed **branch restore** after parent Git operations (`gitSubmodule.restore.enabled`, debounced).
- **Git Submodule** output channel with load diagnostics (`[changes #N]`) and action logs (`[action #N]`) for generate message, stage/unstage/discard, commit, fetch, and related operations.

### Known limitations

- The pane is a sibling SCM webview, not a replacement for the built-in Git **Changes** TreeView — hide the built-in panel manually if you want this view as the daily driver.
- Cursor AI commit-message generation cannot safely target every repository from a multi-root webview; unsupported roots show an info sparkle with guidance to use the built-in SCM input.
- The built-in Git **Changes** panel remains visible (no stable API to replace or hide it).
- Branch restore is fail-closed: it never fetches, initializes missing submodules, updates gitlinks, or writes when any safety check fails.

[Unreleased]: https://github.com/sedlacl/git-submodule-extension/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/sedlacl/git-submodule-extension/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sedlacl/git-submodule-extension/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/sedlacl/git-submodule-extension/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sedlacl/git-submodule-extension/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/sedlacl/git-submodule-extension/compare/v0.0.1...v0.1.0

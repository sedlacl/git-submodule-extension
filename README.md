# Git Submodule Extension

VS Code extension that shows a recursive submodule hierarchy and **Adopted Changes** in Source Control, then safely restores submodule branches after Git operations.

Publisher: `qjohn`. Identifier: `git-submodule-extension`.

## Requirements

- VS Code `^1.85.0`
- Built-in [Git extension](https://marketplace.visualstudio.com/items?itemName=vscode.git) (`vscode.git`)
- A Git binary on the host (the path comes from `vscode.git`)

## What it shows

The built-in Git view is left unchanged. A native SCM `TreeView` named **Submodules** lists:

- workspace folders as siblings (including multi-root workspaces)
- direct and nested submodules under their immediate gitlink parent
- an **Adopted Changes** group on every submodule: staged (`HEAD gitlink → index gitlink`) and unstaged (`index gitlink → checkout HEAD`)
- file rows that open `vscode.diff` (or `vscode.changes` for Open All)

The tree uses native `TreeItem` APIs only (`collapsibleState`, `contextValue`, `resourceUri`, `iconPath`, `command`, menu contributions). File rows rely on the file icon theme plus status decorations; inline actions are hover-only. Row height and indent come from VS Code’s SCM tree (22px / 8px) — there is no webview or custom CSS.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `gitSubmodule.restore.enabled` | `true` | After parent Git checkout/commit/state-change events, run fail-closed branch restore. |
| `gitSubmodule.restore.debounceMs` | `250` | Coalesce bursty Git events before a restore pass (`0`–`10000`). |

The generated UI fixture workspace sets `gitSubmodule.restore.enabled` to `false` so detached/dirty scenarios stay visible. Product default remains **auto-safe on**.

## Commands

- **Git Submodule: Refresh** — reload the tree
- **Git Submodule: Retry Branch Restore** — explicit retry (never fetches)
- **Git Submodule: Fetch Submodule Remote** — `git fetch origin <branch>` after a modal confirmation; never runs automatically
- Open Diff / Open All Changes — tree item actions

Blocked restore cases appear on the submodule row, in the **Git Submodule** output channel, and on the status bar.

## Security guarantees

Restore is fail-closed. Automatic work never does fetch, pull, push, commit, force, discard, or working-tree reset.

A child is attached (`git switch -C <branch> <pin>` plus upstream) only when all of these hold, re-checked immediately before the write:

- target branch comes from committed `HEAD:.gitmodules`
- target SHA comes from the current parent HEAD gitlink
- child is an initialized Git worktree at the declared path
- no Git operation is in progress
- working tree is clean
- `origin` exists
- the pin object and `origin/<branch>` exist locally
- the pin is an ancestor of `origin/<branch>`
- the local branch has no unique commits versus `origin/<branch>`

If any check fails, the child is left untouched and the reason is shown. Retry repeats the same checks. Fetch is a separate, confirmed command.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:extension-host
npm run package
```

### Isolated UI harness

`npm run dev:ui` starts esbuild watch and an Extension Development Host with an empty profile (`--user-data-dir` / `--extensions-dir` under `.vscode-test/`). Only this extension is loaded besides the built-in Git provider.

```bash
npm run create-ui-fixture   # generate fixtures/ui if missing
npm run dev:ui:reset        # wipe and regenerate the fixture
npm run dev:ui
```

The harness opens `fixtures/ui/ui-dev.code-workspace`:

- `httpendpoint` — two direct submodules, one nested (staged/unstaged pointer, dirty, detached)
- `infra-deploy` — repeated checkouts of the same sources under `#t1/#t2/#prod` on different branches
- `plain-app` / `plain-lib` — top-level repos without submodules

Fixture remotes are local `file://` paths. Nothing touches real application repositories.

To try auto-restore in the harness, set `gitSubmodule.restore.enabled` to `true` in that workspace. To inspect the same layout in Cursor, use the same empty profile flags and `--extensionDevelopmentPath`.

### Extension Development Host tests

`npm run test:extension-host` downloads the engine VS Code, opens the fixture workspace in an isolated profile, activates the extension, and checks contributed commands plus SCM refresh. It needs a desktop session that can launch VS Code.

## Current limits

- The built-in Git SCM provider cannot be extended; this is a sibling tree in the SCM panel.
- Restore never updates gitlinks, never initializes missing submodules, and never fetches automatically.
- Nested restore walks committed gitlinks only, with a depth cap of 32 and cycle guards.
- Adopted file diffs compare commits inside the child repository; they are not a substitute for `git submodule update`.
- Real application workspaces should keep restore disabled until you have reviewed the tree (`gitSubmodule.restore.enabled: false`).

## License

MIT — see [LICENSE](LICENSE).

## Repository

https://github.com/sedlacl/git-submodule-extension

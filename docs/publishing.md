# Publishing checklist

First public release and every follow-up use the same flow. `package.json` `version` is the single source of truth.

## One-time setup

1. Create an [Open VSX access token](https://open-vsx.org/user-settings/tokens) for publisher **`qjohn`**.
2. In GitHub → **Settings → Secrets and variables → Actions**, add repository secret **`OVSX_PAT`** with that token.
3. Confirm `package.json` has valid `publisher`, `name`, `displayName`, `license`, `repository`, and `icon` fields.

## Release steps (maintainer)

1. **Bump version** (no git tag from npm):
   ```bash
   npm run version:minor    # or version:patch / version:major
   npm run version:set -- 0.1.0   # explicit semver when needed
   ```
2. **Update `CHANGELOG.md`** — new `[X.Y.Z]` section with date and user-facing notes.
3. **Commit** version + changelog (+ README/screenshot if changed).
4. **Tag and push**:
   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```
5. GitHub Actions workflow **Release** (trigger: tag `v*`) runs `npm ci`, lint, typecheck, test, `npm run package:ci`, uploads the `.vsix` to the GitHub Release, and publishes to Open VSX with `OVSX_PAT`.

CI uses `package:ci`, which skips `build:icon` because the runner has no ImageMagick. After editing `media/icon.svg`, run `npm run build:icon` locally and commit the regenerated `media/icon.png`.

Primary trigger: **git tag `v*`** (for example `v0.1.0`). Do not publish with tokens pasted into chat or committed to the repo.

## Local verification (before tagging)

```bash
npm ci
npm run build:icon   # ImageMagick convert: media/icon.svg -> media/icon.png (128x128)
npm run typecheck
npm run lint
npm test
npm run package
```

Expected VSIX name: `git-submodule-extension-<version>.vsix` (for example `git-submodule-extension-0.1.0.vsix`).

## Install paths for users

- **Open VSX** (after publish): search *Git Submodule Extension* or install `qjohn.git-submodule-extension`.
- **VSIX file**: download from GitHub Releases or `npm run package`, then *Extensions → … → Install from VSIX…*.

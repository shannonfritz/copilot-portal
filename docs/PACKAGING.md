# Packaging & Releases

## Quick Reference

```bash
npm run package
```

This single command does everything: bumps the build number, builds the server and UI,
stages release files, and creates a versioned zip in `releases/`.

## What It Does

1. **Bumps BUILD** — `BUILD` file tracks `YYMMDD-NN` format (e.g. `260323-01`).
   Counter resets to 01 each day, increments within the same day.

2. **Builds** — Runs `npm run build` which compiles the server (esbuild) and UI (vite).
   The build stamp (`__VERSION__` and `__BUILD__`) is embedded at compile time.

3. **Stages files** — Copies release-relevant files to a temp directory:
   - `dist/` — compiled server, launcher, and web UI
   - `patches/` — SDK compatibility patches (applied by `postinstall`)
   - `package.json` — release version (from `package.dist.json`, not the dev one)
   - `patch.mjs` — fallback patch script
   - `start-portal.cmd` / `start-portal.sh` — single entry point for users
   - `README.md`, `CHANGELOG.md`, `BUILD`

4. **Creates zip** — `releases/copilot-portal-v{version}-build-{build}.zip`

5. **Cleans up** — Removes the temp staging directory

## After Packaging

```bash
# Commit the bumped BUILD file
git add BUILD && git commit -m "Bump build"
```

The zip is in `releases/` — distribute via GitHub Releases or other channels.

## Release Checklist

1. **Bump version** — `npm version minor` (or `patch`). This updates `package.json` only.
2. **Build & package** — `npm run package` (auto-syncs version to `package.dist.json`)
3. **Update CHANGELOG.md** — Add release notes under the new version heading.
4. **Commit & tag** — `git add -A && git commit -m "vX.Y.Z" && git tag vX.Y.Z`
5. **Push** — `git push origin master --tags`
6. **Create GitHub release** — `gh release create vX.Y.Z releases/copilot-portal-vX.Y.Z-build-*.zip --title "vX.Y.Z — Title"`

### If a release has a bug

1. Fix the issue, bump patch version (`npm version patch` + sync `package.dist.json`)
2. Merge the old release notes into the new version in CHANGELOG.md
3. Mark the broken version as "Superseded by vX.Y.Z" in the changelog
4. Delete the broken GitHub release: `gh release delete vX.Y.Z --yes --cleanup-tag`
5. Publish the new release

## Versioning Scheme

- **Version** (semver) — Lives in `package.json` AND `package.dist.json` (keep in sync!).
  Bump when shipping a significant feature set.

- **Build** (daily counter) — Lives in `BUILD` file, auto-incremented on each `npm run package`.
  Format: `YYMMDD-NN` (e.g. `260323-03` = third build on March 23, 2026).

- **Zip name** — `copilot-portal-v{version}-build-{build}.zip`

- **UI display** — Shows `v0.6.1 · 260430-04` in the session drawer.

## What's In the Release vs Dev Repo

| File | In release | In dev repo | Notes |
|------|-----------|-------------|-------|
| `dist/` | ✅ | ✅ | Compiled output |
| `patches/` | ✅ | ✅ | SDK patches |
| `package.json` | ✅ (from `package.dist.json`) | ✅ (dev version) | Different! Release has fewer deps, no build tools |
| `start-portal.cmd/.sh` | ✅ | ✅ | User entry point |
| `patch.mjs` | ✅ | ✅ | Fallback patch |
| `README.md` | ✅ | ✅ | |
| `CHANGELOG.md` | ✅ | ✅ | |
| `BUILD` | ✅ | ✅ | |
| `src/` | ❌ | ✅ | TypeScript source |
| `webui/` | ❌ | ✅ | React source |
| `node_modules/` | ❌ | ✅ | Dev deps; release users run `npm install` |
| `esbuild.cjs` | ❌ | ✅ | Build tooling |
| `package.mjs` | ❌ | ✅ | This packaging script |
| `docs/` | ❌ | ✅ | Internal planning docs |
| `data/` | ❌ | ❌ | Runtime data (gitignored), never in zip |

## package.dist.json vs package.json

The dev `package.json` has build tools (esbuild, typescript, vite, etc.) as devDependencies.
The release `package.dist.json` is a minimal version that becomes `package.json` in the zip:

- Only runtime dependencies (`@github/copilot-sdk`, `ws`, `qrcode`, `patch-package`)
- `scripts.start` points to `dist/launcher.js`
- `postinstall` runs `patch-package` to apply SDK compatibility patches
- No build scripts (release is pre-built)

⚠️ **Version is auto-synced.** `npm run package` copies the version from `package.json`
into `package.dist.json` automatically. If they differ, it logs a warning during packaging.

## User Experience

End users:
1. Unzip
2. Double-click `start-portal.cmd` (or `./start-portal.sh`)
3. First run: installs Node.js (if needed), npm dependencies, checks PowerShell 7, GitHub auth
4. Subsequent runs: skips checks, starts immediately

## Update Flow

The portal checks for SDK/CLI updates every 4 hours and portal releases via GitHub Releases.

### SDK/CLI Updates
1. Banner in UI shows available updates with version info
2. User clicks "Update" → server runs `npm install pkg@latest` (fire-and-forget)
3. Client polls `/api/updates` every 3s until complete
4. Green "Restart" button appears when done (even if update failed)
5. Launcher detects CLI version change → stops old CLI → restarts with new binary
6. If credentials expired, portal auto-runs `copilot login` and restarts client

### Portal Self-Updates
1. Banner shows "Portal vX.Y.Z → vA.B.C"
2. User clicks "Update" → server downloads zip from GitHub Releases, extracts over existing files
3. "Restart" button appears → server restarts with new code
4. Client's WS reconnects automatically; stale update banners are cleared

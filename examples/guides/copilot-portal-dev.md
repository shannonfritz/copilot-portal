# Copilot Portal Development

This is the copilot-portal project — a web portal for GitHub Copilot CLI sessions.

## Quick Reference

- **Build:** `npm run build` (esbuild for server, vite for UI)
- **Package release:** `npm run package` (creates zip in releases/)
- **Start server:** `npm start` (runs launcher which starts CLI server + portal)
- **Project root:** (the directory where you cloned the repo)

## Read These Docs

Before making changes, read the relevant docs in the `docs/` folder:
- `docs/ARCHITECTURE.md` — system overview
- `docs/ROADMAP.md` — planned features and priorities
- `docs/CODE_REVIEW.md` — known issues and deferred fixes
- `docs/PACKAGING.md` — how releases are built and distributed
- `docs/cli-server-mode.md` — how the CLI server connection works

## Key Files

| File | What it does |
|------|-------------|
| `src/server.ts` | HTTP + WebSocket server, API endpoints |
| `src/session.ts` | Session management, event handling, history parsing |
| `src/launcher.ts` | Process launcher, CLI server management |
| `src/main.ts` | Entry point, console key commands |
| `src/updater.ts` | SDK/CLI update checker |
| `webui/src/App.tsx` | Entire React UI (~2400 lines, single file) |
| `package.mjs` | Release packaging script |
| `start-portal.cmd` | User entry point (Windows) |

## Conventions

- Commit messages: include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
- Use ASCII only in .cmd files (no em dashes, special chars)
- Use `pwsh` not `powershell` for PowerShell 7 commands
- Use `node esbuild.cjs --production` for quick server-only builds
- Full build: `npm run build` (server + UI)
- Test by restarting the server and refreshing the portal in a browser
- The BUILD file stores `YYMMDD-NN` format, auto-incremented by package.mjs

## Architecture Summary

The portal runs in "connected" mode by default:
1. Launcher starts a headless CLI server (`copilot --server --port 3848`)
2. Portal server connects to it via the SDK (`CopilotClient({ cliUrl })`)
3. Browser clients connect to the portal via WebSocket (port 3847)
4. Events flow: CLI server ↔ SDK ↔ Portal server ↔ WebSocket ↔ Browser

Fallback: `--standalone` mode spawns its own CLI subprocess.

## Current State

Check `docs/ROADMAP.md` for what's done and what's planned.
Check `docs/CODE_REVIEW.md` for known technical debt.
Run `git log --oneline -20` to see recent changes.

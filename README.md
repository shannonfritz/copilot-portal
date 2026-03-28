# Copilot Portal

A mobile-friendly web portal for GitHub Copilot CLI sessions. Start the server on your desktop, then open the URL on any device on your local network.

## Prerequisites

- [Node.js](https://nodejs.org/) v22 or later
- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) installed via winget (`winget install GitHub.CopilotCLI`)

## Setup

1. Unzip this package to a folder of your choice.
2. Double-click `start-portal.cmd` (Windows) or run `sh start-portal.sh` (Mac/Linux).

   On first run, the script will:
   - Install npm dependencies
   - Check for PowerShell 7 (suggests install if missing)
   - Sign you in to GitHub (opens a browser window if needed)
   - Start the Copilot CLI server in the background
   - Start the portal server

3. The console will print a URL and QR code:
   ```
   Open: http://192.168.1.42:3847?token=abc123...
   ```
   Open that URL in any browser on your local network.

## Console Commands

While running, press a key:
- `q` — Show QR code
- `u` — Show portal URL
- `r` — Restart server
- `x` — Exit

## Architecture

The portal runs in **shared mode** by default:
- A headless Copilot CLI server runs in the background (port 3848)
- The portal server connects to it via the SDK (port 3847)
- Messages sent from the portal are visible in any CLI session, and vice versa

Use `--standalone` to run without the CLI server (portal spawns its own subprocess).

### Advanced: Using with CLI TUI

If you want both the full CLI terminal experience AND the portal:

1. Start the CLI with its built-in server:
   ```
   copilot --ui-server --port 3848
   ```
2. In another terminal, start the portal:
   ```
   start-portal.cmd
   ```

The portal will detect the running CLI server and connect to it. Both the
CLI TUI and the portal are live on the same sessions — messages sent from
either side are immediately visible to both.

This is useful when you want to start work in the CLI and monitor or
continue from your phone via the portal.

## Port

The default port is `3847`. To use a different port, pass `--port`:

```
npm start -- --port 8080
```

## Security

The URL includes a random access token generated on first run and saved to `data/token.txt`. Anyone with the URL can access your Copilot sessions, so keep it on a trusted local network.

To rotate the token (invalidate existing URLs), delete `data/token.txt` and restart the server — a new token will be generated automatically.

## Stopping the server

Press `x` in the console, or `Ctrl+C`. The background CLI server is automatically stopped when the portal exits.

---

## Development

These sections are for contributors working from the source repository.

### Building from source

```bash
npm install          # install dependencies
npm run build        # build server + web UI
```

### Packaging a release

```bash
npm run package
```

This will:
1. Increment the build number in `BUILD`
2. Build the server and web UI
3. Create a distributable zip: `copilot-portal-v0.2.0-build-260319-02.zip`

The zip contains everything an end user needs — no dev dependencies or source code.

### Versioning

The project uses two identifiers shown in the portal title bar:

- **Version** (`v0.2.0`) — from `package.json`. Bump manually when cutting a release.
- **Build** (`260319-02`) — `YYMMDD-NN` format, auto-incremented by `npm run package`. The `BUILD` file in the repo tracks the current number.

For GitHub Releases, attach the zip and use the version as the tag (e.g. `v0.2.0`). Multiple builds can exist for the same version during development.

### Project structure

```
src/           Server source (TypeScript → dist/server.js)
webui/src/     Frontend source (React + Vite → dist/webui/)
BUILD          Current build number
package.mjs    Packaging script
patch.mjs      Post-install SDK compatibility patch
```

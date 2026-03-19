# Copilot Portal

A mobile-friendly web portal for GitHub Copilot CLI sessions. Start the server on your desktop, then open the URL on any device on your local network.

## Prerequisites

- [Node.js](https://nodejs.org/) v22 or later

That's it — the installer handles everything else (including GitHub authentication).

## Setup

1. Unzip this package to a folder of your choice.
2. Open a terminal in that folder.
3. Run the installer:

   **Windows:**
   ```
   install.cmd
   ```

   **Mac / Linux:**
   ```
   sh install.sh
   ```

   The installer will:
   - Install npm dependencies (includes the Copilot CLI engine)
   - Apply a compatibility patch
   - Sign you in to GitHub (opens a browser window if needed)

4. Start the server:

   **Windows:**
   ```
   start-and-launch.cmd
   ```

   **Mac / Linux:**
   ```
   sh start-and-launch.sh
   ```

5. The console will print a URL and QR code, e.g.:
   ```
   Open: http://192.168.1.42:3847?token=abc123...
   ```
   Open that URL in any browser on your local network.

## Port

The default port is `3847`. To use a different port, pass `--port`:

```
node dist/server.js --port 8080
```

## Security

The URL includes a random access token generated on first run and saved to `data/token.txt`. Anyone with the URL can access your Copilot sessions, so keep it on a trusted local network.

To rotate the token (invalidate existing URLs), delete `data/token.txt` and restart the server — a new token will be generated automatically.

## Stopping the server

Press `Ctrl+C` in the terminal.

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

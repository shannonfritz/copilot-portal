# Copilot Portal

A mobile-friendly web portal for GitHub Copilot CLI sessions. Start the server on your desktop, then open the URL on any device on your local network.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [GitHub Copilot CLI](https://github.com/github/copilot-cli), signed in:
  ```
  winget install GitHub.Copilot
  copilot auth login
  ```

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

4. Start the server:

   **Windows:**
   ```
   start.cmd
   ```
   To also open the portal automatically in your browser:
   ```
   start-and-launch.cmd
   ```

   **Mac / Linux:**
   ```
   sh start.sh
   ```
   To also open the portal automatically in your browser:
   ```
   sh start-and-launch.sh
   ```

4. The console will print a URL and QR code, e.g.:
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

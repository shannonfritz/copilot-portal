# Copilot Portal

A mobile-friendly web portal for GitHub Copilot CLI sessions. Start the server on your PC, then open the URL on any device — same network via QR code, or anywhere via DevTunnels.

## Features

- **Chat with Copilot** — full session management, model switching, tool approvals
- **Image attachments** — paste, drag & drop, or pick images to include in messages
- **Context window bar** — visual breakdown of token usage (system, messages, free space)
- **Rich model picker** — context size, vision/thinking support, and cost multiplier per model
- **Agent picker** — select custom agents from `~/.copilot/agents/` or `.github/agents/`
- **Guides & Prompts** — markdown instructions and canned prompts, import from Gists
- **Working directory** — browse and change per-session CWD with folder picker
- **Themes** — per-session color themes with randomizer
- **Mobile-first** — responsive design, PWA support, touch-friendly
- **Multi-device** — use the same session from PC and phone simultaneously
- **In-portal updates** — check for and apply CLI/SDK updates without leaving the browser
- **Remote access** — DevTunnel integration for HTTPS access from anywhere
- **Run in a container** — optional headless/NAS deployment via a published Docker image (TrueNAS SCALE, Synology, any Docker host)

## Dependencies

Copilot Portal installs what it needs on first run. If **Node.js 22+** or **PowerShell 7** (optional — used by the Copilot CLI to run some tools) aren't already present, they're installed via `winget`, which may prompt for elevation (UAC). The **Copilot CLI** itself ships bundled as an npm dependency, so there's nothing to install separately.

You do need a **GitHub account with Copilot access** — check at [github.com/settings/copilot](https://github.com/settings/copilot).

For an always-on headless/NAS deployment instead, jump to [Run in a container](#run-in-a-container-headless--nas).

## Getting Started (Windows)

Open **PowerShell** and run the one-line installer:

```powershell
powershell -ex bypass "iex (irm https://aka.ms/copilotportal-install)"
```

A small installer window downloads the latest release, ensures Node.js is present, and creates Start Menu / Desktop shortcuts. Click **Open Portal** when it finishes — your browser opens to the GitHub sign-in screen automatically.

### Manual install (any platform)

Prefer to do it by hand, or on macOS/Linux?

1. Download and unzip the [latest release](https://github.com/shannonfritz/copilot-portal/releases/latest) to a folder (e.g. `C:\copilot-portal`).
2. Run `start-portal.cmd` (Windows) or `sh start-portal.sh` (macOS/Linux).
3. Sign in to **GitHub** from the browser when it opens.

On first run, the script will:
- Install **Node.js** and (optionally) **PowerShell 7** via winget if missing — restart the terminal after a Node install
- Install npm dependencies (including the bundled Copilot CLI)
- Start the server and open your browser to the sign-in screen (auto-launch is on by default; toggle with **`L`**, or press **`l`** to open it anytime)

<a href="img/screenshot-sessions.png"><img src="img/screenshot-sessions.png" width="800" alt="Session picker"></a>

<p>
<a href="img/screenshot-tools.png"><img src="img/screenshot-tools.png" width="395" alt="Tool summaries"></a>
<a href="img/screenshot-approvals.png"><img src="img/screenshot-approvals.png" width="395" alt="Approval flow"></a>
</p>

## Run in a container (headless / NAS)

Prefer an always-on, headless deployment (TrueNAS SCALE, Synology, or any Docker
host)? A published image bundles the portal **and** the Copilot CLI with a ready
agent toolset (Python/`uv`, `git`, `gh`, `jq`, PowerShell, …):

```bash
docker run -d -p 3847:3847 \
  -v copilot-home:/home/copilot \
  -v portal-data:/app/data \
  -v "$(pwd)/work:/work" \
  ghcr.io/shannonfritz/copilot-portal:latest
# then open http://<host>:3847 and sign in to GitHub from the web UI
```

Or use the repo's `docker-compose.yml`. Auth, sessions, and agent-installed tools
persist in the `copilot-home` volume across image updates. See
**[docs/DOCKER.md](docs/DOCKER.md)** for the full guide — volumes, authentication,
the TrueNAS Custom App walkthrough, sharing `/work` over SMB, and updates.

## Console Keys

While the server is running, press a key in the terminal:

| | Access | | Server |
|---|---|---|---|
| **q** | QR code & URL | **c** | CLI console |
| **l** | Launch browser | **u** | Check updates |
| **L** | Auto-launch on/off | **r** | Restart |
| **t** | Start/stop tunnel | **T** | Security reset |
| | | **x** | Exit |

**Auto-launch** (Shift+L) toggles whether the browser opens automatically when the server is ready. It's on by default; turn it off if you'd rather reuse an already-open tab (handy when restarting during development).

**Tunnel** creates a DevTunnel for remote access (HTTPS from anywhere). Press **t** to start, **t** again to stop. First time, it asks about access settings. The tunnel auto-restarts after a server restart.

**Security reset** (Shift+T) destroys the tunnel, rotates the access token, and disconnects all clients. Use if a URL was compromised. Press **q** for a new QR code, then **t** for a new tunnel.

<a href="img/screenshot-console.png"><img src="img/screenshot-console.png" width="800" alt="Console keys"></a>

## Guides & Prompts

Guides are markdown files that teach Copilot how to behave for a session. Prompts are canned queries that appear in an overlay above the message box.

- Click the map icon in the header to browse, apply, edit, or create guides and prompts
- **+ New** — start from scratch, pick from example templates, or import from a GitHub Gist URL
- Prompts float above the input area without resizing the chat
- Files live in `data/guides/` and `data/prompts/` — same filename pairs them
- Prompts stack across multiple sources and persist per session

<p>
<a href="img/screenshot-guides.png"><img src="img/screenshot-guides.png" width="395" alt="Guides panel"></a>
<a href="img/screenshot-prompts.png"><img src="img/screenshot-prompts.png" width="395" alt="Prompts tray"></a>
</p>

### Importing

Share guides via GitHub Gists using the naming convention:
```
my-guide_guide.md       → guide content
my-guide_prompts.md     → companion prompts
```

Import via **+ New → Import from URL** in the portal.

## Mobile & PWA

- Scan the QR code to open on your phone (same network)
- Use Share → Add to Home Screen for a standalone app experience
- Press **t** in the terminal for remote access via DevTunnel

<p>
<a href="img/screenshot-mobile1.png"><img src="img/screenshot-mobile1.png" width="260" alt="Mobile chat"></a>
<a href="img/screenshot-mobile2.png"><img src="img/screenshot-mobile2.png" width="260" alt="Mobile approvals"></a>
<a href="img/screenshot-mobile3.png"><img src="img/screenshot-mobile3.png" width="260" alt="Mobile session"></a>
</p>

## Security

- All API and WebSocket endpoints require a token (generated on first run, saved to `data/token.txt`)
- Security headers: CSP, HSTS (over tunnel), X-Frame-Options, referrer policy
- Rate limiting on failed auth attempts
- Press **T** to rotate the token and revoke all access

## Architecture

The portal connects to a headless Copilot CLI server running in the background. Messages are bidirectional — the CLI console and portal share the same sessions.

```mermaid
graph TD
    Browser["📱 Browser / PWA"] -->|"ws:// (LAN)"| Portal["Portal Server :3847"]
    Phone["📱 Mobile"] -->|"wss:// (tunnel)"| Tunnel["🌐 DevTunnel"]
    Tunnel -->|HTTPS| Portal
    Portal -->|SDK JSON-RPC| CLI["Copilot CLI :3848"]
```

<details>
<summary>ASCII version</summary>

```
  📱 Browser / PWA          📱 Mobile
        │                       │
    ws:// (LAN)          wss:// (tunnel)
        │                       │
        ▼                       ▼
  Portal Server :3847 ◄── 🌐 DevTunnel
        │
   SDK JSON-RPC
        │
        ▼
  Copilot CLI :3848
```
</details>

## Configuration

| Flag | Default | Description |
|---|---|---|
| `--port N` | 3847 | Portal server port |
| `--cli-url URL` | auto | Connect to a specific CLI server |
| `--data DIR` | `data/` | Data directory for token, rules, guides |
| `--new-token` | — | Generate a new access token on start |
| `--launch` | — | Open browser on start |
| `--no-qr` | — | Suppress QR code output |

---

## Development

For contributors working from the source repository.

```bash
npm install          # install dependencies
npm run build        # build server + web UI
npm run package      # create release zip
```

### Versioning

- **Version** (`v0.8.0`) — semver in `package.json`, bumped for releases
- **Build** (`260414-01`) — `YYMMDD-NN` in `BUILD`, auto-incremented by `npm run package`

### Project Structure

```
src/              Server source (TypeScript)
webui/src/        React UI source
dist/             Compiled output
examples/         Shipped guide/prompt templates (read-only)
data/             User runtime data (gitignored)
docs/             Design docs and specs
```

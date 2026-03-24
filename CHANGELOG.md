# Changelog

All notable changes to Copilot Portal are documented here.

## v0.3.0

### Shared CLI Server Mode
- Portal now connects to a headless Copilot CLI server (`--server` mode) by default
- CLI launches automatically in the background — no extra terminal window
- Bidirectional sync: messages sent from portal or CLI are immediately visible to both
- `--standalone` flag available for fallback to the old subprocess model
- CLI server PID tracked and cleaned up on portal shutdown
- Graceful handling: CLI stays alive across portal restarts, killed on exit

### Startup & Console
- Single entry point: `start-portal.cmd` handles install, auth, and server launch
- PowerShell 7 check in installer with optional auto-install via winget
- Console key commands: `[q]` QR code, `[u]` URL, `[r]` Restart, `[x]` Exit
- Terminal tab title set to "Copilot Portal"
- Port conflict detection on startup
- Version and update status logged on startup

### Message Rendering Redesign
- Intermediate messages shown as full message bubbles with dashed border (was collapsed)
- Messages and tool events interleaved by timestamp (was separate blocks)
- Intermediate detection uses SDK `toolRequests` property (reliable, consistent live/history)
- ask_user questions show in chat with collapsed "📋 N options" summary
- ask_user excluded from tool summaries (represented by prompt UI instead)
- Empty assistant messages (tool-dispatch-only) filtered from rendering

### Update Management
- `npm install @latest` for updates (was `npm update` which couldn't cross semver boundaries)
- Skip build step on release packages (pre-built, no build script)
- Force restart banner after update apply (client-side override)

### Packaging & Releases
- Output directory renamed from `builds/` to `releases/`
- Daily build counter resets (BUILD file stores YYMMDD-NN format)
- CHANGELOG.md included in release zip
- Favicon (Copilot logo SVG)
- Fixed zip packaging to include all files (not just dist/)

### Documentation
- `docs/ROADMAP.md` — prioritized feature list
- `docs/cli-server-mode.md` — research, test results, implementation plan
- `docs/PACKAGING.md` — how to build and distribute releases

## v0.2.0

### Setup & Distribution
- Streamlined install: only Node.js required as a prerequisite
- SDK bundles the Copilot CLI binary — no separate `winget install` needed
- Install script handles npm install, SDK patching, and GitHub sign-in automatically
- `npm run package` creates versioned distributable zips (`copilot-portal-v0.2.0-build-YYMMDD-NN.zip`)
- Build versioning: `YYMMDD-NN` build number shown in portal title bar alongside semver

### Session Management
- Bidirectional CLI ↔ Portal sync: messages, tool events, and thinking state stay in sync
  when switching between CLI and portal on the same session
- Session picker with live session list, creation, and switching
- History pagination: default 50 messages with dynamic load-more (+150 / half / ALL)
- Persist approveAll (yolo) toggle per session alongside approval rules
- Custom model selection per session

### Approvals & Permissions
- Approval queuing: one approval at a time, auto-advance on resolve
- "Allow Always" rules with computed patterns (shell commands, file paths, MCP tools, URLs)
- Rules drawer: view, delete individual, or clear all; header button shows rule count
- Batch auto-resolve: "Allow Always" sweeps matching queued approvals

### ask_user Interactive Prompts
- Questions render as normal messages (not intermediate thought bubbles)
- Multiple-choice rendering with ●/○ indicators for selected/unselected options
- Collapsible "👉 Selected" header showing the user's answer
- Freeform text input support
- Full history reconstruction of ask_user interactions

### Tool Events
- Expandable tool call boxes with name, arguments, and result
- Tool summaries attached to completed messages (history and live)
- `report_intent` meta-tool filtered from summaries
- Persistent thinking indicator during tool execution gaps
- Failed tool styling (red border)

### Rendering & UI
- CSS variables for all colors (18 semantic variables)
- Markdown rendering with syntax-highlighted code blocks, tables, and lists
- Copy button on all messages (clipboard API + execCommand fallback for HTTP)
- KiB byte counter on completed messages
- Auto-grow textarea for multi-line input
- Notification banners for context events (truncation, compaction, snapshot rewind)
- Auto-scroll to notifications and new content

### Connection Reliability
- WebSocket heartbeat (ping/pong every 30s) to detect stale connections
- Immediate ping on page visibility/focus change — no more false "connected" state
- Auto-reconnect on disconnect with exponential backoff
- iOS Safari reconnect on visibility change and page show events
- Connection status indicator (green/amber/red dot) in header

### Security
- Token-based access control on all WebSocket and HTTP API endpoints
- Token generated on first run, persisted to `data/token.txt`
- QR code printed in terminal for easy mobile access

## v0.1.0

### Initial Release
- Standalone Node.js server bridging the GitHub Copilot SDK to a browser via WebSocket
- Mobile-friendly responsive web UI (React + Tailwind CSS)
- Real-time streaming of assistant responses
- Session history loading and display
- Basic approval flow for tool execution permissions
- QR code for local network access
- Originally derived from a VS Code extension prototype, rebuilt as a standalone server

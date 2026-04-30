# Changelog

All notable changes to Copilot Portal are documented here.

## v0.6.0

### 🖼️ Image Support
- Paste, drag & drop, or pick images to attach to messages
- Inline display with click-to-expand lightbox
- Images persist in history across reloads and reconnects

### 📊 Context Window Usage
- Visual bar showing system/tools, messages, and free space with token counts
- Integrated above the model selector in the drawer

### 🤖 Rich Model Picker
- Shows context window size, vision/thinking support, and cost multiplier per model
- Connected-edge dropdown styling for model, agent, and prompts pickers
- Click-away dismiss on all picker dropdowns

### 💬 Prompts Overlay
- Prompts tray floats above the input area (no chat window resize)
- Consistent overlay behavior matching model and agent pickers

### 🔄 Update & Restart Flow
- In-portal updates reliably restart CLI with new binary version
- Auto-login when credentials expire at startup
- Build mismatch detection between client and server
- Fire-and-forget npm install (no client timeout on long installs)
- Restart button always shown after update cycle completes

### 🔌 Reconnect Improvements
- Skip redundant history replay on reconnect (no flicker or focus loss)
- Accept new history when messages arrive from another device
- Prevent duplicate connections from concurrent visibility/focus events
- Fix stale heartbeat timers on mobile (frozen timer race condition)

### 🐛 Fixes
- Tool summaries now appear correctly after page reload
- Image-only messages no longer hidden in chat history
- Short responses no longer dropped by dedup
- Model change detection handles SDK's `newModel` field
- Auth check handles camelCase keys and comments in config.json
- Session title fades gracefully when too long for drawer

### 💅 UI Polish
- Input buttons in 2×2 grid (image, recall/clear, send)
- CWD copy button with clipboard fallback
- SVG chevron with rotate animation on drawer
- Session ID click-to-copy in drawer handle
- Launcher logs include timestamps
- Client IDs show full IP and tunnel indicator (`T:` prefix)

## v0.5.13

### Agent Picker
- Select custom agents from the session drawer (same pattern as model picker)
- Agents discovered from `~/.copilot/agents/` (personal) and `.github/agents/` (project/git root)
- Source label shown next to each agent (user/repository)
- Agent selection persists across page reloads, session switches, and server restarts
- Input placeholder shows active agent name: "Ask explain agent…"
- Scroll fade indicates more agents below the fold
- Auto-scrolls to the selected agent when picker opens
- Squad agent detected correctly from git root

### Theme Improvements
- Improved "Surprise Me" palette quality — tighter color bands, golden angle harmony
- Auto-generated theme names from palette colors (e.g., "Midnight Emerald", "Morning Coral")

## v0.5.12 (superseded by v0.5.13)

## v0.5.11

### Agent Picker
- Initial agent picker release (superseded by v0.5.12 with theme improvements)

## v0.5.10

### Tool Execution Fix (revised)
- v0.5.9 hardcoded `'approve-once'` which broke on some environments
- Portal now auto-detects the correct approval format from the SDK's own `approveAll` handler at startup
- Works with both old and new SDK versions automatically

### Per-Session Themes
- Each session can have its own theme (or fall back to the starred default)
- Starred default is the single global fallback — no more confusing active vs default
- Theme picker header matches Sessions/Guides layout (+ New, Use Default)
- Inline theme editor with pencil icon

### Working Directory
- **Staged session creation** — "+ New" opens a draft with folder browser to set CWD before creating
- **Folder browser** — navigate directories, breadcrumb path, drive letter support (Windows), create new folders
- **Change CWD on existing sessions** — click the path in the drawer to browse and apply
- **CWD preserved on session switch** — fixed critical bug where `resumeSession()` was resetting all session CWDs to Portal's install directory on every reconnect

### Tool Error Surfacing
- Failed tool boxes show red with the actual error message (not just "failed")
- Failed tools persist after turn end — no auto-collapse so errors can be reviewed
- Server console logs tool failures with ⚠ indicator

### Security
- Path traversal blocked in folder creation (`.` and `..` rejected)
- CWD paths validated (must exist, must be a directory)
- Symlinks filtered from folder browser listings

## v0.5.9 (withdrawn)

### Tool Execution Fix
- Copilot SDK v0.3.0 changed the tool approval response format from `'approved'` to `'approve-once'`
- Portal v0.5.8 and earlier used the old format, causing tool approvals to silently fail
- This release hardcoded the new format — worked on some machines but failed on others due to SDK/CLI version mismatches
- Superseded by v0.5.10 which auto-detects the correct format

## v0.5.8

### Theme System
- Custom theme editor with base, accent, and text color pickers
- WCAG contrast auto-fix: text colors shift for readability (4.5:1 ratio)
- "Surprise me" random palette generator (complementary, analogous, triadic, split-complementary)
- Per-session themes: each session can have its own theme
- Starred default: one theme is the global fallback for all sessions
- Server-side sync: themes persist across devices via `data/themes.json`
- Inline editing: pencil icon expands editor within the theme row
- Header layout matches Sessions/Guides panels (+ New, Use Default)

## v0.5.7

### Copy Improvements
- Copy formatted strips dark theme colors (clean paste into OneNote/Word/Teams)
- Clipboard API with both text/html and text/plain (paste vs paste-as-plain-text)
- Per-table copy button (top-right corner, stripped from message-level copy)
- Light theme forced on execCommand fallback (LAN IP access)

### ask_user Improvements
- Multi-line freeform input (textarea with auto-grow, Shift+Enter for new lines)
- Timeout increased from 5 minutes to 30 minutes

### Console
- Console title preserved after npm install/build during updates
- Title reset on server restart

### Documentation
- Agent integration design doc (agents vs guides, /fleet, Squad, CWD dependency)
- Comparison docs for cli-tunnel, Termote, Copilot Remote, Open WebUI, OpenClaw, /remote

## v0.5.6

### Session Usage Tracking
- Live token stats in session drawer: input/output tokens, reasoning, cached, requests
- Copy button to share usage stats
- Quota display: detects unlimited plans, shows reset date
- Shows "tbd" before first message (avoids misleading data from quota API)

### Update Reliability
- Re-poll updates 15s after reconnect (fixes race condition on server restart)

### Other
- Actionable notifications persist until dismissed (with ✕ button)
- Compact single-line usage stats display
- GitHub username links to Copilot settings page

## v0.5.5

### Security Headers
- Content-Security-Policy: script-src 'self', connect-src ws:/wss:, img-src data:, frame-ancestors 'none'
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- Referrer-Policy: no-referrer (prevents token leaking in referrer)
- HSTS: enabled over tunnel (HTTPS only)
- Cache-Control: no-store on API responses
- Moved service worker registration out of inline script for CSP compliance

### Notifications
- Actionable notifications (e.g. Reload) persist until dismissed
- Added dismiss button for persistent notifications

### Other
- README rewritten with Mermaid architecture diagram
- Fixed browser warnings (deprecated meta tag, no-op service worker)
- Added id/name to message textarea

## v0.5.3

### Guide Import from GitHub Gists
- Import from URL option in +New dropdown
- Paste a gist URL, preview discovered items, select and add to portal
- Supports single pairs, prompts-only, and multi-item collections
- File convention: name_guide.md / name_prompts.md
- Import metadata tracked in data/imports.json

### UI Polish
- Two-row command key layout (Access / Server)
- Picker: back-highlight, import highlight, stable delete row height
- Import panel: fixed height, scrollable preview
- Removed cancel link from thinking indicator
- Multi-line prompt examples in dev guide

### Portal Tour
- Updated for import, tunnels, PWA, Add to Home Screen
- New prompts for import and tunnel topics

## v0.5.2

### Tunnel Improvements
- Auto-restart tunnel after server restart (wasRunning flag)
- Immediate feedback on [t] press with double-press guard
- [q] shows both local and tunnel URLs when tunnel is running

### Update Flow
- Single Update button handles both portal and package updates
- Reload button on stale build notification (essential for PWA)
- Streamlined restart/reload flow: Update → Restart → Reload

### Console
- Two-row command key layout grouped by purpose (Access / Server)

## v0.5.1

### DevTunnel Integration
- [t] Tunnel toggle: start/stop a DevTunnel for remote access
- [T] Security reset: destroys tunnel, rotates token, disconnects all clients
- Config persistence in data/tunnel.json
- Token + QR code printed on tunnel start with security warnings

### PWA Support
- Manifest, service worker, and icons for Add to Home Screen
- Standalone mode (no browser chrome) on iOS and Android
- Subtle install hint banner on 2nd+ mobile visit
- Token persists in URL for iOS PWA compatibility

### Fixes
- WebSocket uses wss:// over HTTPS (fixes tunnel connections)
- Removed server-side token gate on HTML page (APIs still authenticated)
- JSON MIME type for manifest serving

## v0.5.0

### Guides & Prompts Redesign
- Catalog-based model: examples are read-only templates, user files live in `data/`
- Click a list item to open a detail view with Guide/Prompts tabs (no accidental apply)
- Apply and Edit buttons in the detail view
- Full-height editor with rename support (live filepath preview)
- \+ New flow: browse example catalog, preview content, choose which files to include, customize name
- Overwrite confirmation when a name conflicts with an existing item
- Unsaved changes guard: inline Discard/Keep Editing banner on navigation, tab switch, or backdrop click
- File path display with copy button; dimmed "(not created)" for missing files
- OS-consistent path separators

### Examples Overhaul
- Removed: my-dev-environment, system-explorer, common-prompts, choose-your-own-adventure
- Renamed: test-context → set-personality-quirks, 20-questions → play-20-questions
- New guides: storytime-bedtime-tales, storytime-pick-your-path, guide-builder
- New prompt sets: storytelling, trivia-and-research
- Added companion prompts for: portal-tour, copilot-portal-dev, set-personality-quirks, play-20-questions, storytime-bedtime-tales
- Portal tour fully rewritten for accuracy and first-impression quality
- Copilot Portal Dev guide updated with current architecture, all key files, directory structure

### Console Keys
- Rebound `[t]` to `[c]` for CLI Console (frees `[t]` for future tunnel support)

### Documentation
- Split `uplink-comparison.md` into three focused docs:
  - `uplink-comparison.md` — architecture comparison and patterns
  - `acp-protocol.md` — protocol reference, wire format, migration path
  - `dev-tunnels.md` — installation, usage, access control, integration plan

## v0.4.0

### Instructions
- Reusable reusable guides: drop `.md` files into `data/guides/`
- Top bar button with picker modal (tri-fold map icon)
- View guide content (eye icon), delete with confirmation (trash icon)
- Instructions applied via file-read prompt — Copilot reads the file natively
- Title from first line of `.md` used as session opener for better auto-naming
- Self-updating instructions: files can prompt user and write back answers
- Example instructions included:
  - Test Context, 20 Questions, Choose Your Own Adventure
  - My Preferences (self-updating), My Dev Environment (discover + ask)
  - Copilot Portal Dev (project briefing), System Explorer

### Per-Message Tool Summaries
- Tools collapse into summaries on the message that dispatched them
- Progressive collapse: each message's tools collapse when all complete
- Empty messages (tool-dispatch-only) render as summary-only rows
- Consistent rendering between live streaming and history replay

### Message Rendering
- Reasoning shown as collapsed "Thought" section inside message bubble
- Messages and tool events interleaved by timestamp (single timeline)
- ask_user questions show in chat with collapsed options summary
- ask_user excluded from tool summaries
- Freeform input preserved during probe re-broadcasts
- Message input hidden when ask_user prompt is active
- Skip button on ask_user prompts
- Error events clear all turn state (no stuck thinking indicator)

### CLI TUI Integration
- Console command `[t]` to open CLI TUI with session picker
- Switches from headless to --ui-server mode with confirmation
- Portal auto-reloads when CLI server mode changes
- Full bidirectional sync when in --ui-server mode

### Connection Reliability
- Auto-restart SDK client on idle connection drop
- Wait for CLI server port before reconnecting
- Create fresh CopilotClient on reconnect (preserves cliUrl config)
- Reduced auth failure retries (3 vs 5) to prevent self-blocking

### Security
- Rate limiting on failed auth: 15 attempts per 60s per IP
- Applied to both HTTP and WebSocket endpoints
- Failed attempts and blocks logged to console

### Code Quality
- 8 code review items fixed (CR-1 through CR-16)
- Path traversal hardened (resolve instead of normalize)
- Approval/input cleanup on disconnect
- Stale handle fix after reconnect
- Noisy delta events suppressed from console log
- Stale UI banner when server build changes

### Console & Startup
- `[u]` Update command, `[t]` CLI TUI launcher, `[l]` Launch browser
- Session labels truncated with ID prefix in CLI picker
- Improved start-portal.cmd with step numbers and descriptions
- Console title set to "Copilot Portal"

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

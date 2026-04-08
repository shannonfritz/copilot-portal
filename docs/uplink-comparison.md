# Uplink Comparison & ACP/DevTunnel Research

Research notes from analyzing [MattKotsenas/uplink](https://github.com/MattKotsenas/uplink) — a project with similar goals to Copilot Portal but built on ACP instead of the SDK.

## Architecture Comparison

### Copilot Portal (current)
```
React SPA (browser)
  ↕ WebSocket (custom portal events)
Portal Server (Node.js)
  ↕ Named Pipes / JSON-RPC (via @github/copilot-sdk)
Copilot CLI
```

### Uplink
```
Preact PWA (browser)
  ↕ WebSocket (raw JSON-RPC 2.0)
Bridge Server (Node.js, ~100 lines of relay logic)
  ↕ stdio / NDJSON (raw ACP messages)
Copilot CLI (copilot --acp --stdio)
```

### Key Difference
Portal uses the **SDK as an abstraction layer** — the SDK manages sessions, events, permissions, and the connection to the CLI. Our server interprets SDK events and translates them to portal-specific WebSocket events.

Uplink is a **"dumb pipe"** — the bridge just relays raw ACP messages between WebSocket and stdio. The PWA client does all the protocol work directly. Only 6 methods are intercepted server-side.

**Tradeoffs:**
- Portal: richer server-side features (rules, guides, prompts, multi-client), but tightly coupled to SDK version
- Uplink: simpler bridge, protocol-agnostic, but single-client only (v1), fewer features

---

## ACP (Agent Client Protocol)

### What Is It?
ACP is an **open standard** (by JetBrains/Zed) for communication between AI agents and clients. It uses **JSON-RPC 2.0 over NDJSON** (newline-delimited JSON). Copilot CLI supports it via `--acp`.

### Wire Format
Each message is a single JSON line, terminated by `\n`:
```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{...}}}\n
← {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}\n
```

### Key ACP Methods
| Direction | Method | Purpose |
|---|---|---|
| Client→Agent | `initialize` | Negotiate capabilities |
| Client→Agent | `session/new` | Create session |
| Client→Agent | `session/load` | Load/resume session |
| Client→Agent | `session/prompt` | Send user message |
| Client→Agent | `session/cancel` | Cancel in-flight turn |
| Agent→Client | `session/update` | Streaming updates (text chunks, tool calls, plan entries) |
| Agent→Client | `session/request_permission` | Ask user to approve tool action |

### ACP vs Our SDK Approach
| Aspect | ACP (--acp) | SDK (@github/copilot-sdk) |
|---|---|---|
| Transport | stdio or TCP | Named pipes (platform-specific) |
| Framing | NDJSON (one JSON per line) | Binary framing in named pipes |
| Connection | `copilot --acp --stdio` or `--acp --port N` | `new CopilotClient()` manages subprocess |
| Session mgmt | Raw JSON-RPC calls | SDK methods (createSession, resumeSession, etc.) |
| Events | `session/update` notifications | Event callbacks via `session.on()` |
| Permissions | `session/request_permission` RPC | `onPermissionRequest` callback |
| Protocol evolution | Capabilities negotiation in `initialize` | Tied to SDK package version |

### CLI Flags
| Flag | Purpose | Status |
|---|---|---|
| `--acp --stdio` | ACP over stdin/stdout (child process) | ✅ Current, documented |
| `--acp --port N` | ACP over TCP | ✅ Current, documented |
| `--server --port N` | Legacy JSON-RPC server | ⚠️ Missing from CLI help, still works |
| `--ui-server --port N` | TUI with server | ⚠️ Missing from CLI help, still works |

### Decision: Should Portal Switch to ACP?
**Not yet, but consider it.**
- SDK gives us high-level abstractions we rely on heavily (session management, model switching, compaction, orphan repair)
- ACP would require reimplementing those at the client level
- However, ACP is the **officially supported** protocol going forward
- If the SDK eventually wraps ACP internally, the switch may become transparent
- **Immediate action:** Switch launcher from `--server` to `--acp --port` for the headless server

---

## DevTunnels

### What Are They?
Microsoft Dev Tunnels create secure HTTPS/WSS tunnels from your local machine to a public URL. Like ngrok but integrated with Microsoft/GitHub identity.

### How Uplink Uses Them
1. Install: `winget install Microsoft.devtunnel` (or brew/curl)
2. Auth: `devtunnel user login` (one-time, uses GitHub/Microsoft account)
3. Auto-persistent tunnels derive a deterministic name from the project path: `uplink-{sha256(cwd).slice(0,8)}`
4. Stable URL per project — installed PWA always reconnects to the same URL

### Integration Pattern
```bash
# Create tunnel (once)
devtunnel create my-tunnel
devtunnel port create my-tunnel -p 3847

# Start tunnel (each session)
devtunnel host my-tunnel
# → https://abc123.devtunnels.ms
```

### What Portal Would Need
- **Zero code changes** for basic use — just document `devtunnel host -p 3847`
- **Nice to have:** a `--tunnel` flag in the launcher that auto-creates/starts a tunnel
- **Security:** tunnels can require GitHub auth or allow anonymous access
- **Stable URL:** deterministic naming from CWD (like uplink does) means the QR code/bookmarked URL survives restarts

### Key Implementation Details (from uplink)
- `devtunnel show name --json` — check if tunnel exists, get its port
- `devtunnel create name` + `devtunnel port create name -p PORT` — create tunnel
- `devtunnel host name -p PORT` — start tunnel, parse URL from stdout
- Always pass `-p` to ensure tunnel forwards to the correct local port
- SIGINT → wait 5s → SIGKILL for cleanup

---

## npm Publishing (from uplink's approach)

### What It Takes
```json
{
  "name": "@mattkotsenas/uplink",
  "bin": {"uplink": "./dist/bin/cli.js"},
  "files": ["dist/bin", "dist/client", "dist/src/server", "dist/src/shared"],
  "scripts": {
    "prepack": "npm run build"
  }
}
```

Key pieces:
- **`bin` field** — makes `npx @scope/package` work
- **`files` array** — controls what's published (only dist/, not src/)
- **`prepack` hook** — auto-builds before `npm pack` / `npm publish`
- **Scoped package** — `@scope/name` avoids name collisions

### For Copilot Portal
We'd need:
1. A CLI entry point (e.g. `bin/copilot-portal.js`) that runs the launcher
2. `bin` field in package.json: `"copilot-portal": "./dist/launcher.js"`
3. `files` array: `["dist/", "examples/", "patches/", "start-portal.cmd", "start-portal.sh"]`
4. `prepack` script to build before publish
5. Decide on scope: `@shannonfritz/copilot-portal` or just `copilot-portal`
6. Could keep zip releases for manual installs alongside npm

---

## Patterns Worth Adopting

### 1. Eager Initialization
Uplink sends `initialize` to the CLI immediately on bridge start, caching the response. When the browser connects seconds later, it gets an instant response. We could do the same — our SDK `start()` is already eager, but we could pre-warm sessions.

### 2. Server-Side Session Buffer
Elegant solution for reconnect resilience. If a client disconnects and reconnects to the same session, the buffer replays all missed messages instead of re-fetching from the CLI.

### 3. Message Router Pattern
Separate routing logic into a pure function that returns action objects. Makes routing testable without running a server.

### 4. Deterministic Tunnel Naming
`sha256(cwd).slice(0,8)` means the same project always gets the same tunnel URL. Installed PWAs survive restarts.

### 5. Ring Buffer Debugging
Fixed-capacity event logs at key points (WebSocket in/out, stdio in/out). `/debug` exports everything as JSON for post-hoc analysis without verbose logging in production.

---

## Summary

Uplink validates our approach (web portal for CLI) but takes a fundamentally different path (raw ACP vs SDK abstraction). The two projects are complementary:

- **Portal** is richer (multi-session, guides, prompts, rules, approval management)
- **Uplink** is simpler (dumb pipe, single-session, but remote-capable via devtunnels)

The key things to adopt: DevTunnel support for remote access, `--acp` flag migration for the launcher, and possibly the eager initialization pattern.

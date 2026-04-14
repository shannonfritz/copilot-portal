# Copilot Remote vs Copilot Portal

Comparison of [Copilot Remote](https://github.com/kubestellar/copilot-remote) and Copilot Portal — the two closest projects in the Copilot CLI remote access space.

## What Is Copilot Remote?

Copilot Remote is a **full-featured web dashboard** for managing Copilot CLI and Claude Code sessions. It provides tiled web terminals, an iMessage-style chat UI with ACP streaming, a task queue with auto-dispatch, and session management — all from your phone or LAN browser.

Think of it as: **a mission control for multiple AI coding agents.**

## What Is Copilot Portal?

Portal is a **focused web UI for single-session Copilot CLI interaction**. It provides a chat interface, approval management, guides & prompts, session switching, and DevTunnel remote access.

Think of it as: **a mobile remote control for your Copilot session.**

## This Is the Closest Comparison

Copilot Remote is the most similar project to Portal. Both are web UIs for Copilot CLI built with React and Node.js. But their scope and architecture differ significantly.

## Feature Comparison

| Feature | Copilot Remote | Portal |
|---|---|---|
| **AI agents** | Copilot CLI + Claude Code | Copilot CLI only |
| **Protocol** | ACP streaming (direct) | SDK JSON-RPC (via copilot-sdk) |
| **Chat UI** | iMessage-style bubbles with markdown | Chat with tool summaries, reasoning |
| **Terminal** | Full xterm.js terminals, tiled grid | No terminal — chat UI only |
| **Multi-agent** | Yes — tiled terminals, side-by-side | No — one session at a time |
| **Task queue** | Job queue with auto-dispatch to idle agents | None |
| **Recurring tasks** | Scheduled tasks on intervals | None |
| **Swarm mode** | Invite links for team task queuing | Single user only |
| **Session discovery** | Auto-discovers tmux + filesystem sessions | SDK session list |
| **Session management** | Start, resume, rename, tag, delete, purge | Create, switch, shield, delete |
| **Approval management** | N/A (handled in terminal) | Allow/Deny/Always with patterns |
| **Guides & Prompts** | None | Full guide system, import from gists |
| **Model switching** | At session start | In-session dropdown |
| **Token tracking** | None visible | Per-session input/output/reasoning |
| **Remote access** | LAN only (no tunnel built-in) | DevTunnel with `[t]` toggle |
| **Security reset** | N/A | `[T]` — rotate token, destroy tunnel |
| **PWA** | Yes | Yes |
| **Image support** | Drag images into terminals | None |
| **UI framework** | React + GitHub Primer | React + Tailwind |
| **Open source** | MIT | MIT |

## Architecture

### Copilot Remote
```
Browser (React PWA + xterm.js)
  ↕ WebSocket + REST
Node.js Server
  ↕ ACP streaming (copilot --acp) + node-pty + tmux
Copilot CLI / Claude Code (multiple instances)
```

### Portal
```
Browser (React PWA)
  ↕ WebSocket
Portal Server (Node.js)
  ↕ SDK JSON-RPC (@github/copilot-sdk)
Copilot CLI (single headless instance)
```

## Key Differences

### Scope
- **Copilot Remote** is a multi-agent dashboard. Run multiple Copilot and Claude Code sessions, tile them on screen, queue up tasks that auto-dispatch to idle agents.
- **Portal** is a single-session tool. One Copilot session at a time, with depth features (guides, approvals, tokens) rather than breadth.

### Protocol
- **Copilot Remote** uses ACP directly — spawns `copilot --acp` processes and manages the raw protocol. This gives terminal-level control.
- **Portal** uses the SDK — `@github/copilot-sdk` manages the connection. This provides higher-level abstractions but less raw control.

### Terminal vs Chat
- **Copilot Remote** offers BOTH — an iMessage-style chat AND full xterm.js terminals you can tile and interact with directly.
- **Portal** is chat-only — no terminal emulation. The UI is designed for structured interactions (messages, approvals, tool summaries), not raw terminal access.

### Multi-Agent
- **Copilot Remote** is designed for running multiple agents simultaneously. The task queue auto-dispatches work. Swarm mode lets teammates add tasks.
- **Portal** manages multiple sessions but you interact with one at a time. No task queue, no auto-dispatch.

### Remote Access
- **Portal** has DevTunnel built in — press `[t]` for HTTPS remote access from anywhere.
- **Copilot Remote** is LAN-only. You'd need to add your own tunnel (Tailscale, DevTunnel, etc.).

### Copilot-Specific Features
- **Portal** has features that Copilot Remote doesn't: Allow Always approval rules, guides & prompts system, gist import, per-session token tracking, security reset.
- **Copilot Remote** has features Portal doesn't: Claude Code support, tiled terminals, task queue, recurring tasks, swarm mode, image drag-and-drop.

## Copilot Remote Strengths

1. **Multi-agent** — tile multiple AI agents, dispatch tasks automatically.
2. **Task queue** — add work items that auto-dispatch to idle agents.
3. **Claude Code support** — not just Copilot.
4. **Terminal + chat** — both interfaces available.
5. **ACP streaming** — uses the modern, officially supported protocol.
6. **Swarm mode** — team collaboration via invite links.

## Portal Strengths

1. **Approval management** — Allow Always rules with pattern matching. Huge for productivity.
2. **Guides & Prompts** — reusable context system, import from gists, prompt tray.
3. **DevTunnel built-in** — one keypress for remote access from anywhere.
4. **Token tracking** — per-session usage stats with copy button.
5. **Security reset** — `[T]` to nuke everything and start fresh.
6. **Simpler setup** — unzip and run vs cloning a repo and configuring.

## When to Use Which

| Scenario | Use |
|---|---|
| Running multiple AI agents simultaneously | **Copilot Remote** |
| Dispatching tasks to idle agents automatically | **Copilot Remote** |
| Using both Copilot and Claude Code | **Copilot Remote** |
| Want terminal + chat side by side | **Copilot Remote** |
| Team collaboration on tasks | **Copilot Remote** |
| Need approval rules (Allow Always) | **Portal** |
| Domain-specific guided workflows | **Portal** |
| Remote access from anywhere (tunnel) | **Portal** |
| Quick mobile check-in on a coding session | **Portal** |
| Tracking token usage per session | **Portal** |
| Simple setup, single Copilot user | **Portal** |

## Could They Work Together?

Interesting question. They use different connection methods (ACP vs SDK), so they'd connect to separate CLI instances. But conceptually, a developer could use Copilot Remote for multi-agent orchestration and Portal for deep single-session work with guides and approval rules.

## Summary

Copilot Remote is **wider** — multiple agents, task queues, tiled terminals, Claude Code support. Portal is **deeper** — approval rules, guides, token tracking, built-in tunnel, security controls. Copilot Remote is for power users managing multiple AI agents. Portal is for developers who want a polished mobile experience for a single Copilot session with domain-specific guidance.

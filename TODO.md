# Copilot Portal — Backlog

Items ready to pick up in future sessions. See `ARCHITECTURE.md` for system context.

---

## Active Backlog

### 🔥 Quick wins

#### `feat-thinking-indicator` — Activity indicator while thinking
Show a visible animated indicator between sending a prompt and receiving the first token. Currently there's a "thinking…" text state but it could be more prominent.
- Distinct from streaming state: *thinking* = waiting for first token, *streaming* = content arriving
- Animated dots or a subtle pulse on the existing thinking bubble
- Should also show during tool execution gaps (between tool calls)

#### `feat-thinking-bubble` — Collapsible reasoning bubble
`assistant.reasoning` events contain the model's extended thinking text. Currently shown via `ThoughtBubble` component on historical messages but the live reasoning stream (`reasoning_delta` events) builds up in `reasoningText` state.
- Show as a collapsed "Thought…" pill above the response while streaming
- Expand on tap to read full reasoning
- `ThoughtBubble` component already exists — wire the live stream to it

#### `feat-prompt-history` — Arrow-up prompt history
Track sent prompts in a local array (`promptHistory`), arrow-up/down cycles through them like a terminal.
- Only activates when input is empty or already navigating history
- Arrow-down past the end restores the in-progress draft
- Store in `useRef` (not state) to avoid re-renders; cap at ~50 entries

---

### 🟡 Medium effort

#### `feat-session-rename` — Custom session names
Allow setting a custom display name for a session (instead of the auto-generated summary).
- Store in server-side map, persisted to `data/session-names.json`
- Show custom name in session picker; fall back to auto-summary if not set
- Edit via a tap/long-press on the session name in the picker, or a rename button
- Also display in the portal header

#### `approval-pattern-revisit` — Smarter always-allow patterns
Current pattern computation (`RulesStore.computePattern()`) is simple:
- `shell` → `{base command} *` (e.g. `ping *`)
- `read`/`write` → exact path
- `mcp` → `{server}/{tool}`
- `url` → hostname

Ideas for improvement:
- **User-editable pattern** before saving (show an edit field on "Allow Always" click)
- **Directory-level matching** for read/write (e.g. `src/**` instead of exact file)
- **Glob support** for shell (e.g. `npm *` matches any npm command)
- **Deny rules** — not just allow

#### `history-pagination` — Load more on scroll-to-top
Long sessions (100+ messages) load everything on connect. Fix:
1. Server: send only last 50 messages in `getHistory()` (easy, ~5 min)
2. Client: show "X earlier messages not loaded" notice at top of list
3. On tap: `GET /api/sessions/{id}/history?before={index}&limit=50`
4. Prepend to message list while preserving scroll position (save/restore `scrollTop` around DOM update — the tricky part)

Step 1 alone is a worthwhile quick win even without step 2–4.

---

### 🟠 Bigger / title bar work

#### Title bar shuffle
Currently shows session ID truncated + build time. Ideas:
- Show active session **name** (custom or auto-summary, truncated)
- Show **message count** for current session
- Connection status indicator already present (green/amber/red dot)
- Model name shown in the context bar (already exists as a separate component)
- Possibly consolidate into a cleaner single header bar

#### HTTPS support
`navigator.clipboard` and PWA install require HTTPS. Options:
- **mkcert** local CA: `mkcert -install && mkcert 192.168.77.61 localhost` → load cert in Node `https.createServer`
- iOS requires manually trusting the root CA in Settings → General → About → Certificate Trust Settings
- Would also enable **Add to Home Screen** as a proper PWA (needs `manifest.json` + service worker)
- Tracked as `v4-https` in old roadmap

---

## Blocked / Deferred

#### `deploy-automation` — Build + reload automation
Currently: `node esbuild.cjs && cd webui && npx vite build` then restart server manually.
- Could add a `--watch` mode to esbuild + vite dev server proxy for development
- Or a simple `npm run dev` that starts both watchers
- Deferred until the dev workflow becomes painful enough to warrant it

#### `s4-polish` — Packaging for distribution
For sharing the portal beyond a single dev machine:
- Token auth on all HTTP endpoints (currently only WS is gated)
- `npm start` as a proper detached/background process
- `package.json` `bin` field for `npx copilot-portal` style launch
- Deferred until the feature set stabilises

---

## Recently Completed (this session)

- ✅ Approval queuing — one at a time, auto-advance on resolve
- ✅ Always-allow rules — per-session, persisted, with amber "Allow Always: `pattern`" button
- ✅ Batch auto-resolve — "Allow Always" sweeps and resolves matching queued approvals
- ✅ Rules drawer — view, delete individual, clear all; header button shows count
- ✅ Portal-turn fix — `send()` sets `isTurnActive` to block CLI reconnect during portal turns
- ✅ Tool events cleared on `idle` and on CLI user-message sync
- ✅ Copy button on all messages (clipboard API + `execCommand` fallback for HTTP)
- ✅ `ARCHITECTURE.md` — full system documentation

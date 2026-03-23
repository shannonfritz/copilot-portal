# Copilot Portal — Roadmap

## Planned Features

### 1. Shared CLI Server Mode (high impact)
Connect to the CLI's built-in JSON-RPC server (`--ui-server`) instead of
spawning a private subprocess. Gives true bidirectional sync between CLI
and portal — messages sent from either side are immediately visible to both.

- **Status:** Validated on CLI v1.0.9 (present since v0.0.407)
- **Effort:** ~30 lines changed, ~100 lines of sync poller removed
- **Detail:** See [cli-server-mode.md](cli-server-mode.md)

### 2. Session Context (custom instructions per session)
Reusable context bundles that can be applied when creating a new session.
Avoids re-coaching the model on domain-specific knowledge each time.

**Use case examples:**
- "CRM & ADO" — instructions for accessing CRM records, ADO work items, auth patterns
- "Copilot Portal Dev" — packaging steps, architecture notes, conventions
- Start a new session → set context → model is immediately productive

**Implementation approach:**
- Stored as markdown files in `data/contexts/`
- UI: when creating a session, optionally pick a context from a list
- Passed to SDK via `systemMessage: { mode: 'append', content: ... }` on `createSession()`
- UI to create/edit/delete contexts (simple markdown editor or file upload)
- Complements CLI's `.copilot-instructions.md` per-repo system
  — repo instructions handle project context, session contexts handle task/domain context

**Open questions:**
- Can contexts be stacked? (e.g. "CRM" + "ADO" together)
- Should contexts be visible/editable in the session drawer after creation?
- Size limits? Large contexts eat into the model's context window

### 3. Admin Controls UI
Expose Update, Restart, and other management actions in the portal UI.
Currently only accessible via update banner or browser console.

- Settings/admin panel or gear icon
- Restart button, update controls, version info
- Possibly token management (see multi-token below)

### 4. Multi-Token
Primary token + scoped tokens with session-level access control.

- Design doc: [multi-token-plan.md](multi-token-plan.md)
- Primary token has full access
- Scoped tokens can be limited to specific sessions
- UI for token management in the admin panel

### 5. Working Directory Selection
CWD handling for new sessions — currently defaults to where server started.

- Sandbox approach vs user-selected directory
- Trust prompt handling when changing CWD mid-session
- Consider default workspace directory separate from portal source

### 6. Portal Self-Update
Check GitHub releases for new portal versions (deferred until published).

- Would complement the existing SDK/CLI update system
- Download + replace + restart flow

## Rendering Improvements (lower priority)

1. **`intermediate` flag inconsistency** — live turns auto-detect via buffering;
   history uses backend flag; sync never sets it
2. **Sync messages lack metadata** — no toolSummary, no reasoning, no bytes
3. **Tool events are ephemeral** — lost after turn completes; only `toolSummary`
   on final message preserves them
4. **Extract ws.onmessage into reducer/dispatcher** — testability and maintainability
5. **`elicitation.requested/completed`** — SDK form prompts (no portal response API yet)

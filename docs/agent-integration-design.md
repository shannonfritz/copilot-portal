# Agent Integration Design

Support for Copilot CLI custom agents in the Portal UI.

## Background

Copilot CLI supports custom agents — `.agent.md` files in `.github/agents/` (repo), org-level, or `~/.copilot/agents/` (personal). Each agent is a specialized persona with defined tools, instructions, and behavior. Examples: Squad (multi-agent team), code reviewers, K8s assistants, explain-only agents.

The SDK provides full agent management:
- `session.agents.list()` — available custom agents
- `session.agents.getCurrent()` — active agent (or null = default)
- `session.agents.select({ name })` — switch agent
- `session.agents.deselect()` — back to default
- `session.agents.reload()` — refresh list

No slash commands or launcher flags needed.

## Design

### Agent Picker in Session Drawer

Add an agent selector below the model selector in the session drawer, following the same dropdown pattern.

**Components:**
- Dropdown showing: "Default" + all available custom agents
- Current agent highlighted
- Agent description shown when selected (from YAML frontmatter)
- "Default" option to deselect back to standard Copilot

**Behavior:**
- On drawer open: fetch agent list (`session.agents.list()`) and current (`session.agents.getCurrent()`)
- On selection: call `session.agents.select({ name })` or `session.agents.deselect()`
- Agent persists for the session (same as model selection)

### Drawer Handle Indicator

Show the active agent name in the drawer handle (the collapsible bar below the header) so it's always visible without opening the drawer.

**Layout:**
```
[session name or "untitled session"]
[agent-name] · session-id-prefix
```

Or if no custom agent is active, just show the session info as today.

**Considerations:**
- Keep it subtle — not every session uses a custom agent
- Only show when a non-default agent is active
- Truncate long agent names

### API Changes

#### Server

New endpoints (pass-through to SDK):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/agents` | GET | List available agents for the active session |
| `/api/agents/current` | GET | Get currently active agent |
| `/api/agents/select` | POST | Select an agent `{ name }` |
| `/api/agents/deselect` | POST | Deselect back to default |

#### WebSocket Events

New event type to broadcast agent changes:

```json
{ "type": "agent_changed", "agent": { "name": "explain", "description": "..." } | null }
```

### Session Pool Changes

Add methods to `SessionHandle` / `SessionPool`:

```typescript
async listAgents(): Promise<Array<{ name: string; description: string }>>
async getCurrentAgent(): Promise<{ name: string; description: string } | null>
async selectAgent(name: string): Promise<void>
async deselectAgent(): Promise<void>
```

### UI Changes

#### Session Drawer
- Agent dropdown below model selector
- Same styling as model picker (border, bg, label)
- Shows description text below dropdown when agent selected
- Label: "Agent" with current name

#### Drawer Handle
- When a custom agent is active: show agent name badge
- Styled as a small pill/label, e.g. `[explain]` before the session ID
- Not shown when using default agent

#### Session Picker (list)
- Optionally show agent name next to session name in the list
- Helps identify which sessions have specialized agents

## Example UX Flow

1. User opens session drawer
2. Sees "Agent: Default" dropdown
3. Clicks dropdown → sees: Default, explain, squad, k8s-assistant
4. Selects "explain"
5. Dropdown shows "Agent: explain"
6. Description appears: "Explains code, concepts, and errors in plain English with examples"
7. Drawer handle now shows: `[explain] · 90aa1943`
8. User closes drawer, sends a message — the explain agent responds
9. User can switch back to Default anytime

## Open Questions

1. **Should agent changes broadcast to other clients?** If multiple browser tabs are open, should they all see the agent change? Probably yes, same as model changes.

2. **Agent + Guide interaction:** If a guide is applied AND an agent is selected, which takes precedence? The agent's instructions are in the system prompt; the guide is applied as a file-read. They should layer — agent defines capabilities, guide adds domain context.

3. **Session creation with agent:** When creating a new session, should we offer agent selection? Or always start with Default and let users switch?

4. **Agent availability per session:** Agents are discovered from the filesystem at session creation time. If agents change on disk (new file added), should we auto-detect? The `reload()` method handles this.

5. **Drawer handle space:** The handle is already compact. Adding agent name + session ID might be tight on mobile. May need to show agent OR session ID, not both, based on screen width.

## Working Directory Dependency

Agents discover their `.agent.md` files relative to the session's working directory. Portal currently sets all new sessions to `data/workspaces/default` (Portal's own directory), which means:

- Repo-scoped agents (`.github/agents/`) won't be found
- Squad's `.squad/` state won't be found
- `/fleet` operates on the wrong files

### Current State

- **Shared mode** (connecting to existing CLI server) — CWD comes from where the CLI was started. Usually correct.
- **New sessions via Portal UI** — get Portal's workspace path. Wrong for project work.
- **Resumed sessions** — preserve their original CWD. Correct.

### SDK Capabilities

- `SessionConfig.workingDirectory` — set CWD at session creation ✅
- No SDK method to change CWD after creation (the CLI's `/cwd` slash command is TUI-only, not an RPC call)

### Required for Agent Support

Before the agent picker is fully useful, Portal needs a way to set the working directory when creating a session. Options:

1. **Text input** — type or paste a path when creating a new session
2. **Recent directories** — remember previously used CWDs
3. **Auto-detect** — if the CLI server was started from a project directory, use that as default

This is a prerequisite for agents but also improves Portal generally — it's been on the roadmap as "Working Directory Selection."

## Implementation Order

1. Server endpoints (pass-through to SDK)
2. Session drawer dropdown (agent picker)
3. Drawer handle indicator
4. WebSocket broadcast on agent change
5. Session picker annotation (optional)

## Multi-Agent: /fleet and Squad

Copilot CLI has two approaches to multi-agent work. Portal doesn't need to specifically support either — both flow through standard session events.

### /fleet (built-in)

`/fleet` is Copilot CLI's native parallel execution command (April 2026). The orchestrator splits a task into independent subtasks, runs subagents in parallel, coordinates dependencies, and synthesizes results.

- **Ephemeral** — no persistent state between sessions
- **Built-in** — no install, just `/fleet <task>` in any session
- **Monitor** — `/tasks` shows subagent progress

### Squad (third-party agent)

[Squad](https://github.com/bradygaster/squad) is a custom agent (`--agent squad`) that provides persistent, named specialist teams. Unlike `/fleet`, Squad agents have identities, accumulated knowledge, and decision logs committed to git.

- **Persistent** — team state in `.squad/`, knowledge compounds across sessions
- **Installed** — `npm install -g @bradygaster/squad-cli && squad init`
- **Activated** — `copilot --agent squad` or via Portal's agent picker

### Portal Compatibility

Portal already handles subagent events from the SDK:
- `subagent.started` — shows subagent name in tool display
- `subagent.completed` — marks completion
- `subagent.failed` — shows failure

Both `/fleet` and Squad generate these events. No special Portal support is needed — once the agent picker is built, users can select Squad (or any custom agent) and the multi-agent output renders naturally in the chat UI.

**Squad specifically:** A user would install Squad CLI, run `squad init` in their repo, then in Portal select the "squad" agent from the picker. The Squad coordinator's output — team proposals, parallel agent work, decision logging — all flows through as normal Copilot responses and tool calls.

## Relationship to Guides

### The Landscape

GitHub's `agents.md` is the native, first-class way to customize Copilot's behavior. It's more powerful than Guides in some ways (tool restrictions, persona enforcement, auto-discovery, IDE integration) but Guides offer capabilities agents don't have.

### Comparison

| | Agents (`.agent.md`) | Guides (Portal) |
|---|---|---|
| **Where they live** | `.github/agents/`, `~/.copilot/agents/` | `data/guides/`, importable from gists |
| **Integration level** | System prompt (deep, enforced) | File-read context (advisory) |
| **Tool control** | ✅ Specify available tools per agent | ❌ No tool restrictions |
| **Boundaries** | ✅ Enforced (never/ask-first/always) | Advisory (guidance, not enforced) |
| **Persona** | ✅ YAML frontmatter, auto-discovered | Informal, in markdown body |
| **IDE support** | VS Code + CLI + any Copilot client | Portal only |
| **Repo-scoped** | ✅ Committed in `.github/agents/`, shared with team | Local to Portal install (`data/`) |
| **Multiple specialists** | One active per session, switchable | Additive — multiple can be applied (stacked) |
| **Companion prompts** | ❌ None | ✅ Prompt tray with stacking |
| **Self-updating** | ❌ Static files | ✅ `[DISCOVER]`/`[ASK]` patterns |
| **In-UI editing** | ❌ Edit on disk | ✅ Full editor in Portal |
| **Import/sharing** | Commit the file to repo | ✅ Import from GitHub Gists |
| **Requires git repo** | ✅ Yes (for repo-scoped) | ❌ Works in any directory |

### How They Complement Each Other

**Agents define *what Copilot can do*** — tools, persona, boundaries. An agent says "I'm a test engineer, I can write to `tests/` but never touch `src/`, I use Jest."

**Guides add *domain knowledge and workflows*** — CRM field mappings, API patterns, business rules, self-updating context. A guide says "here's how our customer database works, here are the product IDs, here's how to look up a contact."

**Prompts provide *quick-start queries*** — canned questions and tasks that are useful regardless of which agent is active. Prompts are unique to Portal and have no agents.md equivalent.

### Stacking Behavior

Guides can be stacked — applying multiple guides merges their context. This is powerful but has ordering implications: later guides can override earlier ones. This is different from agents, where only one is active at a time.

A typical workflow might be:
1. **Select agent**: `@api-agent` (defines tools, persona, boundaries)
2. **Apply guide**: `crm-guide.md` (adds domain context about the CRM system)
3. **Load prompts**: `crm-prompts.md` (quick-start queries for common CRM tasks)

Each layer adds context without replacing the others.

### Portal's Role Going Forward

Portal should **embrace agents as the primary behavior customization** and position Guides as complementary:

- **Agent picker** in the session drawer — first-class access to the agents ecosystem
- **Guides** for domain context, self-updating workflows, and anything that needs Portal's editor/import features
- **Prompts** remain Portal-exclusive — quick-start queries for any agent or guide

The goal is not to recreate agents.md in Portal, but to make Portal the best place to *use* agents while adding value they don't provide (prompts, editing, import, token tracking, mobile access).

### Migration Consideration

Some existing Guides could be converted to agents.md for better native integration. A guide that primarily defines persona and boundaries ("always use TypeScript", "never modify production configs") would be better as an agent. A guide that provides domain data ("here are the CRM fields and their meanings") stays as a guide.

Portal could potentially offer a "convert to agent" feature that generates an `.agent.md` file from a guide — but this is future work.

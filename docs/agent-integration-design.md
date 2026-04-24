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

## Implementation Order

1. Server endpoints (pass-through to SDK)
2. Session drawer dropdown (agent picker)
3. Drawer handle indicator
4. WebSocket broadcast on agent change
5. Session picker annotation (optional)

## Relationship to Guides

Agents and guides serve related but distinct purposes:

| | Agents | Guides |
|---|---|---|
| **Where they live** | `.github/agents/`, `~/.copilot/agents/` | `data/guides/` |
| **Who manages them** | User/repo outside Portal | Portal UI (create, edit, import) |
| **What they control** | Tools, persona, system prompt | Domain context, behavioral rules |
| **Scope** | Session-level (one active at a time) | Additive (applied as file-read context) |
| **Switching** | Dropdown, instant | Apply button, loads content |
| **Portal editable** | No (read-only, managed outside) | Yes (full editor) |

They complement each other: an agent defines *what Copilot can do* (tools, persona); a guide adds *domain knowledge* (CRM fields, coding conventions, workflow steps).

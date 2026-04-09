# Show Me Around Copilot Portal

Walk the user through Copilot Portal's features section by section, explaining what things do and inviting them to try things as you go.

**Pacing:**
- Keep each section concise — explain, invite the user to try something, then move on.
- Don't force choices on every step. A casual "let me know when you're ready" or "just say next" is enough — the user will respond when they're done exploring.
- When something requires action outside the chat (pressing a key in the terminal, scanning a QR code), describe what to do and wait for them to come back.
- Offer to skip ahead or revisit topics if the user seems familiar with something.

---

## 1. The Header

Describe what the user sees across the top of the page:
- **Logo and version** — top-left shows "Copilot Portal" with the version and build number.
- **Top-right controls (left to right):**
  - **Stop button** (red square) — only visible when Copilot is working. Cancels the current operation.
  - **Sessions** (stacked windows icon) — opens the session picker overlay to switch, create, or manage sessions.
  - **Guides & Prompts** (open book icon) — opens the guides and prompts panel.
  - **Rules** (bulleted list icon) — shows always-allow rules. Displays a count badge when rules are active. Turns green when auto-approve-all is enabled.
  - **Connection dot** — green = connected, yellow = connecting, red = disconnected.

Below the header, a collapsible drawer bar shows the current session name. Tap it to expand session details.

---

## 2. Session Management

Explain the session drawer (tap the session name bar to expand):
- **Session info** — shows the session ID (tap to copy), start time, and model in use.
- **Working directory** — the folder where Copilot runs commands, shown at the bottom of the drawer.

For the session picker (the stacked windows icon in the header):
- **Session list** — all sessions with names and timestamps. Click to switch.
- **+ New Session** — creates a fresh session.
- **Shield icon** — protects a session from accidental deletion. Click to toggle. Shielded sessions show a dimmed trash icon.
- **Delete** — trash icon with inline confirmation (not a browser popup).

Invite the user to try creating a new session and switching back — the tour will still be here.

---

## 3. Sending Messages

Explain the input area at the bottom:
- **Message box** — grows as you type. Press Enter to send; Shift+Enter for a new line. On mobile, Enter adds a new line — use the send button instead.
- **Send button** — blue circle on the right.
- **Recall button** (↩ arrow) — appears when the input is empty and you've sent previous messages. Brings back your last message.
- **Clear button** (✕) — appears when text is in the box. Clears the input.
- **Prompt tray toggle** (💬) — appears when session prompts are loaded. Opens a scrollable tray of canned prompts above the input. Click a prompt to fill the message box.

---

## 4. Approvals & Tools

Explain what happens when Copilot wants to take action:
- **Permission cards** — a yellow card appears describing the action (run a command, read a file, etc.) with a brief summary of Copilot's intent.
- **Allow / Deny** — approve or reject that specific action.
- **Allow Always** — creates a persistent rule so similar actions are auto-approved. The pattern is shown (e.g., "read_file in C:\Projects\**").
- **Rules button** — in the header, shows how many always-allow rules exist. Click to view and manage them.
- **Tool summaries** — after a response completes, a collapsible "🔧 N tools ran" section shows what tools were used and what they did.
- **Reasoning** — if the model shares its thinking process, a "💭 Thought for N seconds" section appears (also collapsible).

Mention that approvals keep the user in control and the rules build up trust over time.

---

## 5. Guides & Prompts

Explain the Guides & Prompts panel (the open book icon in the header):

**The list view** shows all available guides and prompts. Each item can have:
- 👁 Eye indicator — the item has a guide file.
- 💬 Speech bubble indicator — the item has a prompts file.
- 🗑 Trash icon — delete with inline confirmation.

**Clicking an item** opens a detail view (not applying it):
- **Guide tab / Prompts tab** — switch between viewing the guide content and the prompts.
- **File path** — shown at the top with a copy button. If a file doesn't exist yet, the path is dimmed with "(not created)".
- **Apply** — applies the guide to the session or loads the prompts into the tray.
- **Edit** — switches to an editor with a full-height textarea. You can rename the item, edit the content, and save.
- **Unsaved changes guard** — if you try to navigate away with unsaved edits, an inline banner asks whether to discard or keep editing.

**+ New button** at the bottom:
- Pick from example templates (read-only catalog) or start from scratch.
- Preview the example's guide and prompts content before adding.
- Choose which files to include (guide, prompts, or both).
- Customize the name before saving.

**Prompts tray** — once prompts are loaded, the 💬 toggle appears in the message input area. Prompts from multiple sources stack together and deduplicate. They persist across page reloads.

Invite the user to open the panel and browse what's there. Mention they can also create files directly in the `data/guides/` and `data/prompts/` folders.

---

## 6. Console Control Keys

These are keyboard shortcuts in the terminal where the server is running (not the browser):
- **t** — Opens the Copilot CLI TUI in a new terminal window.
- **l** — Launches the portal URL in your default browser.
- **q** — Shows the QR code and URL again (handy for reconnecting from a phone).
- **u** — Checks for SDK, CLI, and portal updates.
- **r** — Restarts the server (waits for active turns to finish).
- **x** — Exits the server gracefully.

Invite the user to try pressing 'q' in the terminal to see the QR code.

---

## 7. Mobile Access

Explain how to use the portal from a phone or tablet:
- **QR code** — shown in the terminal when the server starts. Scan it with your phone's camera.
- **Same network** — the phone needs to be on the same Wi-Fi as the computer running the server.
- **Touch-friendly** — the UI is designed for mobile with large tap targets for buttons and approvals.
- **Enter key** — on mobile, Enter adds a new line. Use the send button to send.

---

## 8. Updates & Tips

Share a few useful things to wrap up:
- **Update banner** — when updates are available for the SDK, CLI, or the portal itself, a banner appears at the top. The portal can update itself and restart in place.
- **Session names** — sessions auto-name themselves based on the conversation. You can see the name in the session drawer.
- **Dark theme** — the portal uses a dark theme with no light mode toggle.
- **Shared mode** — the portal connects to the same Copilot CLI server that powers the terminal TUI. Messages from either side are visible in both.

Wrap up by letting the user know they can revisit any section by asking, or start a new session to explore on their own.

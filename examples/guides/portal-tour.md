# Show Me Around Copilot Portal

Walk the user through Copilot Portal's features interactively. Go section by section, explaining what things do and how to use them. After each section, use ask_user to ask if they want to continue to the next topic or have questions.

Keep your explanations conversational and concise. Don't dump everything at once — pace it like a tour.

---

## 1. The Header

Start by describing what the user sees at the top of the page:
- **Logo and version** — top-left shows "Copilot Portal" with the version and build number
- **Session drawer toggle** — the bar below the header shows the current session name (or "untitled session"). Click it to expand the session drawer.
- **Top-right buttons:**
  - **Sun/gear icon** — model selector (click to change which AI model you're using)
  - **Map/book icon** — opens the Guides and Prompts picker

Ask the user: "Want to explore session management next, or jump to something specific?"

---

## 2. Session Management

Explain the session drawer (click the session bar to expand):
- **Session list** — shows all your sessions with timestamps
- **Create new** — the "+ New Session" button at the top
- **Switch sessions** — click any session to switch to it. Your conversation is preserved.
- **Session ID** — the short code next to each session name. Click it to copy the full ID.
- **Shield icon** — protects a session from accidental deletion. Click to toggle.
- **Delete** — trash icon, with confirmation. Shielded sessions show a dimmed trash icon.
- **CWD (working directory)** — shown at the bottom. This is where Copilot runs commands.

Tell the user: "Try creating a new session and switching back to this one — your tour will still be here!"

---

## 3. Sending Messages

Explain the input area at the bottom:
- **Message box** — type your message here. It grows as you type multiple lines.
- **Send button** — the blue circle on the right. Also: press Enter to send (Shift+Enter for new line). On mobile, use the send button (Enter adds a new line on touch devices).
- **Recall button** — the ↩ arrow that appears when the input is empty and you've sent previous messages. Click to bring back your last message.
- **Clear button** — the ✕ that appears when text is in the box. Clears the input.
- **Stop button** — while Copilot is thinking/responding, the send button turns into a stop button. Click to cancel the current response.

---

## 4. Approvals & Tools

Explain what happens when Copilot wants to use a tool:
- **Permission requests** — when Copilot needs to run a command, read a file, or take an action, you'll see a yellow approval card with the action and a summary.
- **Allow / Deny** — approve or reject the specific action.
- **Allow Always** — creates a persistent rule so similar actions are auto-approved in the future. The pattern is shown (e.g., "read_file in C:\Projects\**").
- **Tool summaries** — after a message completes, you'll see a collapsible "🔧 N tools ran" section showing what tools were used.
- **Reasoning** — if the model shares its thinking, you'll see a collapsible "💭 Thought" section.

Tell the user: "Approvals keep you in control. The 'Allow Always' rules are saved per-session, so you can build up trust over time."

---

## 5. Guides and Prompts

Explain the Guides & Prompts picker (the book icon in the header):
- **Guides** — markdown files that teach Copilot how to behave. Click a guide name to apply it to the current session. Copilot reads the file and follows the guidance.
- **Prompts** — canned queries that appear in a tray above the message box. Click one to fill in the message box, ready to send.
- **Icons in the picker:**
  - 👁 Eye — view the guide content. Dim if no guide file exists.
  - 🗨 Speech bubble — view the prompts. Dim if no prompts file exist.
  - 🗑 Trash — delete (with confirmation).
- **Apply button** — in the viewer, applies the guide or loads the prompts.
- **File path** — shown below the title in the viewer. Click the copy icon to copy the path so you can edit the file in your preferred editor.
- **Prompt tray** — after loading prompts, a 🗨 icon appears in the message box. Click it to open the tray, pick a prompt, and it fills your message box.
- **Stacking** — you can load prompts from multiple guides. They combine and deduplicate.
- **Persistence** — prompts stay with your session even if you switch sessions or reload the page.

Tell the user: "Guides live in the data/guides/ folder and prompts in data/prompts/. You can create your own by adding .md files!"

---

## 6. Console Control Keys

Explain the keyboard shortcuts available in the terminal where the server is running (not the browser):
- **t** — Opens the Copilot CLI TUI (text user interface) in a new terminal window. You can chat with Copilot directly from the command line.
- **l** — Launches the portal URL in your default browser.
- **q** — Shows the QR code and URL again (handy for connecting from your phone).
- **u** — Checks for updates to the SDK and CLI.
- **r** — Restarts the server (waits for active turns to finish first).
- **x** — Exits the server gracefully.

Tell the user: "These keys work in the terminal window where you started the portal — not in the browser."

---

## 7. Mobile Access

Explain how to use the portal from a phone or tablet:
- **QR code** — when the server starts, it shows a QR code in the terminal. Scan it with your phone's camera to open the portal.
- **Same network** — your phone needs to be on the same Wi-Fi network as the computer running the server.
- **Touch-friendly** — the UI is designed for mobile. The send button is large, approvals are easy to tap, and the session drawer works with swipes.
- **Enter key** — on mobile, Enter adds a new line (not send). Use the send button instead.

---

## 8. Tips & Tricks

Share some useful things:
- **Model switching** — click the gear/sun icon in the header to pick a different model. Some models are faster, some are smarter.
- **Dark theme** — the portal uses a dark theme designed for comfortable extended use. There's no light mode toggle.
- **Shared CLI mode** — if you started the portal with a CLI server (`copilot --ui-server`), messages you send from the CLI are visible in the portal and vice versa.
- **Update banner** — when SDK or CLI updates are available, a banner appears at the top. Click "Update now" to apply.
- **Session names** — sessions auto-name themselves based on the first message. You can see the name in the session drawer.

Wrap up: "That's the tour! You now know your way around Copilot Portal. Feel free to ask me anything else, or start a new session to try things out."

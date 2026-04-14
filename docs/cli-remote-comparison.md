# CLI Remote Access vs Copilot Portal

Comparison of GitHub's new `/remote` feature with Copilot Portal's approach to remote access.

## What Is `/remote`?

GitHub announced a first-party remote access feature for Copilot CLI (public preview, April 2026). It lets you access a running CLI session from GitHub.com or GitHub Mobile.

**How it works:**
- Start a session with `copilot --remote` or type `/remote` during a session
- The CLI connects to GitHub.com and registers the session
- You access it via `https://github.com/OWNER/REPO/tasks/TASK_ID`
- Session events stream to GitHub's servers, remote commands are polled back
- Both local terminal and remote interface are active simultaneously

## Feature Comparison

| Capability | Portal | `/remote` |
|---|---|---|
| **Remote access** | DevTunnel (self-hosted) | GitHub.com relay (cloud) |
| **Mobile access** | Any browser + PWA | GitHub Mobile (beta, TestFlight) |
| **Send messages** | ✅ | ✅ |
| **Approve/deny permissions** | ✅ | ✅ |
| **Answer questions** | ✅ | ✅ |
| **View streaming output** | ✅ Real-time WebSocket | ✅ Real-time |
| **Cancel operations** | ✅ | ✅ |
| **Multiple sessions** | ✅ Session picker, create/switch/delete | ❌ One session per remote link |
| **Session management** | ✅ Shield, delete, name | ❌ Limited |
| **Guides & Prompts** | ✅ Full guide system, import from gists | ❌ Not available |
| **Approval rules** | ✅ Allow Always with patterns | ❌ Per-request only |
| **Model switching** | ✅ In-session model picker | ❌ Set at start |
| **QR code access** | ✅ With token, instant | ✅ Via Ctrl+E toggle |
| **Add to Home Screen** | ✅ PWA with icon | ❌ GitHub Mobile app |
| **Token tracking** | ✅ Per-session accumulation | ❌ Not in remote view |
| **Custom UI** | ✅ Dark theme, tool summaries, reasoning | ❌ GitHub.com standard UI |
| **Offline/local use** | ✅ Works without internet | ❌ Requires GitHub.com connection |
| **Self-update** | ✅ Built-in | N/A (it's GitHub.com) |

## Architecture Comparison

### Portal
```
Browser/PWA ──ws://──▶ Portal Server ──SDK──▶ Copilot CLI
                         (your machine)
Phone ──wss://──▶ DevTunnel ──▶ Portal Server
```
- Everything runs on your machine
- DevTunnel provides HTTPS relay for remote access
- Portal server is the intermediary (adds guides, rules, sessions, UI)
- No data leaves your network unless tunnel is active

### `/remote`
```
Terminal ──▶ Copilot CLI ──events──▶ GitHub.com
Browser/Mobile ──▶ GitHub.com ──commands──▶ Copilot CLI
```
- CLI connects directly to GitHub.com
- Session events stream to GitHub's servers
- Remote commands are polled by the CLI from GitHub
- All remote interaction goes through GitHub's infrastructure
- Requires the working directory to be a GitHub repository

## Key Differences

### Data Flow
- **Portal**: session data stays on your machine. The tunnel is a dumb pipe — GitHub/Microsoft never sees your session content.
- **`/remote`**: session events are sent to GitHub.com servers. GitHub can see conversation messages, tool execution events, and permission requests.

### Prerequisites
- **Portal**: Node.js + Copilot CLI. Works in any directory.
- **`/remote`**: Must be in a GitHub repository. Enterprise/org owners must enable the "Remote Control" policy (off by default).

### Enterprise Control
- **Portal**: No organizational policy controls. Anyone with the CLI can use it.
- **`/remote`**: Governed by enterprise/organization policies. "Remote Control" policy is off by default — must be explicitly enabled by an admin.

### Session Limits
- **`/remote`**: 60 MB limit on session output sent to remote interface. Long-running sessions with large output may have reduced performance remotely. Local terminal is unaffected.
- **Portal**: No output limits. DevTunnel has 5 GB/month bandwidth cap but that's rarely hit for text-based chat.

### Mobile Experience
- **Portal**: Any mobile browser, PWA installable. Works today on any phone.
- **`/remote`**: GitHub Mobile app only (currently in TestFlight/Play beta). Not widely available yet.

### Keep-Alive
- **`/remote`**: Has `/keep-alive` command to prevent machine sleep (on/off/busy/duration).
- **Portal**: No built-in keep-alive. Machine sleep policies are the user's responsibility.

## Implications for Portal

### Is Portal obsolete?

**No.** The features are complementary:

1. **Portal adds value beyond remote access** — guides, prompts, approval rules, session management, model switching, token tracking, custom UI. `/remote` provides none of these.

2. **Portal works everywhere** — any directory, any network, no GitHub repo required, no org policy needed. `/remote` requires a GitHub repo and admin opt-in.

3. **Data sovereignty** — Portal keeps all data on your machine. For users who can't or don't want session data flowing through GitHub's servers, Portal is the only option.

4. **UI customization** — Portal's UI is purpose-built for the portal experience. `/remote` uses GitHub.com's standard interface.

### What `/remote` does better

1. **Zero setup for remote access** — no DevTunnel install, no tunnel configuration. Just `/remote` and you get a URL.
2. **GitHub.com integration** — sessions show up in your Copilot dashboard alongside other GitHub activity.
3. **GitHub Mobile** — native mobile app experience (once it's out of beta).
4. **Reconnection** — built into GitHub's infrastructure, no tunnel process to manage.

### Could they work together?

Potentially interesting: run Portal locally for the rich UI + guides + rules, AND enable `/remote` for the GitHub Mobile monitoring. They use the same CLI session. The question is whether `/remote`'s event streaming conflicts with Portal's SDK connection — needs testing.

## Recommendations

1. **Keep building Portal** — its value proposition (guides, prompts, rules, custom UI, data sovereignty) is orthogonal to `/remote`.
2. **Consider `/keep-alive` equivalent** — if users are leaving the portal running while away, preventing machine sleep would be useful.
3. **Monitor `/remote` evolution** — if GitHub adds guides, approval rules, or session management to the remote interface, the overlap increases.
4. **Test coexistence** — verify that Portal and `/remote` can run on the same session simultaneously without conflicts.
5. **Document the choice** — help users understand when to use Portal vs `/remote` vs both.

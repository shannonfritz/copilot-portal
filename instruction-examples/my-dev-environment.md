# My Development Environment

This instruction builds a profile of your development environment by asking questions,
discovering system details, and looking up project information.

## System Info (discover automatically)
- **OS:** [discover]
- **Hostname:** [discover]
- **Shell:** [discover]
- **Node.js version:** [discover]
- **Git user:** [discover]
- **Python version:** [discover: or "not installed"]

## Your Preferences (ask the user)
- **Primary language:** [ask]
- **Preferred editor:** [ask: VS Code / Vim / Other]
- **Default branch name:** [ask: main / master / other]

## Active Project (lookup based on working directory)
- **Project path:** [discover: current working directory]
- **Git remote:** [discover: from git config, or "none"]
- **Package manager:** [discover: check for package.json, requirements.txt, go.mod, Cargo.toml]
- **Dependencies count:** [discover: count from lock file if available]
- **README summary:** [discover: first 2 lines of README.md if it exists, or "none"]

---

## How This Works

When you read this file, process each field:

1. **[discover]** fields: Run the appropriate shell command or file read to detect the value
2. **[ask]** and **[ask: ...]** fields: Use ask_user to prompt the user
3. Process discovers first (they're instant), then ask the user for remaining fields

After collecting all values, use the `edit` tool to update THIS FILE — replace each
placeholder with the actual value.

On future sessions, all fields will be populated. Summarize the environment in 2-3
sentences and ask what the user wants to work on today. Do not re-discover or re-ask
filled fields.

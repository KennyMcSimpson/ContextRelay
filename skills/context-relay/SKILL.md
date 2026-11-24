---
name: context-relay
description: Internal alias redirecting to the native /relay skill for zero-UI context pruning, cross-project clean relaunch, and full-text session search in Google Antigravity.
disable-slash-command: true
---

# Context Relay (Alias for `/relay`)

This skill exists only for backward compatibility with older installations and is hidden from the `/` slash-command menu (`disable-slash-command: true`) so `/relay` remains the sole clean entry point.

Always follow the complete procedure in `../relay/SKILL.md`:

- Derive `<pluginRoot>/bin/context-relay.mjs` relative to this plugin directory (never hardcode paths).
- Run `relay --plan` / `relay --go` or `search --json`, use at most 1 native `ask_question` card only when destination/choice is genuinely ambiguous, and reply with Antigravity native `[<title>](conversation://<id>)` jump links.
- Never open a web UI or side pane, never touch `.sqlite`, and keep default secret redaction enabled.

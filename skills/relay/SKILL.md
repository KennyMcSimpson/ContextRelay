---
name: relay
description: Internal alias redirecting to the primary /fork skill for one-click denoised conversation forking, cross-project relaunch, token-savings stats, and full-text session search in Google Antigravity.
disable-slash-command: true
---

# Context Relay (Alias for `/fork`)

This skill is hidden from the `/` slash-command menu (`disable-slash-command: true`) so `/fork` remains the sole clean one-click command in Antigravity.

Always follow the complete procedure in `../fork/SKILL.md`:

- Derive `<pluginRoot>/bin/context-relay.mjs` dynamically relative to this plugin directory (zero hardcoded paths).
- Default to zero-prompt one-click execution (`fork --session <id> --go --json`) in the original workspace, use `--plan --to` for cross-project matching, `stats --json` / `stats --svg` for savings telemetry, and `search --json` for direct `[<title>](conversation://<id>)` jump links.
- Never touch `.sqlite`, keep 20-category secret redaction enabled by default, and never direct users to standalone web forms.

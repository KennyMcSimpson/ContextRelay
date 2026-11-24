<p align="center">
  <img src="assets/logo.svg" width="88" height="88" alt="Context Relay Logo" />
</p>

<h1 align="center">Context Relay</h1>

<p align="center">
  <strong>Zero-UI native <code>/fork</code> for Google Antigravity</strong><br/>
  One-click denoised conversation forking · Live sidebar title sync · 0-token bloat nudges · Lossless Git-grounded handoffs · 20-class secret redaction
</p>

<p align="center">
  <a href="https://github.com/KennyMcSimpson/ContextRelay/actions/workflows/ci.yml"><img src="https://github.com/KennyMcSimpson/ContextRelay/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/version-v0.2.2-2dd4bf?style=flat" alt="Version v0.2.2" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.15.0-38bdf8?style=flat" alt="Node >= 22.15.0" />
  <img src="https://img.shields.io/badge/dependencies-0-a78bfa?style=flat" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/tests-67%20passing-34d399?style=flat" alt="67 Tests Passing" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-64748b?style=flat" alt="MIT License" /></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a> &nbsp;|&nbsp;
  <a href="#quick-start">Quick Start</a> ·
  <a href="#fork-vs-compact">/fork vs /compact</a> ·
  <a href="#everyday-commands">Commands</a> ·
  <a href="#security--privacy">Security</a> ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="./assets/savings-benchmark.svg" alt="Context Relay Token Savings Benchmark" width="820" />
</p>

---

## Why Context Relay?

Long AI coding sessions degrade fast: build logs, progress bars, failed retries, and repeated file reads silently bloat your context window to 300k–500k+ tokens. Summarizing in place loses exact code details, while starting from scratch wastes 10 minutes re-explaining your repo state.

**Context Relay** stays completely invisible until you need it — no sidecar web apps, no manual turn-checkbox forms, no cloud LLM summarization:

<p align="center">
  <img src="./assets/workflow-preview.svg" alt="Context Relay Zero-UI Native Workflow Preview" width="820" />
</p>

## `/fork` vs `/compact`

When a session gets heavy, Context Relay's 0-token `PreInvocation` hook lets you choose between two complementary native paths:

| Need | Command | How It Works |
| :--- | :--- | :--- |
| **Compress in-place** (keep the same thread) | `/compact` *(Antigravity built-in)* | Uses an LLM to summarize earlier turns inside the current thread. |
| **Lossless denoised fresh session** *(zero summarization degradation)* | **`/fork`** *(Context Relay)* | **0-LLM deterministic surgery**: trims bulky tool noise, grounds real `git status`/`git diff`, preserves 100% verbatim goals & conclusions with lossless `transcript_full.jsonl` traceback, redacts 20 secret classes, reads your live renamed sidebar title, inherits your model, and launches `<Title> (fork)` in one click. |

### Highlights (`v0.2.2`)

- **One-Click `/fork`, Zero Popups**: Typing `/fork` opens no modals or webpages — it immediately denoises your active session in the same workspace and replies with a 2-line receipt plus a clickable `[Title (fork)](conversation://<id>)` instant-jump link.
- **Live Sidebar Title Sync (Zero SQLite)**: Reads Antigravity's plain-text `annotations/<id>.pbtxt` so your renamed sidebar title is preserved verbatim (`Auth Refactor` → `Auth Refactor (fork)` → `Auth Refactor (fork #2)`).
- **Ultra-Clean `/` Menu**: Only `/fork` appears in Antigravity's slash-command menu (legacy aliases `relay` and `context-relay` stay hidden via `disable-slash-command: true`).
- **0-Token Context Bloat Nudge**: `hooks/nudge.mjs` injects subtle inline `metadata.user_markdown` reminders with **0 model tokens** only when noise crosses threshold (opt out anytime via `CONTEXT_RELAY_NUDGE=0`).
- **Cross-Project & Turn-Bounded Forking**: Move curated context straight into another registered workspace (`/fork <project-keyword>`) or branch cleanly from an earlier turn (`/fork 第N轮`).
- **Shareable Token-Savings Card (`stats --svg`)**: Track real cumulative tokens saved with `/fork stats` or generate a crisp GitHub-ready SVG benchmark card via CLI.
- **Zero Dependencies & 100% Local**: Pure Node.js ESM (`>= 22.15.0`) — no `npm install`, no telemetry, no external API calls.

---

## Quick Start

### Prerequisites

- **Node.js `>= 22.15.0`** (zero runtime dependencies).

### Option A — Direct Clone Into Antigravity Plugins Directory (Recommended)

```bash
git clone https://github.com/KennyMcSimpson/ContextRelay.git ~/.gemini/config/plugins/context-relay
```

Antigravity automatically discovers `plugin.json`, activates the `PreInvocation` bloat-nudge hook and `Stop` incremental indexer (`hooks.json`), and exposes `/fork` in your `/` menu.

### Option B — Local Clone + Installer CLI (Custom Data Directory)

```bash
git clone https://github.com/KennyMcSimpson/ContextRelay.git ContextRelay
cd ContextRelay

node bin/context-relay.mjs install antigravity --data-dir <custom-dir>
```

---

## Everyday Commands

| What You Type in Antigravity | What Happens |
| :--- | :--- |
| `/fork` | **0 popups** — immediately denoises the current conversation in the original folder, names it `<Live Sidebar Title> (fork)`, inherits the active model, and returns a clickable `conversation://<id>` link. |
| `/fork <folder-keyword>` | Plans target workspace match (`exact` → instant `--go` with 0 popups; `ambiguous` → 1 native `ask_question` card; `not_found` → explains registering the folder in left `Projects` or exporting). |
| `/fork 第N轮` | Deterministically branches up to turn `N` (`--until <N>`) into a clean session without later detours. |
| `/fork stats` | Reports cumulative tokens saved across forks and can export a GitHub SVG war-report card (`--svg`). |
| `/fork 搜 <keyword>` | Full-text searches indexed historical sessions (including live renamed titles) and returns clickable `[<Title>](conversation://<sessionId>)` links. |

### Environment Variables

| Variable | Effect |
| :--- | :--- |
| `CONTEXT_RELAY_NUDGE=0` | Disable automatic 0-token `PreInvocation` bloat reminders completely. |
| `CONTEXT_RELAY_DATA_DIR=<dir>` | Override local index/archive/stats storage directory. |

---

## CLI Reference

```bash
# 1. One-click in-place denoised fork (original folder, live sidebar title + "(fork)")
node bin/context-relay.mjs fork --session <conversation-id> --go --json

# 2. Plan / execute cross-project or turn-bounded fork (or --export-only)
node bin/context-relay.mjs fork --session <conversation-id> --plan --to "<project-or-path>" [--until <N>] --json
node bin/context-relay.mjs fork --session <conversation-id> --go [--to "<project-id>"] [--preset smart-clean|backbone] [--until <N>] [--note "<extra-instruction>"] [--export-only] --json

# 3. View cumulative token savings & export a personal GitHub SVG card
node bin/context-relay.mjs stats --json
node bin/context-relay.mjs stats --svg ./my-savings.svg --json

# 4. Full-text search across indexed historical Antigravity sessions
node bin/context-relay.mjs search "<query>" --limit 10 --json

# 5. Inspect turns & export deterministic Git-grounded handoff bundle
node bin/context-relay.mjs inspect <conversation-id>
node bin/context-relay.mjs export <conversation-id>

# 6. Install / uninstall Antigravity plugin wiring
node bin/context-relay.mjs install antigravity --data-dir <custom-dir>
node bin/context-relay.mjs uninstall antigravity
```

<details>
<summary><strong>Optional: Offline Local Web Debugger (<code>serve</code>)</strong></summary>

Normal Antigravity usage requires **no web UI**. For power users who want an offline browser inspector, an optional loopback-only server is available:

```bash
node bin/context-relay.mjs serve --port 3477
# Open http://127.0.0.1:3477
```

</details>

---

## Security & Privacy

- **Zero Dependencies, 100% Local**: Pure Node.js ESM (`>= 22.15.0`). No external packages, no telemetry, no cloud LLM calls.
- **Strict Read-Only Boundary (Zero `.sqlite` Access)**: Reads only local `transcript*.jsonl` logs and plain-text `annotations/<id>.pbtxt` titles, and interacts solely via public local `agentapi` interfaces. **Never** opens, queries, or modifies private `.sqlite` / `.db` files.
- **20-Category Built-In Secret Redaction**: Automatically scrubs API keys, GitHub/AWS/Slack/HF/npm tokens, bearer/basic auth headers, database URLs, and PEM private keys before exporting or forking context.
- **Zero-Delete Cross-Process Locking**: Uses kernel-atomic `openSync('wx', 0o600)` + `renameSync` release with stale dead-PID recovery — verified 200/200 zero lost updates across 8 concurrent Windows processes without calling destructive delete APIs.
- **Loopback & CSRF Hardening**: Optional `serve` binds strictly to `127.0.0.1` with `Host` port verification, `Content-Type` enforcement, `Origin` / `X-Context-Relay` CSRF checks, and CSP headers.

---

## Architecture

```text
ContextRelay/
├── plugin.json                      # Antigravity root plugin manifest (v0.2.2, strict whitelist)
├── hooks.json                       # Root PreInvocation (0-token nudge) + Stop (incremental sync)
├── assets/
│   ├── logo.svg                     # Square plugin icon
│   ├── savings-benchmark.svg        # Real-world token-savings benchmark card (820×300)
│   └── workflow-preview.svg         # Native zero-UI /fork experience preview (820×272)
├── hooks/
│   ├── nudge.mjs                    # 0-token PreInvocation context bloat reminder
│   └── sync-turn.mjs                # Lightweight Stop-hook incremental transcript indexer
├── skills/
│   ├── fork/SKILL.md                # Primary one-click /fork slash command
│   ├── relay/SKILL.md               # Hidden backward-compatible alias
│   └── context-relay/SKILL.md       # Hidden backward-compatible alias
├── adapters/                        # Host adapter abstraction (Antigravity + .pbtxt live titles)
├── core/                            # Turn parser, smart pruning, Git anchor, 20-class redactor, store
├── bin/context-relay.mjs            # Unified CLI (fork, stats --svg, search, inspect, export, install)
├── server/ & ui/                    # Optional offline loopback web debugger (serve)
└── test/                            # 67 unit, redaction, concurrency, hook, CLI & manifest tests
```

All host-specific transcript discovery, annotation parsing, and clean-relaunch transport live cleanly inside `adapters/`, keeping the surgical pruning, Git grounding, secret redaction, and indexing engine host-agnostic for future coding agents.

---

## Testing

```bash
node --test test/*.test.mjs
```

## License

[MIT](./LICENSE) © 2026 KennyMcSimpson

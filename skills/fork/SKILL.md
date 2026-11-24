---
name: fork
description: One-click zero-UI /fork command for Google Antigravity. Trigger whenever the user invokes /fork, wants to cleanly fork and slim down a long conversation in the same folder without prompts, fork into another project directory, fork up to turn N, check cumulative token savings (/fork stats), or search historical Antigravity conversations with direct jump links.
---

# `/fork` — One-Click Zero-UI Context Fork

Ultra-fast, zero-prompt-by-default context denoising and lossless conversation forking inside Google Antigravity.

## CLI Location (No Hardcoded Paths)

This skill file lives at `<pluginRoot>/skills/fork/SKILL.md`. Derive `<pluginRoot>` dynamically as two directories above this file, and invoke `<pluginRoot>/bin/context-relay.mjs`. Never hardcode personal or machine-specific absolute paths.

## Guiding Principle

**One-click speed, zero popups by default**: never read bulky raw `transcript.jsonl` files into context, and never open `ask_question` unless a target folder match is genuinely ambiguous.

---

## Execution Routes

### 1. Bare `/fork` (or "一键 fork / 瘦身重开") — Zero Prompts!

**NEVER call `ask_question`.** Immediately run:

```bash
node "<pluginRoot>/bin/context-relay.mjs" fork --session <currentConversationId> --go --json
```

This automatically executes in the **original workspace directory** with deterministic noise removal, real local Git anchor, lossless verbatim traceback index, 20-category secret redaction, inherited model, and auto-generated title `<原标题> (fork)`.

Reply in **exactly 2 ultra-concise lines** using Antigravity's native instant-jump link:

```markdown
已一键 Fork 新对话：[<标题> (fork)](conversation://<newConversationId>)
上下文 <原峰值> → ~<裁剪后>（减负 <X>%）· 目录 `<path>` · 模型 `<model>` · 原文无损可回溯
```

---

### 2. `/fork <目录关键词>` — Fork Into Another Project Directory

1. Run deterministic target planning first:
   ```bash
   node "<pluginRoot>/bin/context-relay.mjs" fork --session <currentConversationId> --plan --to "<目录关键词>" --json
   ```
2. Act on `targetMatch.status`:
   - **`exact`**: **Zero prompts!** Immediately run:
     ```bash
     node "<pluginRoot>/bin/context-relay.mjs" fork --session <currentConversationId> --go --to "<matchedProjectId>" [--note "<用户附加要求>"] --json
     ```
     Then return the 2-line receipt above.
   - **`ambiguous`**: Call native **`ask_question`** **once** (`is_multi_select: false`) listing the matched candidate projects (plus an export-only fallback), then run `--go` with the chosen project ID and return the 2-line receipt.
   - **`not_found`**: Honestly inform the user that the folder has not been opened in Antigravity's left `Projects` sidebar yet (Antigravity provides no public API to register a new Project), and offer two clear options:
     1. Open that folder once in Antigravity's left `Projects` sidebar, then re-run `/fork <目录关键词>`;
     2. Export a redacted handoff bundle (`--export-only`) for manual paste.

---

### 3. `/fork 第N轮` — Turn-Bounded Fork

Truncate deterministically at turn `N` and fork in one click (no prompts unless combined with an ambiguous `--to`):

```bash
node "<pluginRoot>/bin/context-relay.mjs" fork --session <currentConversationId> --go --until <N> [--to "<matchedProjectId>"] [--note "<用户附加要求>"] --json
```

Return the 2-line receipt above.

---

### 4. `/fork stats` — Token Savings & Shareable SVG Card

Query cumulative token savings across past forks:

```bash
node "<pluginRoot>/bin/context-relay.mjs" stats --json
```

When the user also asks to generate a GitHub/README benchmark card image, pass `--svg <out.svg>`:

```bash
node "<pluginRoot>/bin/context-relay.mjs" stats --svg "<out.svg>" --json
```

Report total tokens saved, fork count, average reduction percentage, and the generated SVG path (if requested).

---

### 5. `/fork 搜 <关键词>` / Search Historical Sessions

```bash
node "<pluginRoot>/bin/context-relay.mjs" search "<关键词>" --limit 10 --json
```

Present hits directly as Antigravity native instant-jump links `[<标题>](conversation://<sessionId>)` with project folder, model, and timestamp.

---

### 6. When Asked "In-Place Compression vs Fork?"

Answer directly and honestly:
- **In-place compression** inside the current conversation: use Antigravity's built-in `/compact`.
- **Zero-degradation denoising into a fresh conversation** (verbatim traceback, real Git diff anchor, optional cross-directory move): use `/fork`.

---

## Hard Red Lines

- **Never touch `.sqlite` databases** — strictly read-only `transcript*.jsonl` and public local `agentapi`.
- **Never leak plaintext secrets** — keep 20-category secret redaction enabled by default.
- **Never send the user to standalone web pages or manual forms** — keep the workflow 100% native inside Antigravity.

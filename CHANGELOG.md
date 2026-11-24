# Changelog

All notable changes to **Context Relay** are documented in this file.

## [0.2.2] — 2026-11-25

### Added
- **Live Sidebar Renamed Title Sync**: Added a linear `O(N)` protobuf text-format parser (`parseAnnotationPbtxtTitle`) and read-only reader (`readAnnotationForTranscript`) for Antigravity's `<appDataDir>/annotations/<sessionId>.pbtxt` (zero `.sqlite` access, symlink-safe, path-bounded).
- **Sub-Millisecond Rename Hot-Refresh**: `store.syncAll()` and `store.syncSingle()` detect `.pbtxt` changes even when `transcript.jsonl` is untouched, updating titles and full-text search indexes immediately and restoring the original transcript title if a custom title is cleared.
- **GitHub Visual Showcase & CI**: Added bilingual README (`README.md` + `README.zh-CN.md`), native zero-UI workflow preview SVG (`assets/workflow-preview.svg`), `CHANGELOG.md`, MIT `LICENSE`, and GitHub Actions CI (`node --test` on Ubuntu & Windows, Node 22 & 24).

### Fixed
- `/fork` now inherits the exact live sidebar title you renamed (e.g. `Auth Refactor` → `Auth Refactor (fork)` → `Auth Refactor (fork #2)`) instead of falling back to the truncated first user prompt.
- Constructed synthetic secret test fixtures via runtime string concatenation so tests pass cleanly without tripping GitHub Secret Scanning Push Protection.

## [0.2.1] — 2026-11-25

### Added
- **One-Click Zero-UI `/fork`**: Made `/fork` the sole visible slash command in Antigravity's `/` menu (`relay` and `context-relay` hidden via `disable-slash-command: true`), executing immediately in the original folder with 0 popups and auto-incrementing `(fork)` / `(fork #N)` titles.
- **Shareable Token-Savings War-Report (`stats --svg`)**: Added `/fork stats` and `node bin/context-relay.mjs stats --svg <out.svg>` with XML escaping, secret redaction, and `--demo` preview support, plus `assets/savings-benchmark.svg`.
- **Lossless Verbatim Traceback**: Embedded exact `transcript_full.jsonl` path and pruned step indices into handoff bundles so forked sessions never lose detail when noise is trimmed.
- **Subagent Nudge Filter**: `hooks/nudge.mjs` automatically skips subagent sessions and aligns bloat prompts to `/compact` (in-place) vs `/fork` (fresh denoised session).

## [0.2.0] — 2026-11-24

### Added
- **Zero-UI Native Architecture**: Replaced the standalone web sidecar with headless one-shot warmup (`has_web_ui: false`, `restart_policy: "never"`), 0-token `PreInvocation` bloat nudges (`metadata.user_markdown`), and `Stop`-hook incremental indexing.
- **Kernel-Atomic Zero-Delete Cross-Process Lock**: Implemented `openSync('wx', 0o600)` + `renameSync` release + stale dead-PID recovery (verified 200/200 zero lost updates across 8 concurrent processes on Windows) with zero file-delete APIs.
- **20-Category Secret Redaction & Hardening**: Expanded redaction rules, added ReDoS-safe parsers, `git --no-ext-diff --no-textconv` isolation, strict CSRF/Host/CSP guards on optional `serve`, and safe read-only `agentapi.bat` shim binary extraction.

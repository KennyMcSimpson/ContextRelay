#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteFile,
  canonicalFileKey,
  canonicalRealKey,
  ensureDir,
  getDataDir,
  getPluginRoot,
  isNotSymlink,
  isPathInsideRoot,
  safeReaddirWithTypes,
} from '../core/fs-utils.mjs';
import { applySurgeryPreset } from '../core/turn-parser.mjs';
import { collectGitAnchor } from '../core/git-anchor.mjs';
import {
  buildHandoffBundle,
  buildLaunchPrompt,
  HARD_INLINE_LIMIT_BYTES,
  INLINE_LIMIT_BYTES,
} from '../core/handoff-builder.mjs';
import { redactSensitive } from '../core/redact.mjs';
import { createAgentApiClient } from '../core/agentapi.mjs';
import { createRelayStore } from '../core/store.mjs';
import { startHttpServer } from '../server/http.mjs';

const BOOLEAN_FLAGS = new Set([
  'json',
  'all-subagents',
  'no-redact',
  'no-git',
  'no-sync',
  'dry-run',
  'force',
  'plan',
  'go',
  'export-only',
  'demo',
  'help',
  'version',
]);

const VALUE_FLAGS = new Set([
  'port',
  'out',
  'target',
  'data-dir',
  'limit',
  'preset',
  'session',
  'to',
  'until',
  'model',
  'title',
  'note',
  'svg',
]);

const RELEASE_FILES = ['plugin.json', 'hooks.json', 'package.json', 'README.md'];
const RELEASE_DIRS = [
  'assets',
  'bin',
  'core',
  'adapters',
  'hooks',
  'server',
  'sidecars',
  'skills',
  'ui',
];
const SKIP_ENTRY_NAMES = new Set([
  '.git',
  '.local-data',
  'test',
  'tests',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
]);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      for (let j = i + 1; j < argv.length; j++) pos.push(argv[j]);
      break;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '-v') {
      flags.version = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        if (VALUE_FLAGS.has(key) && !val.trim()) {
          errors.push(`Option --${key} requires a non-empty value.`);
          continue;
        }
        flags[key] = val;
        continue;
      }
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (
          next === undefined ||
          next === '-h' ||
          next === '-v' ||
          next.startsWith('--') ||
          !next.trim()
        ) {
          errors.push(`Option --${key} requires a value.`);
          continue;
        }
        flags[key] = next;
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      pos.push(arg);
    }
  }
  return { pos, flags, errors };
}

function readPackageVersion() {
  try {
    const pkgPath = join(getPluginRoot(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg?.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

function formatCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function truncateInline(text, maxLen = 60) {
  const single = String(text || '').replace(/\s+/g, ' ').trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, Math.max(1, maxLen - 1))}…`;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const render = (cols) => cols.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(render(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(render(row));
  }
}

function printHelp() {
  const version = readPackageVersion();
  console.log(`Context Relay CLI v${version}

Usage:
  context-relay <command> [options]

Commands:
  fork [--session <id>] [--plan|--go] [--to <projectId|keyword>] [--preset smart-clean|backbone] [--until <turnIndex>] [--model <modelId>] [--title <title>] [--note <instruction>] [--export-only] [--no-redact] [--no-git] [--json] [--data-dir <dir>] [--no-sync]
      One-click context surgery & clean conversation fork (defaults to --go; use --plan to preview first).

  relay [--session <id>] [--plan|--go] [--to <projectId|keyword>] [--preset smart-clean|backbone] [--until <turnIndex>] [--model <modelId>] [--title <title>] [--note <instruction>] [--export-only] [--no-redact] [--no-git] [--json] [--data-dir <dir>] [--no-sync]
      Alias of fork (defaults to --plan when neither --plan nor --go is specified).

  stats [--svg <outPath>] [--demo] [--json] [--data-dir <dir>]
      Show cumulative token savings telemetry and optionally render an HD SVG savings card.

  serve [--port 3477] [--data-dir <dir>]
      Start the loopback-only local web workbench (use --port 0 for an ephemeral port).

  search [query] [--limit 20] [--all-subagents] [--json] [--data-dir <dir>] [--no-sync]
      Full-text search across indexed Antigravity sessions.

  inspect <sessionId> [--json] [--data-dir <dir>] [--no-sync]
      Inspect turns, tool calls, and noise ratio for a specific session.

  export <sessionId> [--preset smart-clean|backbone|all] [--out <file>] [--no-redact] [--no-git] [--json] [--data-dir <dir>] [--no-sync]
      Build and export a refined Markdown handoff bundle.

  install antigravity [--target <dir>] [--data-dir <dir>] [--dry-run] [--force] [--json]
      Copy the whitelisted Context Relay plugin files into Antigravity's plugins directory
      (never creates symlinks/junctions; writes .local-config.json; refuses to overwrite unrelated non-empty dirs without --force).

  uninstall antigravity [--target <dir>] [--dry-run] [--json]
      Verify installation path and print safe uninstall instructions without deleting user files.

Options:
  -h, --help      Show this help message
  -v, --version   Show version number
`);
}

function resolveDefaultInstallTarget() {
  return join(homedir(), '.gemini', 'config', 'plugins', 'context-relay');
}

function resolveOptionString(flags, key) {
  return typeof flags[key] === 'string' && flags[key].trim() ? flags[key].trim() : '';
}

function openStore(flags) {
  const dataDirOverride = resolveOptionString(flags, 'data-dir');
  const dataDir = getDataDir(dataDirOverride);
  const store = createRelayStore({ dataDir });
  if (!flags['no-sync'] && typeof store.syncAll === 'function') {
    store.syncAll({ force: false });
  }
  return { store, dataDir };
}

function normalizeListedSessions(raw) {
  if (Array.isArray(raw)) return { sessions: raw, total: raw.length };
  const sessions = Array.isArray(raw?.sessions)
    ? raw.sessions
    : Array.isArray(raw?.items)
      ? raw.items
      : [];
  const total = typeof raw?.total === 'number' ? raw.total : sessions.length;
  return { sessions, total };
}

function loadSession(store, sessionId) {
  const fn =
    typeof store?.getSessionDetail === 'function'
      ? store.getSessionDetail.bind(store)
      : typeof store?.getSession === 'function'
        ? store.getSession.bind(store)
        : typeof store?.getParsedSession === 'function'
          ? store.getParsedSession.bind(store)
          : typeof store?.loadSession === 'function'
            ? store.loadSession.bind(store)
            : null;
  if (!fn) return null;
  const raw = fn(sessionId);
  if (!raw || typeof raw !== 'object') return null;
  return raw.session && typeof raw.session === 'object' ? raw.session : raw;
}

function normalizePathForCompare(p) {
  if (typeof p !== 'string') return '';
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getPathLastSegment(p) {
  const norm = normalizePathForCompare(p);
  if (!norm) return '';
  const parts = norm.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Deterministically match a `--to <keyword>` target against known Antigravity projects.
 * Priority: projectId exact > displayName exact (ci) > primaryPath last segment / exact path > substring.
 */
function matchTargetProject(keyword, projects = []) {
  const raw = typeof keyword === 'string' ? keyword.trim() : '';
  if (!raw) {
    return { status: 'none', query: '', matched: null, candidates: [] };
  }

  const list = Array.isArray(projects) ? projects.filter((p) => p && typeof p === 'object') : [];
  const lower = raw.toLowerCase();
  const normQueryPath = normalizePathForCompare(raw);

  const finalize = (hits) => {
    if (hits.length === 1) {
      return { status: 'exact', query: raw, matched: hits[0], candidates: hits };
    }
    return { status: 'ambiguous', query: raw, matched: null, candidates: hits };
  };

  // Tier 1: exact projectId (case-sensitive first, then case-insensitive)
  const idExact = list.filter((p) => String(p.projectId || '').trim() === raw);
  if (idExact.length > 0) return finalize(idExact);
  const idExactCi = list.filter((p) => String(p.projectId || '').trim().toLowerCase() === lower);
  if (idExactCi.length > 0) return finalize(idExactCi);

  // Tier 2: exact displayName (case-insensitive)
  const nameExact = list.filter((p) => String(p.displayName || '').trim().toLowerCase() === lower);
  if (nameExact.length > 0) return finalize(nameExact);

  // Tier 3: primaryPath last segment (or exact normalized primaryPath)
  const segHits = list.filter((p) => {
    const prim = String(p.primaryPath || '');
    if (!prim) return false;
    return getPathLastSegment(prim) === lower || normalizePathForCompare(prim) === normQueryPath;
  });
  if (segHits.length > 0) return finalize(segHits);

  // Tier 4: substring match against primaryPath or displayName
  const subHits = list.filter((p) => {
    const primNorm = normalizePathForCompare(p.primaryPath || '');
    const nameLow = String(p.displayName || '').toLowerCase();
    return (
      (primNorm && (primNorm.includes(lower) || (normQueryPath && primNorm.includes(normQueryPath)))) ||
      (nameLow && nameLow.includes(lower))
    );
  });
  if (subHits.length > 0) return finalize(subHits);

  return { status: 'not_found', query: raw, matched: null, candidates: list.slice(0, 12) };
}

function computeRelaySelection(session, preset, untilTurn) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  if (untilTurn !== null) {
    if (preset === 'backbone') {
      const base = applySurgeryPreset(session, 'backbone');
      const allowedTurnIds = new Set(
        turns.filter((t) => Number(t?.index) <= untilTurn).map((t) => t.id),
      );
      const selectedTurnIds = base.selectedTurnIds.filter((tid) => allowedTurnIds.has(tid));
      const keptTurnSet = new Set(selectedTurnIds);
      const allowedItemIds = new Set();
      for (const turn of turns) {
        if (!keptTurnSet.has(turn.id)) continue;
        for (const item of turn.items || []) {
          allowedItemIds.add(item.id);
        }
      }
      const selectedItemIds = base.selectedItemIds.filter((iid) => allowedItemIds.has(iid));
      return {
        effectivePreset: `backbone+until:${untilTurn}`,
        selection: { selectedTurnIds, selectedItemIds },
      };
    }
    return {
      effectivePreset: 'truncate-at',
      selection: applySurgeryPreset(session, 'truncate-at', { maxTurnIndex: untilTurn }),
    };
  }
  return {
    effectivePreset: preset,
    selection: applySurgeryPreset(session, preset),
  };
}

const FORK_TITLE_MAX_CHARS = 180;

/**
 * Format a clean fork title with smart incrementing `(fork)` / `(fork #N)` suffix.
 * Strips surrounding whitespace and legacy `[Relay]` prefix, and preserves the suffix within 180 chars.
 */
export function formatForkTitle(rawTitle) {
  const cleaned = String(rawTitle ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^(?:\[relay\]\s*)+/i, '')
    .trim();

  let base = cleaned || 'Untitled';
  let suffix = ' (fork)';

  const numberedMatch = base.match(/\s*\(fork\s*#(\d+)\)\s*$/i);
  if (numberedMatch) {
    const nextNum = Math.max(2, Number(numberedMatch[1]) + 1);
    base = base.slice(0, numberedMatch.index).trim() || 'Untitled';
    suffix = ` (fork #${nextNum})`;
  } else if (/\s*\(fork\)\s*$/i.test(base)) {
    base = base.replace(/\s*\(fork\)\s*$/i, '').trim() || 'Untitled';
    suffix = ' (fork #2)';
  }

  const maxBaseLen = Math.max(1, FORK_TITLE_MAX_CHARS - suffix.length);
  if (base.length > maxBaseLen) {
    if (maxBaseLen <= 1) {
      base = base.slice(0, maxBaseLen);
    } else {
      let cut = base.slice(0, maxBaseLen - 1);
      const lastCode = cut.charCodeAt(cut.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        cut = cut.slice(0, -1);
      }
      base = `${cut.trimEnd()}…`;
    }
  }

  return `${base}${suffix}`;
}

function emitRelayError(flags, payload, humanMessage) {
  if (flags.json) {
    console.log(JSON.stringify({ ok: false, ...payload }, null, 2));
  } else {
    console.error(humanMessage || payload?.error || 'Relay failed');
  }
  process.exitCode = 1;
}

async function cmdRelay(flags, { defaultGo = false } = {}) {
  if (flags.plan && flags.go) {
    emitRelayError(
      flags,
      { error: 'Cannot combine --plan and --go in the same invocation' },
      'Error: --plan 与 --go 不能同时使用，请二选一。',
    );
    return;
  }

  const isGo = Boolean(flags.go || (defaultGo && !flags.plan));
  const presetRaw = resolveOptionString(flags, 'preset') || 'smart-clean';
  if (!['smart-clean', 'backbone', 'all'].includes(presetRaw)) {
    emitRelayError(
      flags,
      { error: `Invalid --preset: ${presetRaw} (expected smart-clean or backbone)` },
      `Error: 无效的 --preset 值 "${presetRaw}"（支持 smart-clean 或 backbone）。`,
    );
    return;
  }

  let untilTurn = null;
  if (flags.until !== undefined) {
    const untilStr = typeof flags.until === 'string' ? flags.until.trim() : '';
    if (!/^\d+$/.test(untilStr) || Number(untilStr) < 1) {
      emitRelayError(
        flags,
        { error: `Invalid --until value: ${flags.until} (expected integer >= 1)` },
        `Error: 无效的 --until 值 "${flags.until}"（应为 >= 1 的整数轮次）。`,
      );
      return;
    }
    untilTurn = Number(untilStr);
  }

  const dataDirOverride = resolveOptionString(flags, 'data-dir');
  const dataDir = getDataDir(dataDirOverride);
  const agentApi = createAgentApiClient();
  const store = createRelayStore({ dataDir, agentApi });

  if (!flags['no-sync'] && typeof store.syncAll === 'function') {
    store.syncAll({ force: false });
  }

  const requestedSessionId = resolveOptionString(flags, 'session');
  let targetSessionId = requestedSessionId;
  if (!targetSessionId) {
    const listed = normalizeListedSessions(
      store.listSessions({ hideSubagents: true, limit: 20 }),
    );
    const latest = listed.sessions.find((s) => !s?.isSubagent) || listed.sessions[0] || null;
    targetSessionId = String(latest?.sessionId || latest?.id || '').trim();
  }

  if (!targetSessionId) {
    emitRelayError(
      flags,
      { error: 'No sessions found in local Antigravity index' },
      '未在本地索引中找到可用会话，请先确认 Antigravity 对话记录存在或指定 --session <id>。',
    );
    return;
  }

  let session = loadSession(store, targetSessionId);
  if (!session) {
    emitRelayError(
      flags,
      { error: `Session not found: ${targetSessionId}`, sessionId: targetSessionId },
      `未找到指定会话：${targetSessionId}`,
    );
    return;
  }

  const effectiveSessionId = String(session.sessionId || session.id || targetSessionId).trim();
  const agentApiAvailable = Boolean(agentApi.resolveAgentApiExecutable()?.available);
  const toKeyword = resolveOptionString(flags, 'to');

  // Enrich current session + up to 6 recent sessions missing projectId when agentApi is available
  if (agentApiAvailable && typeof store.enrichProjectsAsync === 'function') {
    const needCurrent = !session.projectId;
    const existingProjects = store.listProjects();
    const shouldEnrichList =
      needCurrent ||
      existingProjects.length === 0 ||
      (Boolean(toKeyword) && matchTargetProject(toKeyword, existingProjects).status === 'not_found');

    if (shouldEnrichList) {
      const recentListed = normalizeListedSessions(
        store.listSessions({ hideSubagents: true, limit: 40 }),
      );
      const missingIds = recentListed.sessions
        .filter((s) => s && !s.projectId && String(s.sessionId || s.id || '') !== effectiveSessionId)
        .slice(0, 6)
        .map((s) => String(s.sessionId || s.id));
      const targetIds = needCurrent ? [effectiveSessionId, ...missingIds] : missingIds;
      if (targetIds.length > 0) {
        try {
          await store.enrichProjectsAsync({
            limit: Math.min(7, targetIds.length),
            targetSessionIds: targetIds,
          });
          const refreshed = loadSession(store, effectiveSessionId);
          if (refreshed) session = refreshed;
        } catch {
          // Non-fatal metadata enrichment failure
        }
      }
    }
  }

  const allProjects = store.listProjects();
  const currentProjectId = String(session.projectId || '').trim();
  const currentWsNorm = normalizePathForCompare(session.workspacePath || '');
  const currentProject =
    allProjects.find((p) => p.projectId === currentProjectId) ||
    (currentWsNorm
      ? allProjects.find((p) => normalizePathForCompare(p.primaryPath || '') === currentWsNorm)
      : null) ||
    null;
  const resolvedCurrentProjectId = currentProjectId || currentProject?.projectId || '';
  const otherProjects = allProjects.filter((p) => {
    if (resolvedCurrentProjectId && p.projectId === resolvedCurrentProjectId) return false;
    if (currentWsNorm && normalizePathForCompare(p.primaryPath || '') === currentWsNorm) return false;
    return true;
  });

  const targetMatch = matchTargetProject(toKeyword, allProjects);
  const { effectivePreset, selection } = computeRelaySelection(session, presetRaw, untilTurn);
  const redact = !flags['no-redact'];
  const includeGit = !flags['no-git'];
  const note = resolveOptionString(flags, 'note');

  const fullStepLoader = (stepIdx) => {
    try {
      const loaded = store.getFullStepContent?.(effectiveSessionId, stepIdx);
      return typeof loaded?.content === 'string' ? loaded.content : '';
    } catch {
      return '';
    }
  };

  // ==================== PLAN MODE ====================
  if (!isGo) {
    const plannedWorkspace =
      targetMatch.status === 'exact' && targetMatch.matched?.primaryPath
        ? targetMatch.matched.primaryPath
        : session.workspacePath || currentProject?.primaryPath || '';
    const gitSourcePath = session.workspacePath || currentProject?.primaryPath || plannedWorkspace || '';
    const gitAnchor = includeGit && gitSourcePath ? collectGitAnchor(gitSourcePath) : null;

    const bundle = buildHandoffBundle(session, {
      preset: effectivePreset,
      selectedTurnIds: selection.selectedTurnIds,
      selectedItemIds: selection.selectedItemIds,
      redact,
      includeGitAnchor: includeGit,
      gitAnchor,
      extraInstruction: note,
      targetWorkspace: plannedWorkspace,
      fullStepLoader,
    });

    const planResult = {
      ok: true,
      mode: 'plan',
      agentApiAvailable,
      dataDir,
      session: {
        sessionId: effectiveSessionId,
        title: session.title || '',
        model: session.lastModel || session.firstModel || '',
        projectId: resolvedCurrentProjectId,
        workspacePath: session.workspacePath || currentProject?.primaryPath || '',
        gitBranch: gitAnchor?.branch || session.branchName || '',
        gitDirtyCount: gitAnchor?.dirtyCount ?? 0,
        gitUntrackedCount: gitAnchor?.untrackedCount ?? 0,
        totalTurns: Array.isArray(session.turns) ? session.turns.length : 0,
        peakContextTokens: session.peakContextTokens || 0,
        updatedAt: session.updatedAt || '',
      },
      plan: {
        preset: effectivePreset,
        untilTurn,
        redact,
        includeGit,
        inlineLimitBytes: INLINE_LIMIT_BYTES,
        hardInlineLimitBytes: HARD_INLINE_LIMIT_BYTES,
        originalPeakTokens: bundle.originalPeakTokens ?? session.peakContextTokens ?? 0,
        handoffEstimatedTokens: bundle.estimatedTokens ?? 0,
        savedPercent: bundle.savedPercent ?? 0,
        bytes: bundle.bytes ?? Buffer.byteLength(bundle.markdown || '', 'utf-8'),
        redactionCount: bundle.redactionCount ?? 0,
        selectedTurnsCount: bundle.selectedTurnsCount ?? 0,
        totalTurnsCount: bundle.totalTurnsCount ?? 0,
        selectedItemsCount: bundle.selectedItemsCount ?? 0,
        totalItemsCount: bundle.totalItemsCount ?? 0,
        recommendFileMode: Boolean(bundle.recommendFileMode),
      },
      currentProject,
      projects: allProjects,
      otherProjects,
      targetMatch,
    };

    if (flags.json) {
      console.log(JSON.stringify(planResult, null, 2));
      return;
    }

    console.log(`=== Context Relay 预演计划 ===`);
    console.log(`源会话:   ${planResult.session.title || '(未命名)'} (${effectiveSessionId})`);
    console.log(`模型:     ${planResult.session.model || '-'}`);
    console.log(`当前目录: ${planResult.session.workspacePath || '未关联'}`);
    console.log(
      `瘦身预估: ${formatCompact(planResult.plan.originalPeakTokens)} → ~${formatCompact(planResult.plan.handoffEstimatedTokens)} tok` +
        `（节省 ${planResult.plan.savedPercent}% | ${formatBytes(planResult.plan.bytes)} | 脱敏 ${planResult.plan.redactionCount} 处）`,
    );
    console.log(
      `裁剪策略: ${effectivePreset}（保留 ${planResult.plan.selectedTurnsCount}/${planResult.plan.totalTurnsCount} 轮，` +
        `${planResult.plan.selectedItemsCount}/${planResult.plan.totalItemsCount} 条工具步骤，建议模式: ${planResult.plan.recommendFileMode ? 'file' : 'inline'}）`,
    );
    if (toKeyword) {
      console.log(
        `目标匹配: "${toKeyword}" -> ${targetMatch.status}` +
          (targetMatch.matched
            ? ` (${targetMatch.matched.displayName || targetMatch.matched.projectId}: ${targetMatch.matched.primaryPath})`
            : `（候选 ${targetMatch.candidates.length} 个）`),
      );
    }
    if (otherProjects.length > 0) {
      console.log(`其他已知项目 (${otherProjects.length}):`);
      for (const p of otherProjects.slice(0, 8)) {
        console.log(`  - ${p.displayName || p.projectId}: ${p.primaryPath || p.projectId}`);
      }
    }
    return;
  }

  // ==================== GO MODE ====================
  let targetProjectId = resolvedCurrentProjectId;
  let targetWorkspace = session.workspacePath || currentProject?.primaryPath || '';

  if (toKeyword) {
    if (targetMatch.status === 'ambiguous') {
      emitRelayError(
        flags,
        {
          error: `Ambiguous --to target "${toKeyword}": matched ${targetMatch.candidates.length} projects`,
          targetMatch,
          projects: allProjects,
          otherProjects,
        },
        `目标项目关键词 "${toKeyword}" 匹配到多个候选，已中止以防误发：\n` +
          targetMatch.candidates
            .map((p) => `  - ${p.displayName || p.projectId} (${p.projectId}) -> ${p.primaryPath || ''}`)
            .join('\n'),
      );
      return;
    }
    if (targetMatch.status === 'not_found') {
      emitRelayError(
        flags,
        {
          error: `Target project not found for --to "${toKeyword}"`,
          targetMatch,
          projects: allProjects,
          otherProjects,
        },
        `未找到匹配 "${toKeyword}" 的已知项目，已中止以防误发。` +
          (allProjects.length > 0
            ? `\n本机已知项目：\n` +
              allProjects
                .slice(0, 10)
                .map((p) => `  - ${p.displayName || p.projectId} (${p.projectId}) -> ${p.primaryPath || ''}`)
                .join('\n')
            : '\n当前 projects.json 尚无已知项目映射。'),
      );
      return;
    }
    if (targetMatch.status === 'exact' && targetMatch.matched) {
      targetProjectId = targetMatch.matched.projectId;
      targetWorkspace = targetMatch.matched.primaryPath || '';
    }
  }

  const gitSourcePath = session.workspacePath || currentProject?.primaryPath || targetWorkspace || '';
  const gitAnchor = includeGit && gitSourcePath ? collectGitAnchor(gitSourcePath) : null;

  const bundle = buildHandoffBundle(session, {
    preset: effectivePreset,
    selectedTurnIds: selection.selectedTurnIds,
    selectedItemIds: selection.selectedItemIds,
    redact,
    includeGitAnchor: includeGit,
    gitAnchor,
    extraInstruction: note,
    targetWorkspace,
    fullStepLoader,
  });

  const customTitle = resolveOptionString(flags, 'title');
  const relayTitle = customTitle || formatForkTitle(session.title || effectiveSessionId);
  const bundleBytes =
    typeof bundle.bytes === 'number'
      ? bundle.bytes
      : Buffer.byteLength(bundle.markdown || '', 'utf-8');
  const originalPeakTokens = bundle.originalPeakTokens ?? session.peakContextTokens ?? 0;
  const handoffEstimatedTokens = bundle.estimatedTokens ?? 0;
  const savedPercent = bundle.savedPercent ?? 0;
  const redactionCount = bundle.redactionCount ?? 0;

  // Always archive a copy to <dataDir>/handoffs/
  const saved = store.saveHandoffFile({
    title: customTitle || session.title || effectiveSessionId,
    markdown: bundle.markdown,
    sourceSessionId: effectiveSessionId,
  });

  if (flags['export-only']) {
    const exportPayload = {
      ok: true,
      mode: 'export-only',
      filePath: saved.filePath,
      filename: saved.filename,
      sourceSessionId: effectiveSessionId,
      targetProjectId,
      targetWorkspace,
      preset: effectivePreset,
      originalPeakTokens,
      handoffEstimatedTokens,
      savedPercent,
      bytes: bundleBytes,
      redactionCount,
      selectedTurnsCount: bundle.selectedTurnsCount ?? 0,
      totalTurnsCount: bundle.totalTurnsCount ?? 0,
      recommendFileMode: Boolean(bundle.recommendFileMode),
    };
    if (flags.json) {
      console.log(JSON.stringify(exportPayload, null, 2));
    } else {
      console.log(`已归档交接包（仅导出模式）：${saved.filePath}`);
      console.log(
        `体量: ${formatBytes(bundleBytes)} (~${formatCompact(handoffEstimatedTokens)} tok) | ` +
          `节省: ${savedPercent}% | 脱敏: ${redactionCount} 处`,
      );
    }
    return;
  }

  if (!agentApiAvailable) {
    emitRelayError(
      flags,
      {
        error: 'Antigravity agentapi is unavailable in this environment; handoff was archived only.',
        handoffFilePath: saved.filePath,
        filename: saved.filename,
      },
      `未检测到可用的 Antigravity agentapi，无法自动拉起新会话。\n交接包已安全归档至：${saved.filePath}`,
    );
    return;
  }

  const useFileMode =
    Boolean(bundle.recommendFileMode) ||
    bundleBytes > INLINE_LIMIT_BYTES ||
    bundleBytes > HARD_INLINE_LIMIT_BYTES;

  const launch = buildLaunchPrompt({
    bundle,
    handoffFilePath: useFileMode ? saved.filePath : '',
    targetWorkspace,
    extraInstruction: note,
    forceFileMode: useFileMode,
    redact,
  });

  const finalModel =
    resolveOptionString(flags, 'model') || session.lastModel || session.firstModel || '';

  const startRes = await agentApi.startNewConversationAsync({
    prompt: launch.prompt,
    model: finalModel,
    title: relayTitle,
    projectId: targetProjectId,
  });

  if (!startRes?.ok || !startRes.conversationId) {
    emitRelayError(
      flags,
      {
        error: startRes?.error || 'Failed to launch new conversation via agentapi',
        handoffFilePath: saved.filePath,
        filename: saved.filename,
      },
      `拉起新会话失败：${startRes?.error || 'unknown error'}\n交接包已保留在：${saved.filePath}`,
    );
    return;
  }

  const conversationId = startRes.conversationId;
  store.recordLineage({
    sourceSessionId: effectiveSessionId,
    sourceTitle: session.title || '',
    sourceProjectId: resolvedCurrentProjectId,
    sourceWorkspacePath: session.workspacePath || currentProject?.primaryPath || '',
    targetSessionId: conversationId,
    targetConversationId: conversationId,
    targetTitle: relayTitle,
    targetProjectId,
    targetWorkspace,
    model: finalModel,
    mode: launch.mode,
    launchMode: launch.mode,
    handoffFilePath: saved.filePath,
    handoffFilename: saved.filename,
    preset: effectivePreset,
    originalPeakTokens,
    savedPercent,
    bytes: bundleBytes,
    estimatedTokens: handoffEstimatedTokens,
    handoffEstimatedTokens,
    redactionCount,
  });

  const launchPayload = {
    ok: true,
    mode: 'launched',
    conversationId,
    conversationLink: `conversation://${conversationId}`,
    title: relayTitle,
    targetProjectId,
    targetWorkspace,
    model: finalModel,
    launchMode: launch.mode,
    handoffFilePath: saved.filePath,
    originalPeakTokens,
    handoffEstimatedTokens,
    savedPercent,
    bytes: bundleBytes,
    redactionCount,
    selectedTurnsCount: bundle.selectedTurnsCount ?? 0,
    totalTurnsCount: bundle.totalTurnsCount ?? 0,
  };

  if (flags.json) {
    console.log(JSON.stringify(launchPayload, null, 2));
    return;
  }

  console.log(`已创建干净接力会话：${relayTitle}`);
  console.log(`直达链接: ${launchPayload.conversationLink}`);
  console.log(`目标目录: ${targetWorkspace || '(当前项目)'} (${targetProjectId || '-'})`);
  console.log(`模型/模式: ${finalModel || '默认'} | ${launch.mode}`);
  console.log(
    `瘦身效果: ${formatCompact(originalPeakTokens)} → ~${formatCompact(handoffEstimatedTokens)} tok` +
      `（节省 ${savedPercent}% | 脱敏 ${redactionCount} 处）`,
  );
  console.log(`档案路径: ${saved.filePath}`);
}

async function cmdServe(flags) {
  let port = 3477;
  if (flags.port !== undefined) {
    if (typeof flags.port !== 'string' || !/^\d+$/.test(flags.port.trim())) {
      console.error(`Invalid --port value: ${flags.port} (expected integer 0..65535)`);
      process.exitCode = 1;
      return;
    }
    const parsedPort = Number(flags.port.trim());
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      console.error(`Invalid --port value: ${flags.port} (expected integer 0..65535)`);
      process.exitCode = 1;
      return;
    }
    port = parsedPort;
  }

  const dataDir = resolveOptionString(flags, 'data-dir') || undefined;
  const srv = await startHttpServer({ port, host: '127.0.0.1', dataDir });
  console.log(`Context Relay web workbench listening at ${srv.url}`);
  console.log(`Data directory: ${getDataDir(dataDir || '')}`);
  console.log('Press Ctrl+C to stop.');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      srv.server?.closeIdleConnections?.();
      srv.server?.closeAllConnections?.();
      await srv.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function cmdSearch(pos, flags) {
  const query = pos.slice(1).join(' ').trim();
  let limit = 20;
  if (flags.limit !== undefined) {
    if (typeof flags.limit !== 'string' || !/^\d+$/.test(flags.limit.trim())) {
      console.error(`Invalid --limit value: ${flags.limit} (expected integer 1..200)`);
      process.exitCode = 1;
      return;
    }
    const rawLimit = Number(flags.limit.trim());
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
      console.error(`Invalid --limit value: ${flags.limit} (expected integer 1..200)`);
      process.exitCode = 1;
      return;
    }
    limit = rawLimit;
  }
  const hideSubagents = !flags['all-subagents'];

  const { store } = openStore(flags);
  const raw = store.listSessions({
    q: query,
    query,
    hideSubagents,
    limit,
  });
  const { sessions, total } = normalizeListedSessions(raw);

  if (flags.json) {
    console.log(JSON.stringify({ ok: true, query, total, count: sessions.length, sessions }, null, 2));
    return;
  }

  console.log(
    `Context Relay search${query ? ` ("${query}")` : ''}: showing ${sessions.length} of ${total} session(s)\n`,
  );
  if (sessions.length === 0) {
    console.log('No matching sessions found.');
    return;
  }

  printTable(
    ['Session ID', 'Title', 'Model', 'Turns', 'Peak Tok', 'Updated'],
    sessions.map((s) => [
      String(s.sessionId || s.id || '').slice(0, 12),
      truncateInline(s.title || '(untitled)', 44),
      truncateInline(s.lastModel || s.model || '-', 22),
      String(s.turnCount ?? s.turnsCount ?? (Array.isArray(s.turns) ? s.turns.length : '-')),
      formatCompact(s.peakContextTokens || 0),
      String(s.updatedAt || '').slice(0, 16).replace('T', ' '),
    ]),
  );
}

function cmdInspect(pos, flags) {
  const sessionId = (pos[1] || '').trim();
  if (!sessionId) {
    console.error('Usage: context-relay inspect <sessionId> [--json]');
    process.exitCode = 1;
    return;
  }

  const { store } = openStore(flags);
  const session = loadSession(store, sessionId);
  if (!session) {
    console.error(`Session not found: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  const turns = Array.isArray(session.turns) ? session.turns : [];
  const defaultSelection = applySurgeryPreset(session, 'smart-clean');
  const selectedItemSet = new Set(defaultSelection.selectedItemIds || []);

  let totalItems = 0;
  let noisyItems = 0;
  let totalItemBytes = 0;
  let noisyItemBytes = 0;

  const turnSummaries = turns.map((turn) => {
    const items = Array.isArray(turn.items) ? turn.items : [];
    let turnNoisy = 0;
    let turnBytes = 0;
    let turnNoisyBytes = 0;
    let keptItems = 0;
    for (const item of items) {
      totalItems += 1;
      const bytes = Number(item.resultBytes) || 0;
      totalItemBytes += bytes;
      turnBytes += bytes;
      if (item.isNoisy) {
        noisyItems += 1;
        noisyItemBytes += bytes;
        turnNoisy += 1;
        turnNoisyBytes += bytes;
      }
      if (selectedItemSet.has(item.id)) keptItems += 1;
    }
    return {
      id: turn.id,
      index: turn.index,
      itemCount: items.length,
      keptItems,
      noisyItems: turnNoisy,
      itemBytes: turnBytes,
      noisyBytes: turnNoisyBytes,
      filesModified: Array.isArray(turn.filesModified) ? turn.filesModified.length : 0,
      userPreview: truncateInline(turn.userText || '', 52),
    };
  });

  const noiseItemRatio = totalItems > 0 ? noisyItems / totalItems : 0;
  const noiseByteRatio = totalItemBytes > 0 ? noisyItemBytes / totalItemBytes : 0;
  const noiseStats = {
    totalTurns: turns.length,
    totalItems,
    noisyItems,
    noiseItemRatio: Number(noiseItemRatio.toFixed(4)),
    totalItemBytes,
    noisyItemBytes,
    noiseByteRatio: Number(noiseByteRatio.toFixed(4)),
  };

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionId: session.sessionId || session.id || sessionId,
          title: session.title || '',
          model: session.lastModel || session.model || '',
          workspacePath: session.workspacePath || '',
          peakContextTokens: session.peakContextTokens || 0,
          noiseStats,
          defaultSelection,
          turns: turnSummaries,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`=== Session Inspect: ${session.sessionId || session.id || sessionId} ===`);
  console.log(`Title:     ${session.title || '(untitled)'}`);
  console.log(`Model:     ${session.lastModel || session.model || '-'}`);
  console.log(`Workspace: ${session.workspacePath || '-'}`);
  console.log(
    `Metrics:   ${turns.length} turn(s) | peak ${formatCompact(session.peakContextTokens || 0)} tok | ` +
      `noise ${(noiseByteRatio * 100).toFixed(1)}% by bytes (${noisyItems}/${totalItems} tool items)\n`,
  );

  if (turnSummaries.length === 0) {
    console.log('No turns found in session.');
    return;
  }

  printTable(
    ['#', 'Turn ID', 'Tools (Keep/All)', 'Noisy', 'Mod Files', 'Bytes', 'User Prompt'],
    turnSummaries.map((t) => [
      String(t.index),
      t.id,
      `${t.keptItems}/${t.itemCount}`,
      String(t.noisyItems),
      String(t.filesModified),
      formatBytes(t.itemBytes),
      t.userPreview,
    ]),
  );
}

function cmdExport(pos, flags) {
  const sessionId = (pos[1] || '').trim();
  if (!sessionId) {
    console.error(
      'Usage: context-relay export <sessionId> [--preset smart-clean|backbone|all] [--out <file>] [--no-redact] [--no-git]',
    );
    process.exitCode = 1;
    return;
  }

  const preset = resolveOptionString(flags, 'preset') || 'smart-clean';
  if (!['smart-clean', 'backbone', 'all'].includes(preset)) {
    console.error(`Invalid --preset: ${preset} (expected smart-clean, backbone, or all)`);
    process.exitCode = 1;
    return;
  }

  const { store } = openStore(flags);
  const session = loadSession(store, sessionId);
  if (!session) {
    console.error(`Session not found: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  const selection = applySurgeryPreset(session, preset);
  const includeGit = !flags['no-git'];
  const redact = !flags['no-redact'];
  const gitAnchor =
    includeGit && session.workspacePath ? collectGitAnchor(session.workspacePath) : null;

  const fullStepLoader = (stepIdx) => {
    try {
      const loaded = store.getFullStepContent?.(sessionId, stepIdx);
      return typeof loaded?.content === 'string' ? loaded.content : '';
    } catch {
      return '';
    }
  };

  const bundle = buildHandoffBundle(session, {
    preset,
    selectedTurnIds: selection.selectedTurnIds,
    selectedItemIds: selection.selectedItemIds,
    redact,
    includeGitAnchor: includeGit,
    gitAnchor,
    fullStepLoader,
  });

  const outFile = resolveOptionString(flags, 'out');
  if (outFile) {
    const outPath = resolve(outFile);
    atomicWriteFile(outPath, bundle.markdown);
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            outPath,
            preset,
            bytes: bundle.bytes,
            estimatedTokens: bundle.estimatedTokens,
            savedPercent: bundle.savedPercent,
            redactionCount: bundle.redactionCount,
            recommendFileMode: bundle.recommendFileMode,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Exported handoff bundle to ${outPath}`);
      console.log(
        `Preset: ${preset} | Size: ${formatBytes(bundle.bytes)} (~${formatCompact(bundle.estimatedTokens)} tok) | ` +
          `Saved: ${bundle.savedPercent ?? 0}% | Redactions: ${bundle.redactionCount ?? 0}`,
      );
    }
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify({ ok: true, preset, bundle }, null, 2));
    return;
  }

  process.stdout.write(bundle.markdown.endsWith('\n') ? bundle.markdown : `${bundle.markdown}\n`);
}

function collectReleaseCopyPlan(sourceRoot, targetRoot) {
  const plan = [];
  let totalBytes = 0;

  const addFile = (srcPath) => {
    if (!existsSync(srcPath) || !isNotSymlink(srcPath)) return;
    if (!isPathInsideRoot(srcPath, sourceRoot)) return;
    const st = statSync(srcPath);
    if (!st.isFile()) return;
    const relPath = relative(sourceRoot, srcPath);
    const destPath = join(targetRoot, relPath);
    plan.push({
      src: srcPath,
      dest: destPath,
      relPath: relPath.replace(/\\/g, '/'),
      size: st.size,
    });
    totalBytes += st.size;
  };

  const walkDir = (dirPath) => {
    if (!existsSync(dirPath) || !isNotSymlink(dirPath)) return;
    if (!isPathInsideRoot(dirPath, sourceRoot)) return;
    const entries = safeReaddirWithTypes(dirPath);
    for (const entry of entries) {
      if (SKIP_ENTRY_NAMES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dirPath, entry.name);
      if (!isNotSymlink(fullPath)) continue;
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        addFile(fullPath);
      }
    }
  };

  for (const relFile of RELEASE_FILES) {
    addFile(join(sourceRoot, relFile));
  }
  for (const relDir of RELEASE_DIRS) {
    walkDir(join(sourceRoot, relDir));
  }

  plan.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { plan, totalBytes };
}

function assertSafeTargetPath(destPath, targetRoot) {
  if (!isPathInsideRoot(destPath, targetRoot)) {
    throw new Error(`Refusing to write outside target directory: ${destPath}`);
  }
  const rel = relative(targetRoot, destPath);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let cur = targetRoot;
  if (existsSync(cur) && !isNotSymlink(cur)) {
    throw new Error(`Refusing to traverse symbolic link directory: ${cur}`);
  }
  for (const part of parts) {
    cur = join(cur, part);
    if (existsSync(cur) && !isNotSymlink(cur)) {
      throw new Error(`Refusing to traverse or overwrite symbolic link: ${cur}`);
    }
  }
}

function isVerifiedContextRelayDir(dirPath) {
  const pluginJsonPath = join(dirPath, 'plugin.json');
  if (!existsSync(pluginJsonPath) || !isNotSymlink(pluginJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return parsed?.name === 'context-relay';
  } catch {
    return false;
  }
}

function cmdInstall(pos, flags) {
  const platform = (pos[1] || '').trim().toLowerCase();
  if (platform !== 'antigravity') {
    console.error(
      'Usage: context-relay install antigravity [--target <dir>] [--data-dir <dir>] [--dry-run] [--force]',
    );
    process.exitCode = 1;
    return;
  }

  const sourceRoot = getPluginRoot();
  const targetDir = resolve(resolveOptionString(flags, 'target') || resolveDefaultInstallTarget());
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);
  const customDataDirRaw = resolveOptionString(flags, 'data-dir');
  const customDataDir = customDataDirRaw ? resolve(customDataDirRaw) : '';

  if (
    canonicalFileKey(sourceRoot) === canonicalFileKey(targetDir) ||
    isPathInsideRoot(targetDir, sourceRoot) ||
    isPathInsideRoot(sourceRoot, targetDir)
  ) {
    console.error(
      `Refusing to install into source directory, its subdirectory, or an ancestor directory: ${targetDir}`,
    );
    process.exitCode = 1;
    return;
  }

  if (existsSync(targetDir)) {
    if (!isNotSymlink(targetDir)) {
      console.error(`Refusing to install into symlinked target directory: ${targetDir}`);
      process.exitCode = 1;
      return;
    }
    const targetStat = statSync(targetDir);
    if (!targetStat.isDirectory()) {
      console.error(`Refusing to install because target path is not a directory: ${targetDir}`);
      process.exitCode = 1;
      return;
    }
    const existingEntries = safeReaddirWithTypes(targetDir);
    if (existingEntries.length > 0 && !isVerifiedContextRelayDir(targetDir) && !force) {
      console.error(
        `Refusing to overwrite non-empty directory without a "context-relay" plugin.json: ${targetDir}\n` +
          'Choose a dedicated empty target directory or pass --force to override.',
      );
      process.exitCode = 1;
      return;
    }
  }

  const { plan, totalBytes } = collectReleaseCopyPlan(sourceRoot, targetDir);
  const localConfigPath = join(targetDir, '.local-config.json');
  const localConfigObj = customDataDir
    ? { dataDir: customDataDir, installedAt: new Date().toISOString() }
    : { installedAt: new Date().toISOString() };
  const localConfigPayload = `${JSON.stringify(localConfigObj, null, 2)}\n`;

  if (dryRun) {
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            sourceRoot,
            targetDir,
            fileCount: plan.length,
            totalBytes,
            localConfigPath,
            dataDir: customDataDir || null,
            files: plan.map((f) => f.relPath),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`[dry-run] Context Relay -> Antigravity plugin install plan`);
      console.log(`Source:     ${sourceRoot}`);
      console.log(`Target:     ${targetDir}`);
      console.log(`Files:      ${plan.length} file(s) (${formatBytes(totalBytes)}) [copy only, no symlinks]`);
      if (customDataDir) {
        console.log(`Data Dir:   ${customDataDir} (will write ${localConfigPath})`);
      }
      console.log('No files were written (--dry-run).');
    }
    return;
  }

  ensureDir(targetDir);
  if (!isNotSymlink(targetDir)) {
    throw new Error(`Refusing to install into symlinked target directory: ${targetDir}`);
  }
  for (const item of plan) {
    assertSafeTargetPath(item.dest, targetDir);
    const parentDir = dirname(item.dest);
    ensureDir(parentDir);
    if (!isNotSymlink(parentDir) || (existsSync(item.dest) && !isNotSymlink(item.dest))) {
      throw new Error(`Refusing to overwrite symlink target: ${item.dest}`);
    }
    copyFileSync(item.src, item.dest);
  }
  assertSafeTargetPath(localConfigPath, targetDir);
  atomicWriteFile(localConfigPath, localConfigPayload);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: false,
          sourceRoot,
          targetDir,
          fileCount: plan.length,
          totalBytes,
          localConfigPath,
          dataDir: customDataDir || null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Installed Context Relay plugin for Antigravity!`);
    console.log(`Target:     ${targetDir}`);
    console.log(`Copied:     ${plan.length} file(s) (${formatBytes(totalBytes)})`);
    if (customDataDir) {
      console.log(`Config:     ${localConfigPath} -> dataDir="${customDataDir}"`);
    } else {
      console.log(`Config:     ${localConfigPath}`);
    }
    console.log('Next step:  Open Antigravity Plugins Manager and enable/reload "Context Relay".');
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function truncateVisual(text, maxUnits = 34) {
  const single = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!single) return '';
  let units = 0;
  let out = '';
  for (const ch of single) {
    const cp = ch.codePointAt(0) || 0;
    const w = cp > 0x2e7f ? 1.85 : 1;
    if (units + w > maxUnits) {
      return `${out.trimEnd()}…`;
    }
    out += ch;
    units += w;
  }
  return out;
}

function buildDemoStatsRecords() {
  return [
    {
      id: 'demo-fork-1',
      createdAt: '2026-11-24T15:30:00.000Z',
      sourceTitle: 'Auth middleware & token rotation audit',
      targetTitle: 'Auth middleware & token rotation audit (fork)',
      targetSessionId: 'demo-conv-001',
      targetWorkspace: 'workspace/api-service',
      originalPeakTokens: 281000,
      handoffEstimatedTokens: 7900,
      redactionCount: 3,
    },
    {
      id: 'demo-fork-2',
      createdAt: '2026-11-24T12:10:00.000Z',
      sourceTitle: 'SQLite FTS5 indexing & incremental sync',
      targetTitle: 'SQLite FTS5 indexing & incremental sync (fork #2)',
      targetSessionId: 'demo-conv-002',
      targetWorkspace: 'workspace/search-core',
      originalPeakTokens: 194500,
      handoffEstimatedTokens: 6800,
      redactionCount: 2,
    },
    {
      id: 'demo-fork-3',
      createdAt: '2026-11-23T19:45:00.000Z',
      sourceTitle: 'Cross-repo contract verification pipeline',
      targetTitle: 'Cross-repo contract verification pipeline (fork)',
      targetSessionId: 'demo-conv-003',
      targetWorkspace: 'workspace/cli-toolkit',
      originalPeakTokens: 148200,
      handoffEstimatedTokens: 5400,
      redactionCount: 1,
    },
  ];
}

/**
 * Render a self-contained, dark/GitHub-friendly, XML-safe 760x260 SVG savings card.
 */
export function renderStatsSvg(stats) {
  const relayCount = Math.max(0, Number(stats?.relayCount) || 0);
  const archiveCount = Math.max(0, Number(stats?.archiveCount) || 0);
  const totalOrig = Math.max(0, Number(stats?.totalOriginalTokens) || 0);
  const totalAfter = Math.max(0, Number(stats?.totalHandoffTokens) || 0);
  const totalSaved = Math.max(0, Number(stats?.totalSavedTokens) || 0);
  const avgPct = Math.max(0, Math.min(99, Number(stats?.avgSavedPercent) || 0));
  const totalRedactions = Math.max(0, Number(stats?.totalRedactions) || 0);
  const isDemo = Boolean(stats?.demo);
  const recentItems = Array.isArray(stats?.recent) ? stats.recent.slice(0, 3) : [];

  const barMaxWidth = 286;
  const beforeBarW = totalOrig > 0 ? barMaxWidth : 0;
  const afterBarW =
    totalOrig > 0 && totalAfter > 0
      ? Math.max(8, Math.min(barMaxWidth, Math.round((totalAfter / totalOrig) * barMaxWidth)))
      : 0;

  const badgeText = relayCount > 0 ? `AVG -${avgPct}% TOKENS` : 'READY TO FORK';
  const savedBigText = formatCompact(totalSaved);
  const origText = `${formatCompact(totalOrig)} tok`;
  const afterText = `${formatCompact(totalAfter)} tok`;
  const subMetaText =
    totalRedactions > 0
      ? `${totalRedactions} secrets scrubbed · ${archiveCount} archives`
      : `${archiveCount} handoff archive${archiveCount === 1 ? '' : 's'}`;

  const demoPill = isDemo
    ? `
  <rect x="520" y="18" width="56" height="24" rx="12" fill="#1f2937" stroke="#374151" stroke-width="1"/>
  <text x="548" y="34" text-anchor="middle" font-size="10.5" font-weight="700" fill="#9ca3af" letter-spacing="0.6">DEMO</text>`
    : '';

  let recentRowsSvg = '';
  if (recentItems.length === 0) {
    recentRowsSvg = `
    <rect x="370" y="114" width="350" height="96" rx="8" fill="#0d1117" stroke="#21262d" stroke-width="1" stroke-dasharray="4 4"/>
    <text x="545" y="156" text-anchor="middle" font-size="12.5" font-weight="600" fill="#8b949e">No clean forks recorded yet</text>
    <text x="545" y="177" text-anchor="middle" font-size="11" fill="#6e7681">Run /fork or context-relay fork to start saving tokens</text>`;
  } else {
    recentRowsSvg = recentItems
      .map((item, idx) => {
        const rowY = 100 + idx * 45;
        const rawTitle = String(item.targetTitle || item.sourceTitle || 'Untitled (fork)');
        const scrubbed = redactSensitive(rawTitle, { enabled: true }).text;
        const safeTitle = escapeXml(truncateVisual(scrubbed, 30));
        const origItem = Math.max(0, Number(item.originalPeakTokens) || 0);
        const afterItem = Math.max(0, Number(item.handoffEstimatedTokens) || 0);
        const pctItem = Math.max(0, Math.min(99, Number(item.savedPercent) || 0));
        const metricLine = escapeXml(`${formatCompact(origItem)} → ${formatCompact(afterItem)} tok`);
        const pctLabel = escapeXml(`-${pctItem}%`);

        return `
    <g>
      <rect x="370" y="${rowY}" width="350" height="39" rx="7" fill="#0d1117" stroke="#21262d" stroke-width="1"/>
      <text x="382" y="${rowY + 16}" font-size="11.5" font-weight="600" fill="#e6edf3">${safeTitle}</text>
      <text x="382" y="${rowY + 31}" font-size="10" fill="#8b949e" class="mono">${metricLine}</text>
      <rect x="660" y="${rowY + 9}" width="50" height="21" rx="10.5" fill="#0d2f23" stroke="#238636" stroke-width="1"/>
      <text x="685" y="${rowY + 23}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#3fb950" class="mono">${pctLabel}</text>
    </g>`;
      })
      .join('');
  }

  const ariaLabel = escapeXml(
    `Context Relay Token Savings: ${savedBigText} tokens saved across ${relayCount} forks (${avgPct}% average reduction)`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="260" viewBox="0 0 760 260" role="img" aria-label="${ariaLabel}">
  <defs>
    <linearGradient id="cr-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <radialGradient id="cr-glow" cx="88%" cy="10%" r="55%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cr-logo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>
    <linearGradient id="cr-bar-before" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#f97316"/>
      <stop offset="100%" stop-color="#ef4444"/>
    </linearGradient>
    <linearGradient id="cr-bar-after" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
  </style>

  <!-- Card frame -->
  <rect x="0.5" y="0.5" width="759" height="259" rx="14" fill="url(#cr-bg)" stroke="#263042" stroke-width="1"/>
  <rect x="1" y="1" width="758" height="258" rx="13.5" fill="url(#cr-glow)"/>

  <!-- Header -->
  <g transform="translate(24, 18)">
    <rect x="0" y="0" width="24" height="24" rx="6" fill="#161b22" stroke="#263042" stroke-width="1"/>
    <circle cx="7" cy="7" r="2.2" fill="none" stroke="url(#cr-logo)" stroke-width="1.8"/>
    <circle cx="7" cy="17" r="2.2" fill="none" stroke="url(#cr-logo)" stroke-width="1.8"/>
    <path d="M9.2 8.2 L17.8 16.8" stroke="url(#cr-logo)" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M9.2 15.8 L13.2 11.8 M15 6.8 L18.2 6.8 L18.2 10" fill="none" stroke="url(#cr-logo)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="58" y="35" font-size="15.5" font-weight="700" fill="#f0f6fc">Context Relay</text>
  <text x="172" y="35" font-size="11.5" fill="#8b949e">Token Savings Card</text>${demoPill}
  <rect x="584" y="18" width="152" height="24" rx="12" fill="#0d2f23" stroke="#2ea043" stroke-width="1"/>
  <text x="660" y="34" text-anchor="middle" font-size="11" font-weight="700" fill="#3fb950" class="mono">${escapeXml(badgeText)}</text>

  <line x1="24" y1="54" x2="736" y2="54" stroke="#21262d" stroke-width="1"/>

  <!-- Left column: Hero KPIs -->
  <text x="24" y="76" font-size="10" font-weight="600" fill="#8b949e" letter-spacing="0.8">TOKENS SAVED</text>
  <text x="24" y="112" font-size="34" font-weight="800" fill="#3fb950" class="mono">${escapeXml(savedBigText)}</text>
  <text x="24" y="131" font-size="10.5" fill="#8b949e">${escapeXml(subMetaText)}</text>

  <text x="220" y="76" font-size="10" font-weight="600" fill="#8b949e" letter-spacing="0.8">CLEAN FORKS</text>
  <text x="220" y="112" font-size="34" font-weight="800" fill="#f0f6fc" class="mono">${escapeXml(String(relayCount))}</text>
  <text x="220" y="131" font-size="10.5" fill="#8b949e">${escapeXml(relayCount > 0 ? `${avgPct}% avg lighter` : '0% baseline')}</text>

  <!-- Left column: Dual-bar comparison -->
  <rect x="24" y="146" width="314" height="94" rx="10" fill="#161b22" stroke="#263042" stroke-width="1"/>
  <text x="38" y="165" font-size="9.5" font-weight="600" fill="#8b949e" letter-spacing="0.7">CONTEXT FOOTPRINT (BEFORE VS AFTER)</text>

  <text x="38" y="185" font-size="11" fill="#c9d1d9">Original Peak</text>
  <text x="324" y="185" text-anchor="end" font-size="11" font-weight="600" fill="#f85149" class="mono">${escapeXml(origText)}</text>
  <rect x="38" y="191" width="${barMaxWidth}" height="8" rx="4" fill="#21262d"/>
  <rect x="38" y="191" width="${beforeBarW}" height="8" rx="4" fill="url(#cr-bar-before)"/>

  <text x="38" y="217" font-size="11" fill="#c9d1d9">After Clean Fork</text>
  <text x="324" y="217" text-anchor="end" font-size="11" font-weight="600" fill="#3fb950" class="mono">${escapeXml(afterText)}</text>
  <rect x="38" y="223" width="${barMaxWidth}" height="8" rx="4" fill="#21262d"/>
  <rect x="38" y="223" width="${afterBarW}" height="8" rx="4" fill="url(#cr-bar-after)"/>

  <!-- Right column: Recent 3 clean forks -->
  <rect x="354" y="68" width="382" height="172" rx="10" fill="#161b22" stroke="#263042" stroke-width="1"/>
  <text x="370" y="88" font-size="10" font-weight="600" fill="#8b949e" letter-spacing="0.8">RECENT CLEAN FORKS (REDACTED)</text>${recentRowsSvg}
</svg>
`;
}

function cmdStats(flags) {
  const isDemo = Boolean(flags.demo);
  const dataDir = resolveOptionString(flags, 'data-dir') || undefined;
  const store = isDemo ? null : createRelayStore({ dataDir });
  const lineage = isDemo ? buildDemoStatsRecords() : store.listLineage();
  const archives = isDemo ? lineage : store.listArchives();

  let totalOriginalTokens = 0;
  let totalHandoffTokens = 0;
  let totalSavedTokens = 0;
  let totalRedactions = 0;

  const recent = lineage.slice(0, 10).map((r) => {
    const orig = Math.max(0, Number(r.originalPeakTokens) || 0);
    const after = Math.max(0, Number(r.handoffEstimatedTokens ?? r.estimatedTokens) || 0);
    const saved = Math.max(0, orig - after);
    const pct = orig > 0 ? Math.max(0, Math.min(99, Math.round((saved / orig) * 100))) : 0;
    return {
      id: r.id || '',
      createdAt: r.createdAt || '',
      sourceTitle: r.sourceTitle || '',
      targetTitle: r.targetTitle || '',
      targetSessionId: r.targetSessionId || '',
      targetWorkspace: r.targetWorkspace || '',
      originalPeakTokens: orig,
      handoffEstimatedTokens: after,
      savedTokens: saved,
      savedPercent: pct,
    };
  });

  for (const r of lineage) {
    const orig = Math.max(0, Number(r.originalPeakTokens) || 0);
    const after = Math.max(0, Number(r.handoffEstimatedTokens ?? r.estimatedTokens) || 0);
    const saved = Math.max(0, orig - after);
    totalOriginalTokens += orig;
    totalHandoffTokens += after;
    totalSavedTokens += saved;
    totalRedactions += Math.max(0, Number(r.redactionCount) || 0);
  }

  const avgSavedPercent =
    totalOriginalTokens > 0
      ? Math.max(0, Math.min(99, Math.round((totalSavedTokens / totalOriginalTokens) * 100)))
      : 0;

  const payload = {
    ok: true,
    demo: isDemo,
    dataDir: isDemo ? null : store.getDataDir(),
    relayCount: lineage.length,
    archiveCount: archives.length,
    totalOriginalTokens,
    totalHandoffTokens,
    totalSavedTokens,
    avgSavedPercent,
    totalRedactions,
    recent,
  };

  const svgOutRaw = resolveOptionString(flags, 'svg');
  if (svgOutRaw) {
    const svgPath = resolve(svgOutRaw);
    ensureDir(dirname(svgPath));
    const svgMarkup = renderStatsSvg(payload);
    atomicWriteFile(svgPath, svgMarkup);
    payload.svgPath = svgPath;
  }

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`=== Context Relay Token Savings${isDemo ? ' (Demo)' : ''} ===`);
  console.log(`Relays:        ${payload.relayCount} (archives: ${payload.archiveCount})`);
  console.log(`Saved tokens:  ${payload.totalSavedTokens.toLocaleString()} (${payload.avgSavedPercent}% avg reduction)`);
  console.log(`Before/After:  ${payload.totalOriginalTokens.toLocaleString()} -> ${payload.totalHandoffTokens.toLocaleString()}`);
  if (payload.svgPath) {
    console.log(`SVG card:      ${payload.svgPath}`);
  }
  if (recent.length > 0) {
    console.log('');
    for (const item of recent.slice(0, 5)) {
      console.log(`- [${item.savedPercent}% saved] ${item.originalPeakTokens} -> ${item.handoffEstimatedTokens} | ${item.targetTitle || item.sourceTitle}`);
    }
  }
}

function cmdUninstall(pos, flags) {
  const platform = (pos[1] || '').trim().toLowerCase();
  if (platform !== 'antigravity') {
    console.error('Usage: context-relay uninstall antigravity [--target <dir>] [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const targetDir = resolve(resolveOptionString(flags, 'target') || resolveDefaultInstallTarget());
  const dryRun = Boolean(flags['dry-run']);
  const exists = existsSync(targetDir);
  let verifiedPlugin = false;
  let detectedPluginName = '';
  let configuredDataDir = '';

  if (exists) {
    const pluginJsonPath = join(targetDir, 'plugin.json');
    if (existsSync(pluginJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
        detectedPluginName = typeof parsed?.name === 'string' ? parsed.name : '';
        verifiedPlugin = detectedPluginName === 'context-relay';
      } catch {
        verifiedPlugin = false;
      }
    }
    const localCfgPath = join(targetDir, '.local-config.json');
    if (existsSync(localCfgPath)) {
      try {
        const cfg = JSON.parse(readFileSync(localCfgPath, 'utf-8'));
        if (typeof cfg?.dataDir === 'string') configuredDataDir = cfg.dataDir;
      } catch {
        // ignore invalid local config
      }
    }
  }

  const summary = {
    ok: true,
    dryRun,
    deleted: false,
    targetDir,
    exists,
    verifiedPlugin,
    detectedPluginName: detectedPluginName || null,
    configuredDataDir: configuredDataDir || null,
    note: 'Safe mode: no files were automatically deleted to avoid destroying user custom files or archives.',
  };

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('=== Context Relay Safe Uninstall Guide (Antigravity) ===');
  console.log(`Target directory: ${targetDir}`);
  if (!exists) {
    console.log('Status:           Not found (Context Relay is not installed at this path).');
    return;
  }
  if (verifiedPlugin) {
    console.log('Status:           Verified Context Relay installation (plugin.json name === "context-relay").');
  } else {
    console.log(
      `Status:           WARNING — directory does not contain plugin.json with "name": "context-relay" (found: ${detectedPluginName || 'none'}).`,
    );
  }
  console.log('');
  console.log('To uninstall safely without silently removing user files:');
  console.log('  1. Disable "Context Relay" in Antigravity Plugins Manager.');
  console.log(`  2. Move the plugin folder to your OS Recycle Bin / Trash:`);
  console.log(`     ${targetDir}`);
  if (configuredDataDir) {
    console.log(`  3. Optional: your handoff archives & lineage cache live separately at:`);
    console.log(`     ${configuredDataDir}`);
    console.log('     Keep it if you want to retain past handoff bundles, or recycle it manually.');
  } else {
    console.log(`  3. Optional: default local cache/archives live at ${join(homedir(), '.context-relay')}.`);
  }
  console.log('');
  console.log('No files were modified or deleted by this command.');
}

async function main() {
  const { pos, flags, errors } = parseArgs(process.argv.slice(2));
  const cmd = (pos[0] || '').trim().toLowerCase();

  if (flags.version || cmd === 'version') {
    console.log(readPackageVersion());
    return;
  }
  if (flags.help || !cmd || cmd === 'help') {
    printHelp();
    return;
  }
  if (errors.length > 0) {
    for (const msg of errors) {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  switch (cmd) {
    case 'fork':
      await cmdRelay(flags, { defaultGo: true });
      break;
    case 'relay':
      await cmdRelay(flags, { defaultGo: false });
      break;
    case 'stats':
      cmdStats(flags);
      break;
    case 'serve':
      await cmdServe(flags);
      break;
    case 'search':
      cmdSearch(pos, flags);
      break;
    case 'inspect':
      cmdInspect(pos, flags);
      break;
    case 'export':
      cmdExport(pos, flags);
      break;
    case 'install':
      cmdInstall(pos, flags);
      break;
    case 'uninstall':
      cmdUninstall(pos, flags);
      break;
    default:
      console.error(`Unknown command: ${cmd}\nRun "context-relay --help" for usage.`);
      process.exitCode = 1;
      break;
  }
}

const isDirectEntry =
  Boolean(process.argv[1]) &&
  canonicalRealKey(resolve(process.argv[1])) === canonicalRealKey(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  main().catch((err) => {
    console.error(`Error: ${err?.message || err}`);
    process.exitCode = 1;
  });
}

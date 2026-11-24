#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteFile,
  ensureDir,
  getDataDir,
  readJsonFile,
  withLock,
} from '../core/fs-utils.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_TIER1_THRESHOLD = 140_000;
const DEFAULT_TIER2_THRESHOLD = 200_000;
const SIGNIFICANT_NOISE_TOKENS = 30_000;
const SIGNIFICANT_TURN_COUNT = 6;
const MAX_STATE_ENTRIES = 500;

function isSafeKey(value) {
  if (typeof value !== 'string') return false;
  const cleaned = value.trim();
  if (!cleaned) return false;
  if (FORBIDDEN_KEYS.has(cleaned)) return false;
  if (
    cleaned.includes('\0') ||
    cleaned.includes('/') ||
    cleaned.includes('\\') ||
    cleaned.includes('..')
  ) {
    return false;
  }
  return true;
}

function toSafeMap(rawObj) {
  const map = Object.create(null);
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
    return map;
  }
  for (const [k, v] of Object.entries(rawObj)) {
    if (!isSafeKey(k)) continue;
    map[k] = v;
  }
  return map;
}

function parseThreshold(rawEnv, fallback) {
  if (rawEnv === undefined || rawEnv === null || rawEnv === '') return fallback;
  const num = Number(rawEnv);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function isNudgeDisabled() {
  const raw = process.env.CONTEXT_RELAY_NUDGE;
  if (raw === undefined || raw === null) return false;
  const norm = String(raw).trim().toLowerCase();
  return norm === '0' || norm === 'false';
}

function formatK(tokens) {
  const k = Math.max(1, Math.round(tokens / 1000));
  return `${k}k`;
}

function computeTier({ peakContextTokens, noiseTokens, turnCount, tier1, tier2 }) {
  if (peakContextTokens >= tier2) return 2;
  if (peakContextTokens < tier1) return 0;
  const tier1Direct = Math.min(tier2, Math.round((tier1 * 16) / 14));
  if (peakContextTokens >= tier1Direct) return 1;
  if (noiseTokens >= SIGNIFICANT_NOISE_TOKENS || turnCount >= SIGNIFICANT_TURN_COUNT) {
    return 1;
  }
  return 0;
}

function buildUserMarkdown({ tier, peakContextTokens, noiseTokens }) {
  const peakLabel = formatK(peakContextTokens);
  const noisePart =
    noiseTokens >= 10_000 ? `（含工具噪音约 **${formatK(noiseTokens)}**）` : '';

  if (tier >= 2) {
    return `> **Context Relay**：当前上下文已达 **${peakLabel}**${noisePart}（高水位预警）— 敲 \`/fork\` 一键在当前目录去噪 Fork 新对话（不降智、旧对话保留），或敲 \`/compact\` 原地压缩。`;
  }
  return `> **Context Relay**：当前上下文已达 **${peakLabel}**${noisePart} — 需要时敲 \`/fork\` 一键去噪 Fork 新对话，或敲 \`/compact\` 原地压缩。`;
}

function pruneStateMap(stateMap) {
  const entries = Object.entries(stateMap);
  if (entries.length <= MAX_STATE_ENTRIES) return stateMap;

  entries.sort((a, b) => {
    const tsA = Number(a[1]?.ts) || 0;
    const tsB = Number(b[1]?.ts) || 0;
    return tsB - tsA;
  });

  const pruned = Object.create(null);
  for (let i = 0; i < MAX_STATE_ENTRIES; i += 1) {
    const [k, v] = entries[i];
    pruned[k] = v;
  }
  return pruned;
}

function main() {
  let output = '{}\n';
  try {
    if (isNudgeDisabled()) return;

    let raw = '';
    try {
      raw = readFileSync(0, 'utf-8');
    } catch {
      return;
    }

    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return;

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    const rawConvId =
      (typeof payload.conversationId === 'string' && payload.conversationId.trim()) ||
      (typeof payload.conversation_id === 'string' && payload.conversation_id.trim()) ||
      (typeof payload.sessionId === 'string' && payload.sessionId.trim()) ||
      (typeof payload.session_id === 'string' && payload.session_id.trim()) ||
      '';

    if (!isSafeKey(rawConvId)) return;
    const conversationId = rawConvId.trim();

    // 超快路径：仅读取 index.json 中该会话的缓存水位，绝不扫全盘
    const dataDir = getDataDir();
    const indexPath = join(dataDir, 'index.json');
    const index = readJsonFile(indexPath, null);
    const sessions = toSafeMap(index?.sessions);
    const entry = sessions[conversationId];
    if (!entry || typeof entry !== 'object') return;
    if (entry.isSubagent) return;

    const peakContextTokens =
      typeof entry.peakContextTokens === 'number' && Number.isFinite(entry.peakContextTokens)
        ? Math.max(0, entry.peakContextTokens)
        : 0;
    const noiseTokens =
      typeof entry.noiseTokens === 'number' && Number.isFinite(entry.noiseTokens)
        ? Math.max(0, entry.noiseTokens)
        : 0;
    const turnCount =
      typeof entry.turnCount === 'number' && Number.isFinite(entry.turnCount)
        ? Math.max(0, entry.turnCount)
        : 0;

    const tier1 = parseThreshold(process.env.CONTEXT_RELAY_NUDGE_TIER1, DEFAULT_TIER1_THRESHOLD);
    const tier2 = Math.max(
      tier1,
      parseThreshold(process.env.CONTEXT_RELAY_NUDGE_TIER2, DEFAULT_TIER2_THRESHOLD),
    );

    const tier = computeTier({
      peakContextTokens,
      noiseTokens,
      turnCount,
      tier1,
      tier2,
    });
    if (tier <= 0) return;

    const statePath = join(dataDir, 'nudge-state.json');
    const lockPath = join(dataDir, '.nudge-state.lock');
    const prevStateMap = toSafeMap(readJsonFile(statePath, null));
    const prevTier = Number(prevStateMap[conversationId]?.tier) || 0;
    if (tier <= prevTier) return;

    ensureDir(dataDir);
    const shouldEmit = withLock(lockPath, () => {
      const latestMap = toSafeMap(readJsonFile(statePath, null));
      const latestTier = Number(latestMap[conversationId]?.tier) || 0;
      if (tier <= latestTier) return false;

      latestMap[conversationId] = { tier, ts: Date.now() };
      const bounded = pruneStateMap(latestMap);
      atomicWriteFile(statePath, `${JSON.stringify(bounded, null, 2)}\n`);
      return true;
    });

    if (!shouldEmit) return;

    const userMarkdown = buildUserMarkdown({
      tier,
      peakContextTokens,
      noiseTokens,
    });

    output = `${JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: '',
            metadata: {
              user_markdown: userMarkdown,
            },
          },
        },
      ],
    })}\n`;
  } catch {
    output = '{}\n';
  } finally {
    process.stdout.write(output);
    process.exitCode = 0;
  }
}

main();

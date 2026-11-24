import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fsUtils from './fs-utils.mjs';
import {
  getDataDir,
  ensureDir,
  canonicalFileKey,
  atomicWriteFile,
  readJsonFile,
  withLock,
  fileUriToPath,
  slugify,
  truncateText,
  isNotSymlink,
  safeStat,
  safeReaddir,
} from './fs-utils.mjs';
import { readJsonlSteps, readFullStepByIndex } from './jsonl-reader.mjs';
import { parseSessionTranscript, estimateTokens } from './turn-parser.mjs';
import {
  discoverAllSources,
  findSessionSource,
  detectAdapterForPath,
  readSessionAnnotation,
} from '../adapters/index.mjs';
import { createAgentApiClient } from './agentapi.mjs';

const MAX_SEARCH_TEXT_LEN = 24_576;
const MAX_SEARCH_HEADER_LEN = 6_144;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_MS = 10 * 60 * 1000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\s*\.|\s*$)/i;

function nowIso() {
  return new Date().toISOString();
}

function safeStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSafeKey(value) {
  const cleaned = safeStr(value);
  if (!cleaned) return false;
  if (FORBIDDEN_KEYS.has(cleaned)) return false;
  if (cleaned.includes('\0')) return false;
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

function yieldEventLoop() {
  return new Promise((resolveImmediate) => setImmediate(resolveImmediate));
}

function toUniqueStrings(list, maxItems = Infinity) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const cleaned = safeStr(item);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizePathForMatch(value) {
  return safeStr(value).replace(/\\/g, '/').toLowerCase();
}

function decodeMaybeUri(value) {
  const cleaned = safeStr(value);
  if (!cleaned) return '';
  if (/^file:\/\//i.test(cleaned)) {
    try {
      const decoded = fileUriToPath(cleaned);
      return typeof decoded === 'string' ? decoded.trim() : '';
    } catch {
      return '';
    }
  }
  return cleaned;
}

function displayNameFromPath(fsPath, fallback = '') {
  const cleaned = safeStr(fsPath).replace(/[\\/]+$/, '');
  if (!cleaned) return fallback;
  if (/^[a-zA-Z]:$/.test(cleaned)) return cleaned;
  const base = basename(cleaned);
  return base || fallback;
}

function parseTimeMs(isoOrMs, fallbackMs = 0) {
  if (typeof isoOrMs === 'number' && Number.isFinite(isoOrMs)) return isoOrMs;
  if (typeof isoOrMs === 'string' && isoOrMs.trim()) {
    const parsed = Date.parse(isoOrMs);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.isFinite(fallbackMs) ? fallbackMs : 0;
}

function clampText(text, maxLen) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw || maxLen <= 0) return '';
  if (raw.length <= maxLen) return raw;
  try {
    const truncated = truncateText(raw, maxLen);
    if (typeof truncated === 'string') {
      return truncated.length <= maxLen ? truncated : truncated.slice(0, maxLen);
    }
  } catch {
    // fallback below
  }
  return raw.slice(0, maxLen);
}

function collapseWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function allocateFairSlices(texts, totalBudget) {
  const out = new Array(texts.length).fill('');
  if (totalBudget <= 0 || texts.length === 0) return out;

  const nonEmpty = [];
  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i]) nonEmpty.push({ index: i, text: texts[i] });
  }
  if (nonEmpty.length === 0) return out;

  // 按长度升序分配，短文本拿满自身长度，盈余预算自动让渡给较长轮次
  nonEmpty.sort((a, b) => a.text.length - b.text.length);
  let remainingBudget = totalBudget;
  let remainingItems = nonEmpty.length;

  for (const item of nonEmpty) {
    if (remainingBudget <= 0) break;
    const share = Math.max(1, Math.floor(remainingBudget / remainingItems));
    const slice = item.text.length <= share ? item.text : clampText(item.text, share);
    out[item.index] = slice;
    remainingBudget -= slice.length + 1;
    remainingItems -= 1;
  }

  return out;
}

function buildSearchText({ title, workspacePath, filesModified, filesRead, turns }) {
  const headerParts = [];
  const cleanTitle = safeStr(title);
  if (cleanTitle) headerParts.push(cleanTitle);

  const cleanWs = safeStr(workspacePath);
  if (cleanWs) headerParts.push(cleanWs);

  const allTouchedFiles = toUniqueStrings([
    ...(Array.isArray(filesModified) ? filesModified : []),
    ...(Array.isArray(filesRead) ? filesRead : []),
  ]);
  if (allTouchedFiles.length > 0) {
    headerParts.push(allTouchedFiles.join(' '));
  }

  const headerText = clampText(
    collapseWhitespace(headerParts.join('\n')),
    MAX_SEARCH_HEADER_LEN,
  );

  const parts = [];
  if (headerText) parts.push(headerText);

  const remainingBudget = MAX_SEARCH_TEXT_LEN - headerText.length - (headerText ? 1 : 0);

  if (Array.isArray(turns) && turns.length > 0 && remainingBudget > 0) {
    const userTexts = turns.map((turn) =>
      turn && typeof turn === 'object'
        ? collapseWhitespace(turn.userText || turn.userPreview || '')
        : '',
    );
    const assistantTexts = turns.map((turn) =>
      turn && typeof turn === 'object'
        ? collapseWhitespace(turn.assistantText || turn.assistantPreview || '')
        : '',
    );

    // 优先保证每一轮的 userText 都能进入索引（按 65% 预算均摊，短轮次盈余自动释放给回复）
    const userTargetBudget = Math.floor(remainingBudget * 0.65);
    const userSlices = allocateFairSlices(userTexts, userTargetBudget);
    let usedUserChars = 0;
    for (const s of userSlices) {
      if (s) usedUserChars += s.length + 1;
    }

    // 剩余全部预算均摊覆盖关键回复与各轮助手总结
    const assistantBudget = Math.max(0, remainingBudget - usedUserChars);
    const assistantSlices = allocateFairSlices(assistantTexts, assistantBudget);

    for (let i = 0; i < turns.length; i += 1) {
      if (userSlices[i]) parts.push(userSlices[i]);
      if (assistantSlices[i]) parts.push(assistantSlices[i]);
    }
  }

  const combined = collapseWhitespace(parts.join('\n'));
  return clampText(combined, MAX_SEARCH_TEXT_LEN);
}

function extractSteps(readResult) {
  if (Array.isArray(readResult)) return readResult;
  if (readResult && Array.isArray(readResult.steps)) return readResult.steps;
  return [];
}

function extractStepTextContent(step) {
  if (!step || typeof step !== 'object') return '';
  if (typeof step.content === 'string') return step.content;
  if (step.content != null) {
    try {
      return JSON.stringify(step.content, null, 2);
    } catch {
      return String(step.content);
    }
  }
  return '';
}

function resolveSiblingFullFile(filePath) {
  const base = basename(filePath);
  if (base === 'transcript_full.jsonl') {
    return filePath;
  }
  const candidate = join(dirname(filePath), 'transcript_full.jsonl');
  if (!existsSync(candidate) || !isNotSymlink(candidate)) return null;
  const st = safeStat(candidate);
  return st && st.isFile() ? candidate : null;
}

function inferSessionIdFromPath(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  const brainMatch = norm.match(/\/brain\/([^/]+)\//i);
  if (brainMatch && brainMatch[1]) return brainMatch[1];
  const base = basename(filePath);
  const stem = base.replace(/\.jsonl$/i, '');
  if (stem && stem !== 'transcript' && stem !== 'transcript_full') return stem;
  return basename(dirname(filePath)) || 'unknown';
}

function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const filePath = safeStr(raw.filePath || raw.transcriptPath || raw.path);
  const sessionId = safeStr(raw.sessionId || raw.id);
  if (!filePath || !isSafeKey(sessionId)) return null;

  let mtimeMs = Number(raw.mtimeMs);
  let size = Number(raw.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) {
    const st = safeStat(filePath);
    if (!st || !st.isFile()) return null;
    mtimeMs = st.mtimeMs;
    size = st.size;
  }

  let annotationMtimeMs = Number(raw.annotationMtimeMs);
  let annotationSize = Number(raw.annotationSize);
  if (!Number.isFinite(annotationMtimeMs) || !Number.isFinite(annotationSize)) {
    const annMeta = readSessionAnnotation(filePath, sessionId, { statOnly: true });
    annotationMtimeMs = annMeta.mtimeMs || 0;
    annotationSize = annMeta.size || 0;
  }

  return {
    sessionId,
    agent: safeStr(raw.agent) || 'antigravity',
    app: safeStr(raw.app) || 'antigravity',
    filePath,
    fullFilePath: safeStr(raw.fullFilePath) || resolveSiblingFullFile(filePath),
    mtimeMs,
    size,
    annotationMtimeMs,
    annotationSize,
  };
}

function prependTitleToSearchText(existingSearchText, title) {
  const cleanTitle = safeStr(title);
  const existing = typeof existingSearchText === 'string' ? existingSearchText : '';
  if (!cleanTitle) return existing;
  if (existing.toLowerCase().includes(cleanTitle.toLowerCase())) return existing;
  return clampText(collapseWhitespace(`${cleanTitle}\n${existing}`), MAX_SEARCH_TEXT_LEN);
}

function buildIndexEntry(source, parsed, existing = null, annotation = null) {
  const turns = Array.isArray(parsed?.turns) ? parsed.turns : [];

  const filesModified = toUniqueStrings(
    parsed?.filesModified ?? parsed?.filesTouched?.modified ?? [],
  );
  const filesRead = toUniqueStrings(
    parsed?.filesRead ?? parsed?.filesTouched?.read ?? [],
  );

  const modelsFromTurns = [];
  for (const t of turns) {
    if (typeof t?.model === 'string' && t.model.trim()) {
      modelsFromTurns.push(t.model.trim());
    }
  }
  const modelsUsed = toUniqueStrings([
    ...(Array.isArray(parsed?.modelsUsed) ? parsed.modelsUsed : []),
    safeStr(parsed?.firstModel),
    safeStr(parsed?.lastModel),
    ...modelsFromTurns,
  ]);

  const firstModel = safeStr(parsed?.firstModel) || modelsUsed[0] || '';
  const lastModel =
    safeStr(parsed?.lastModel) || modelsUsed[modelsUsed.length - 1] || firstModel;

  const firstUserText = safeStr(turns[0]?.userPreview || turns[0]?.userText);
  const resolvedAnnotation =
    annotation || readSessionAnnotation(source.filePath, source.sessionId);
  const annotationTitle = safeStr(resolvedAnnotation?.title);
  const title =
    annotationTitle ||
    safeStr(parsed?.title) ||
    (firstUserText ? clampText(collapseWhitespace(firstUserText), 120) : '') ||
    source.sessionId;

  const parentSessionId =
    safeStr(parsed?.parentSessionId) || safeStr(parsed?.parentConversationId);
  const isSubagent = Boolean(parsed?.isSubagent || parentSessionId);

  const fallbackIso = new Date(source.mtimeMs || Date.now()).toISOString();
  const createdAt =
    safeStr(parsed?.createdAt) ||
    safeStr(turns[0]?.createdAt) ||
    safeStr(existing?.createdAt) ||
    fallbackIso;
  const updatedAt =
    safeStr(parsed?.updatedAt) ||
    safeStr(turns[turns.length - 1]?.updatedAt) ||
    safeStr(turns[turns.length - 1]?.createdAt) ||
    fallbackIso;

  const peakContextTokens =
    typeof parsed?.peakContextTokens === 'number' && Number.isFinite(parsed.peakContextTokens)
      ? parsed.peakContextTokens
      : 0;

  let totalOutputTokens = 0;
  if (
    typeof parsed?.totalOutputTokens === 'number' &&
    Number.isFinite(parsed.totalOutputTokens)
  ) {
    totalOutputTokens = parsed.totalOutputTokens;
  } else {
    for (const t of turns) {
      totalOutputTokens += estimateTokens(t?.assistantText || t?.assistantPreview || '');
    }
  }

  const turnCount =
    typeof parsed?.turnCount === 'number' && Number.isFinite(parsed.turnCount)
      ? parsed.turnCount
      : turns.length;

  let totalNoiseBytes = 0;
  for (const t of turns) {
    if (typeof t?.noiseBytes === 'number' && Number.isFinite(t.noiseBytes) && t.noiseBytes > 0) {
      totalNoiseBytes += t.noiseBytes;
    }
  }
  const noiseTokens =
    typeof parsed?.noiseTokens === 'number' &&
    Number.isFinite(parsed.noiseTokens) &&
    parsed.noiseTokens >= 0
      ? Math.ceil(parsed.noiseTokens)
      : Math.ceil(totalNoiseBytes / 4);

  const projectId = safeStr(existing?.projectId) || safeStr(parsed?.projectId);
  const workspacePath = safeStr(existing?.workspacePath) || safeStr(parsed?.workspacePath);
  const gitRoot = safeStr(existing?.gitRoot) || safeStr(parsed?.gitRoot);
  const branchName = safeStr(existing?.branchName) || safeStr(parsed?.branchName);
  const metaAttemptedAt = safeStr(existing?.metaAttemptedAt);

  const searchText = buildSearchText({
    title,
    workspacePath,
    filesModified,
    filesRead,
    turns,
  });

  return {
    sessionId: source.sessionId,
    agent: source.agent,
    app: source.app,
    filePath: source.filePath,
    fullFilePath: source.fullFilePath || null,
    mtimeMs: source.mtimeMs,
    size: source.size,
    annotationMtimeMs: resolvedAnnotation?.mtimeMs || source.annotationMtimeMs || 0,
    annotationSize: resolvedAnnotation?.size || source.annotationSize || 0,
    hasAnnotationTitle: Boolean(annotationTitle),
    title,
    firstModel,
    lastModel,
    modelsUsed,
    parentSessionId,
    isSubagent,
    createdAt,
    updatedAt,
    peakContextTokens,
    totalOutputTokens,
    noiseTokens,
    turnCount,
    filesModified,
    filesRead,
    projectId,
    workspacePath,
    gitRoot,
    branchName,
    metaAttemptedAt,
    searchText,
  };
}

function mergeCachedProjectFields(entry, cached) {
  if (!cached || typeof cached !== 'object') return entry;
  const projectId = safeStr(cached.projectId) || safeStr(entry.projectId);
  const workspacePath = safeStr(cached.workspacePath) || safeStr(entry.workspacePath);
  const gitRoot = safeStr(cached.gitRoot) || safeStr(entry.gitRoot);
  const branchName = safeStr(cached.branchName) || safeStr(entry.branchName);
  const metaAttemptedAt = safeStr(cached.metaAttemptedAt) || safeStr(entry.metaAttemptedAt);

  let searchText = entry.searchText || '';
  if (workspacePath && !searchText.toLowerCase().includes(workspacePath.toLowerCase())) {
    searchText = clampText(
      collapseWhitespace(`${workspacePath}\n${searchText}`),
      MAX_SEARCH_TEXT_LEN,
    );
  }

  return {
    ...entry,
    projectId,
    workspacePath,
    gitRoot,
    branchName,
    metaAttemptedAt,
    searchText,
  };
}

function formatArchiveTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function isValidArchiveFilename(filename) {
  if (typeof filename !== 'string') return false;
  if (!filename || filename.length > 200) return false;
  if (/[\x00-\x1f]/.test(filename)) return false;
  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    filename.includes(':')
  ) {
    return false;
  }
  if (/[\s.]$/.test(filename)) return false;
  if (basename(filename) !== filename) return false;
  if (!filename.endsWith('.md')) return false;
  if (WINDOWS_RESERVED_NAME_RE.test(filename)) return false;
  return true;
}

function isPathInsideDir(targetPath, rootDir) {
  const absRoot = resolve(rootDir);
  const absTarget = resolve(targetPath);
  const prefix = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  if (process.platform === 'win32') {
    return absTarget.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return absTarget.startsWith(prefix);
}

/**
 * 创建 Context Relay 持久化索引与档案存储实例。
 */
export function createRelayStore({ dataDir, agentApi } = {}) {
  const resolvedDataDir = getDataDir(dataDir);
  const indexPath = join(resolvedDataDir, 'index.json');
  const projectsPath = join(resolvedDataDir, 'projects.json');
  const lineagePath = join(resolvedDataDir, 'lineage.json');
  const handoffsDir = join(resolvedDataDir, 'handoffs');
  const lockPath = join(resolvedDataDir, '.store.lock');

  const api = agentApi || createAgentApiClient();

  function emptyIndex() {
    return { version: 1, updatedAt: '', sessions: Object.create(null) };
  }

  function emptyProjects() {
    return { version: 1, updatedAt: '', projects: Object.create(null) };
  }

  function emptyLineage() {
    return { version: 1, updatedAt: '', records: [] };
  }

  function loadIndex() {
    const raw = readJsonFile(indexPath, null);
    if (!raw || typeof raw !== 'object') return emptyIndex();
    return {
      version: 1,
      updatedAt: safeStr(raw.updatedAt),
      sessions: toSafeMap(raw.sessions),
    };
  }

  function loadProjects() {
    const raw = readJsonFile(projectsPath, null);
    if (!raw || typeof raw !== 'object') return emptyProjects();
    return {
      version: 1,
      updatedAt: safeStr(raw.updatedAt),
      projects: toSafeMap(raw.projects),
    };
  }

  function loadLineage() {
    const raw = readJsonFile(lineagePath, null);
    if (!raw || typeof raw !== 'object') return emptyLineage();
    const records = Array.isArray(raw.records) ? raw.records : [];
    return {
      version: 1,
      updatedAt: safeStr(raw.updatedAt),
      records,
    };
  }

  function writeJsonAtomic(filePath, payload) {
    ensureDir(dirname(filePath));
    atomicWriteFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  function upsertProjectRecord(
    projectsMap,
    { projectId, workspaceUris = [], primaryPath = '', gitRoot = '', branchName = '', displayName = '' },
    timestamp,
  ) {
    const cleanId = safeStr(projectId);
    if (!isSafeKey(cleanId)) return null;

    const prev = projectsMap[cleanId] && typeof projectsMap[cleanId] === 'object'
      ? projectsMap[cleanId]
      : null;

    const incomingUris = Array.isArray(workspaceUris)
      ? workspaceUris
      : typeof workspaceUris === 'string' && workspaceUris.trim()
        ? [workspaceUris]
        : [];
    const mergedUris = toUniqueStrings([...(prev?.workspaceUris || []), ...incomingUris]);

    const resolvedPrimaryPath =
      decodeMaybeUri(primaryPath) ||
      decodeMaybeUri(incomingUris[0]) ||
      safeStr(prev?.primaryPath) ||
      decodeMaybeUri(mergedUris[0]);

    const resolvedGitRoot = decodeMaybeUri(gitRoot) || safeStr(prev?.gitRoot);
    const resolvedBranchName = safeStr(branchName) || safeStr(prev?.branchName);
    const resolvedDisplayName =
      safeStr(displayName) ||
      displayNameFromPath(resolvedPrimaryPath, '') ||
      safeStr(prev?.displayName) ||
      cleanId;

    const entry = {
      projectId: cleanId,
      displayName: resolvedDisplayName,
      primaryPath: resolvedPrimaryPath,
      workspaceUris: mergedUris,
      gitRoot: resolvedGitRoot,
      branchName: resolvedBranchName,
      firstSeenAt: safeStr(prev?.firstSeenAt) || timestamp,
      lastSeenAt: timestamp,
    };

    projectsMap[cleanId] = entry;
    return entry;
  }

  function syncAll({ force = false } = {}) {
    const startMs = Date.now();
    const rawSources = discoverAllSources();
    const sources = Array.isArray(rawSources) ? rawSources : [];
    const snapshot = loadIndex();

    const seenIds = new Set();
    const parsedEntries = new Map();
    let skipped = 0;

    for (const rawSrc of sources) {
      const source = normalizeSource(rawSrc);
      if (!source) continue;
      if (!isNotSymlink(source.filePath)) continue;

      seenIds.add(source.sessionId);
      const prev = snapshot.sessions[source.sessionId];

      const transcriptSame =
        Boolean(prev) &&
        canonicalFileKey(prev.filePath || '') === canonicalFileKey(source.filePath) &&
        prev.mtimeMs === source.mtimeMs &&
        prev.size === source.size;
      const annotationSame =
        Boolean(prev) &&
        (prev.annotationMtimeMs || 0) === (source.annotationMtimeMs || 0) &&
        (prev.annotationSize || 0) === (source.annotationSize || 0);

      if (!force && transcriptSame && annotationSame) {
        skipped += 1;
        continue;
      }

      const annotation = readSessionAnnotation(source.filePath, source.sessionId);
      const annTitle = safeStr(annotation?.title);
      if (!force && transcriptSame && !annotationSame && (annTitle || !prev.hasAnnotationTitle)) {
        if (annTitle) {
          parsedEntries.set(source.sessionId, {
            ...prev,
            title: annTitle,
            annotationMtimeMs: annotation.mtimeMs,
            annotationSize: annotation.size,
            hasAnnotationTitle: true,
            searchText: prependTitleToSearchText(prev.searchText, annTitle),
          });
        } else {
          parsedEntries.set(source.sessionId, {
            ...prev,
            annotationMtimeMs: annotation.mtimeMs,
            annotationSize: annotation.size,
            hasAnnotationTitle: false,
          });
        }
        continue;
      }

      const readRes = readJsonlSteps(source.filePath);
      if (readRes === null) continue;
      const steps = extractSteps(readRes);
      const parsed = parseSessionTranscript(steps, source);
      const entry = buildIndexEntry(source, parsed, prev, annotation);
      parsedEntries.set(source.sessionId, entry);
    }

    ensureDir(resolvedDataDir);
    return withLock(lockPath, () => {
      const latest = loadIndex();
      const nextSessions = Object.assign(Object.create(null), latest.sessions);
      let updated = 0;
      let removed = 0;

      for (const [id, entry] of parsedEntries.entries()) {
        if (!isSafeKey(id)) continue;
        nextSessions[id] = mergeCachedProjectFields(entry, latest.sessions[id]);
        updated += 1;
      }

      for (const [id, entry] of Object.entries(nextSessions)) {
        if (seenIds.has(id)) continue;
        const fp = safeStr(entry?.filePath);
        const stillExists = fp && isNotSymlink(fp) && Boolean(safeStat(fp)?.isFile());
        if (!stillExists) {
          delete nextSessions[id];
          removed += 1;
        }
      }

      if (updated > 0 || removed > 0 || force || !existsSync(indexPath)) {
        writeJsonAtomic(indexPath, {
          version: 1,
          updatedAt: nowIso(),
          sessions: nextSessions,
        });
      }

      return {
        totalSources: seenIds.size,
        updated,
        skipped,
        removed,
        durationMs: Date.now() - startMs,
      };
    });
  }

  function syncSingle(filePath, sessionId = '') {
    const cleanInputPath = safeStr(filePath);
    const explicitSessionId = safeStr(sessionId);
    if (explicitSessionId && !isSafeKey(explicitSessionId)) {
      return { updated: false, sessionId: '' };
    }
    if (!cleanInputPath) {
      return { updated: false, sessionId: explicitSessionId };
    }

    const absPath = resolve(cleanInputPath);
    if (!isNotSymlink(absPath)) {
      return { updated: false, sessionId: explicitSessionId };
    }
    const st = safeStat(absPath);
    if (!st || !st.isFile()) {
      return { updated: false, sessionId: explicitSessionId };
    }

    const adapter = detectAdapterForPath(absPath);
    const inferred =
      adapter && typeof adapter.inferMeta === 'function' ? adapter.inferMeta(absPath) : null;

    const resolvedSessionId =
      explicitSessionId || safeStr(inferred?.sessionId) || inferSessionIdFromPath(absPath);
    if (!isSafeKey(resolvedSessionId)) {
      return { updated: false, sessionId: '' };
    }

    const annMeta = readSessionAnnotation(absPath, resolvedSessionId, { statOnly: true });
    const source = {
      sessionId: resolvedSessionId,
      agent: safeStr(inferred?.agent) || safeStr(adapter?.id) || 'antigravity',
      app: safeStr(inferred?.app) || 'antigravity',
      filePath: absPath,
      fullFilePath: resolveSiblingFullFile(absPath),
      mtimeMs: st.mtimeMs,
      size: st.size,
      annotationMtimeMs: annMeta.mtimeMs,
      annotationSize: annMeta.size,
    };

    const snapshot = loadIndex();
    const existingSnap = snapshot.sessions[resolvedSessionId];
    const transcriptSame =
      Boolean(existingSnap) &&
      canonicalFileKey(existingSnap.filePath || '') === canonicalFileKey(source.filePath) &&
      existingSnap.mtimeMs === source.mtimeMs &&
      existingSnap.size === source.size;
    const annotationSame =
      Boolean(existingSnap) &&
      (existingSnap.annotationMtimeMs || 0) === (source.annotationMtimeMs || 0) &&
      (existingSnap.annotationSize || 0) === (source.annotationSize || 0);

    if (transcriptSame && annotationSame) {
      return { updated: false, sessionId: resolvedSessionId };
    }

    const annotation = readSessionAnnotation(source.filePath, source.sessionId);
    const annTitle = safeStr(annotation?.title);
    let freshEntry;
    if (transcriptSame && !annotationSame && (annTitle || !existingSnap.hasAnnotationTitle)) {
      freshEntry = annTitle
        ? {
            ...existingSnap,
            title: annTitle,
            annotationMtimeMs: annotation.mtimeMs,
            annotationSize: annotation.size,
            hasAnnotationTitle: true,
            searchText: prependTitleToSearchText(existingSnap.searchText, annTitle),
          }
        : {
            ...existingSnap,
            annotationMtimeMs: annotation.mtimeMs,
            annotationSize: annotation.size,
            hasAnnotationTitle: false,
          };
    } else {
      const readRes = readJsonlSteps(source.filePath);
      if (readRes === null) {
        return { updated: false, sessionId: resolvedSessionId };
      }
      const steps = extractSteps(readRes);
      const parsed = parseSessionTranscript(steps, source);
      freshEntry = buildIndexEntry(source, parsed, existingSnap, annotation);
    }

    ensureDir(resolvedDataDir);
    return withLock(lockPath, () => {
      const latest = loadIndex();
      latest.sessions[resolvedSessionId] = mergeCachedProjectFields(
        freshEntry,
        latest.sessions[resolvedSessionId],
      );
      latest.updatedAt = nowIso();
      writeJsonAtomic(indexPath, latest);
      return { updated: true, sessionId: resolvedSessionId };
    });
  }

  function listSessions({
    q = '',
    query = '',
    projectId = '',
    workspace = '',
    model = '',
    hideSubagents = true,
    limit = 100,
    offset = 0,
  } = {}) {
    const index = loadIndex();
    const allSessions = Object.values(index.sessions || {});

    const modelSet = new Set();
    for (const sess of allSessions) {
      if (!sess || typeof sess !== 'object') continue;
      if (safeStr(sess.firstModel)) modelSet.add(sess.firstModel.trim());
      if (safeStr(sess.lastModel)) modelSet.add(sess.lastModel.trim());
      if (Array.isArray(sess.modelsUsed)) {
        for (const m of sess.modelsUsed) {
          if (safeStr(m)) modelSet.add(m.trim());
        }
      }
    }
    const models = [...modelSet].sort((a, b) => a.localeCompare(b));

    const projectFilter = safeStr(projectId);
    if (projectFilter && !isSafeKey(projectFilter)) {
      return { sessions: [], total: 0, models };
    }
    const workspaceFilter = normalizePathForMatch(workspace);
    const modelFilter = safeStr(model).toLowerCase();
    const tokens = (safeStr(q) || safeStr(query))
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const scored = [];
    for (const sess of allSessions) {
      if (!sess || typeof sess !== 'object') continue;
      if (hideSubagents && sess.isSubagent) continue;
      if (projectFilter && safeStr(sess.projectId) !== projectFilter) continue;

      if (workspaceFilter) {
        const wsNorm = normalizePathForMatch(sess.workspacePath);
        const gitNorm = normalizePathForMatch(sess.gitRoot);
        if (!wsNorm.includes(workspaceFilter) && !gitNorm.includes(workspaceFilter)) {
          continue;
        }
      }

      if (modelFilter) {
        const sessModels = [
          safeStr(sess.firstModel),
          safeStr(sess.lastModel),
          ...(Array.isArray(sess.modelsUsed) ? sess.modelsUsed.map(safeStr) : []),
        ]
          .filter(Boolean)
          .map((m) => m.toLowerCase());
        const modelHit = sessModels.some(
          (m) => m === modelFilter || m.includes(modelFilter),
        );
        if (!modelHit) continue;
      }

      let score = 0;
      if (tokens.length > 0) {
        const titleLow = safeStr(sess.title).toLowerCase();
        const filesLow = [
          ...(Array.isArray(sess.filesModified) ? sess.filesModified : []),
          ...(Array.isArray(sess.filesRead) ? sess.filesRead : []),
        ]
          .join(' ')
          .toLowerCase();
        const workspaceLow = [
          safeStr(sess.workspacePath),
          safeStr(sess.gitRoot),
          safeStr(sess.branchName),
        ]
          .join(' ')
          .toLowerCase();
        const searchLow = safeStr(sess.searchText).toLowerCase();
        const idLow = safeStr(sess.sessionId).toLowerCase();

        let allTokensMatched = true;
        for (const tok of tokens) {
          let tokenScore = 0;
          if (titleLow.includes(tok)) tokenScore += 5;
          if (filesLow.includes(tok)) tokenScore += 4;
          if (workspaceLow.includes(tok)) tokenScore += 3;
          if (searchLow.includes(tok)) tokenScore += 2;
          if (idLow.includes(tok)) tokenScore += 2;

          if (tokenScore === 0) {
            allTokensMatched = false;
            break;
          }
          score += tokenScore;
        }

        if (!allTokensMatched) continue;
      }

      scored.push({
        sess,
        score,
        updatedMs: parseTimeMs(sess.updatedAt, sess.mtimeMs || 0),
      });
    }

    scored.sort((a, b) => {
      if (tokens.length > 0 && b.score !== a.score) return b.score - a.score;
      if (b.updatedMs !== a.updatedMs) return b.updatedMs - a.updatedMs;
      return String(a.sess.sessionId || '').localeCompare(String(b.sess.sessionId || ''));
    });

    const total = scored.length;
    const safeLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : 100;
    const safeOffset =
      typeof offset === 'number' && Number.isFinite(offset) && offset > 0
        ? Math.floor(offset)
        : 0;

    return {
      sessions: scored.slice(safeOffset, safeOffset + safeLimit).map((item) => item.sess),
      total,
      models,
    };
  }

  function locateSessionFile(sessionId) {
    const cleanId = safeStr(sessionId);
    if (!isSafeKey(cleanId)) return null;

    const index = loadIndex();
    const cached = index.sessions[cleanId] || null;

    if (cached?.filePath && isNotSymlink(cached.filePath) && safeStat(cached.filePath)?.isFile()) {
      return {
        sessionId: cleanId,
        cached,
        source: {
          sessionId: cleanId,
          agent: cached.agent || 'antigravity',
          app: cached.app || 'antigravity',
          filePath: cached.filePath,
          fullFilePath: cached.fullFilePath || resolveSiblingFullFile(cached.filePath),
          mtimeMs: cached.mtimeMs,
          size: cached.size,
        },
      };
    }

    const found = normalizeSource(findSessionSource(cleanId));
    if (!found || !isNotSymlink(found.filePath) || !safeStat(found.filePath)?.isFile()) {
      return null;
    }

    return { sessionId: cleanId, cached, source: found };
  }

  function getSessionDetail(sessionId) {
    const located = locateSessionFile(sessionId);
    if (!located) return null;

    const { cached, source } = located;
    const readRes = readJsonlSteps(source.filePath);
    if (readRes === null) return null;
    const steps = extractSteps(readRes);
    const parsed = parseSessionTranscript(steps, source);
    if (!parsed || typeof parsed !== 'object') return null;

    const liveAnnotation = readSessionAnnotation(source.filePath, source.sessionId);
    const liveTitle =
      safeStr(liveAnnotation?.title) ||
      safeStr(parsed.title) ||
      safeStr(cached?.title) ||
      source.sessionId;

    return {
      ...parsed,
      title: liveTitle,
      sessionId: safeStr(parsed.sessionId) || source.sessionId,
      agent: safeStr(parsed.agent) || source.agent,
      app: safeStr(parsed.app) || source.app,
      filePath: source.filePath,
      fullFilePath: source.fullFilePath || parsed.fullFilePath || null,
      projectId: safeStr(cached?.projectId) || safeStr(parsed.projectId),
      workspacePath: safeStr(cached?.workspacePath) || safeStr(parsed.workspacePath),
      gitRoot: safeStr(cached?.gitRoot) || safeStr(parsed.gitRoot),
      branchName: safeStr(cached?.branchName) || safeStr(parsed.branchName),
    };
  }

  function getFullStepContent(sessionId, stepIndex) {
    const idx =
      stepIndex === null || stepIndex === undefined || stepIndex === '' || typeof stepIndex === 'boolean'
        ? NaN
        : Number(stepIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return {
        ok: false,
        stepIndex: Number.isFinite(idx) ? idx : -1,
        content: '',
        step: null,
        error: 'Invalid stepIndex',
      };
    }

    const located = locateSessionFile(sessionId);
    if (!located) {
      return {
        ok: false,
        stepIndex: idx,
        content: '',
        step: null,
        error: 'Session not found',
      };
    }

    const { source } = located;
    const step = readFullStepByIndex(source.filePath, idx);

    if (!step) {
      return {
        ok: false,
        stepIndex: idx,
        content: '',
        step: null,
        error: 'Step not found',
      };
    }

    return {
      ok: true,
      stepIndex: idx,
      content: extractStepTextContent(step),
      step,
    };
  }

  function selectEnrichCandidates({
    limit = 12,
    targetSessionIds = [],
    retryAfterMs = DEFAULT_RETRY_AFTER_MS,
    indexSnap,
    projectsSnap,
  }) {
    const safeLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : 12;
    const safeRetryMs =
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : DEFAULT_RETRY_AFTER_MS;

    const nowMs = Date.now();
    const explicitIds = toUniqueStrings(targetSessionIds).filter(isSafeKey);
    const candidates = [];
    const picked = new Set();

    // 1. 优先查询显式指定的目标会话（例如当前宿主会话）
    for (const id of explicitIds) {
      if (candidates.length >= safeLimit) break;
      const sess = indexSnap.sessions[id];
      if (sess?.projectId && projectsSnap.projects[sess.projectId]) {
        continue;
      }
      if (sess) {
        const lastTryMs = parseTimeMs(sess.metaAttemptedAt, 0);
        if (lastTryMs > 0 && nowMs - lastTryMs < safeRetryMs) continue;
      }
      picked.add(id);
      candidates.push(id);
    }

    // 2. 剩余配额按最近活跃度补齐尚未拥有 projectId 且已过冷却期的会话
    if (candidates.length < safeLimit) {
      const recentUnenriched = Object.values(indexSnap.sessions)
        .filter((sess) => {
          if (!sess || !isSafeKey(sess.sessionId) || picked.has(sess.sessionId)) return false;
          if (sess.agent && sess.agent !== 'antigravity') return false;
          if (safeStr(sess.projectId)) return false;
          const lastTryMs = parseTimeMs(sess.metaAttemptedAt, 0);
          if (lastTryMs > 0 && nowMs - lastTryMs < safeRetryMs) return false;
          return true;
        })
        .sort(
          (a, b) =>
            parseTimeMs(b.updatedAt, b.mtimeMs || 0) - parseTimeMs(a.updatedAt, a.mtimeMs || 0),
        );

      for (const sess of recentUnenriched) {
        if (candidates.length >= safeLimit) break;
        picked.add(sess.sessionId);
        candidates.push(sess.sessionId);
      }
    }

    return candidates;
  }

  function applyEnrichResults(results) {
    const latestIndex = loadIndex();
    const latestProjects = loadProjects();
    let checked = 0;
    let enriched = 0;
    let indexDirty = false;
    let projectsDirty = false;

    for (const { id, attemptedAt, res } of results) {
      if (!isSafeKey(id)) continue;
      checked += 1;
      const sess = latestIndex.sessions[id];
      if (sess) {
        sess.metaAttemptedAt = attemptedAt;
        indexDirty = true;
      }

      if (res?.ok) {
        const rawProjectId = safeStr(res.projectId);
        const projectId = isSafeKey(rawProjectId) ? rawProjectId : '';
        const primaryPath = safeStr(res.primaryPath);
        const gitRoot = safeStr(res.gitRoot);
        const branchName = safeStr(res.branchName);
        const workspaceUris = toUniqueStrings(res.workspaceUris);

        let gotUsefulData = false;
        if (sess) {
          if (projectId) {
            sess.projectId = projectId;
            gotUsefulData = true;
          }
          if (primaryPath) {
            sess.workspacePath = primaryPath;
            gotUsefulData = true;
            if (
              !safeStr(sess.searchText)
                .toLowerCase()
                .includes(primaryPath.toLowerCase())
            ) {
              sess.searchText = clampText(
                collapseWhitespace(`${primaryPath}\n${sess.searchText || ''}`),
                MAX_SEARCH_TEXT_LEN,
              );
            }
          }
          if (gitRoot) sess.gitRoot = gitRoot;
          if (branchName) sess.branchName = branchName;
        }

        if (projectId) {
          upsertProjectRecord(
            latestProjects.projects,
            {
              projectId,
              workspaceUris,
              primaryPath,
              gitRoot,
              branchName,
              displayName: displayNameFromPath(primaryPath, projectId),
            },
            attemptedAt,
          );
          projectsDirty = true;
          gotUsefulData = true;
        }

        if (gotUsefulData) {
          enriched += 1;
        }
      }
    }

    const stamp = nowIso();
    if (indexDirty) {
      latestIndex.updatedAt = stamp;
      writeJsonAtomic(indexPath, latestIndex);
    }
    if (projectsDirty) {
      latestProjects.updatedAt = stamp;
      writeJsonAtomic(projectsPath, latestProjects);
    }

    return {
      checked,
      enriched,
      totalProjects: Object.keys(latestProjects.projects).length,
    };
  }

  function enrichProjects({
    limit = 12,
    targetSessionIds = [],
    retryAfterMs = DEFAULT_RETRY_AFTER_MS,
    timeoutMs,
    agentApi: callAgentApi,
  } = {}) {
    const activeApi = callAgentApi || api;
    const exeStatus =
      typeof activeApi?.resolveAgentApiExecutable === 'function'
        ? activeApi.resolveAgentApiExecutable()
        : { available: false, reason: 'agentApi client unavailable' };

    if (!exeStatus?.available) {
      return {
        skipped: true,
        reason: exeStatus?.reason || 'agentapi unavailable',
      };
    }

    const indexSnap = loadIndex();
    const projectsSnap = loadProjects();
    const candidates = selectEnrichCandidates({
      limit,
      targetSessionIds,
      retryAfterMs,
      indexSnap,
      projectsSnap,
    });

    if (candidates.length === 0) {
      return {
        checked: 0,
        enriched: 0,
        totalProjects: Object.keys(projectsSnap.projects).length,
      };
    }

    const metaOpts =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? { timeoutMs }
        : undefined;

    // 顺序调用外部 agentapi 子进程（绝不在持锁期间阻塞）
    const results = [];
    for (const id of candidates) {
      const attemptedAt = nowIso();
      const res = metaOpts
        ? activeApi.getConversationMetadata(id, metaOpts)
        : activeApi.getConversationMetadata(id);
      results.push({ id, attemptedAt, res });
    }

    ensureDir(resolvedDataDir);
    return withLock(lockPath, () => applyEnrichResults(results));
  }

  async function enrichProjectsAsync({
    limit = 12,
    targetSessionIds = [],
    retryAfterMs = DEFAULT_RETRY_AFTER_MS,
    timeoutMs,
    agentApi: callAgentApi,
  } = {}) {
    const activeApi = callAgentApi || api;
    const exeStatus =
      typeof activeApi?.resolveAgentApiExecutable === 'function'
        ? activeApi.resolveAgentApiExecutable()
        : { available: false, reason: 'agentApi client unavailable' };

    if (!exeStatus?.available) {
      return {
        skipped: true,
        reason: exeStatus?.reason || 'agentapi unavailable',
      };
    }

    const indexSnap = loadIndex();
    const projectsSnap = loadProjects();
    const candidates = selectEnrichCandidates({
      limit,
      targetSessionIds,
      retryAfterMs,
      indexSnap,
      projectsSnap,
    });

    if (candidates.length === 0) {
      return {
        checked: 0,
        enriched: 0,
        totalProjects: Object.keys(projectsSnap.projects).length,
      };
    }

    const metaOpts =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? { timeoutMs }
        : undefined;

    const fetchMetaAsync =
      typeof activeApi?.getConversationMetadataAsync === 'function'
        ? (id) =>
            metaOpts
              ? activeApi.getConversationMetadataAsync(id, metaOpts)
              : activeApi.getConversationMetadataAsync(id)
        : (id) =>
            Promise.resolve(
              metaOpts
                ? activeApi.getConversationMetadata(id, metaOpts)
                : activeApi.getConversationMetadata(id),
            );

    // 异步顺序调用外部 agentapi，并在每次调用间让出事件循环防止阻塞主线程
    const results = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const id = candidates[i];
      if (i > 0) {
        await yieldEventLoop();
      }
      const attemptedAt = nowIso();
      let res;
      try {
        res = await fetchMetaAsync(id);
      } catch (err) {
        res = { ok: false, error: err?.message || 'getConversationMetadataAsync failed' };
      }
      results.push({ id, attemptedAt, res });
    }

    await yieldEventLoop();
    ensureDir(resolvedDataDir);
    const lockAsync =
      typeof fsUtils.withLockAsync === 'function'
        ? fsUtils.withLockAsync
        : async (lp, fn, opts) => withLock(lp, fn, opts);
    return lockAsync(lockPath, () => applyEnrichResults(results));
  }

  function registerWorkspaceProject({
    projectId,
    workspaceUris = [],
    gitRoot = '',
    branchName = '',
    primaryPath = '',
    workspacePath = '',
    displayName = '',
  } = {}) {
    const cleanId = safeStr(projectId);
    if (!isSafeKey(cleanId)) {
      return { ok: false, error: 'Invalid projectId' };
    }

    ensureDir(resolvedDataDir);
    return withLock(lockPath, () => {
      const latestProjects = loadProjects();
      const stamp = nowIso();
      const saved = upsertProjectRecord(
        latestProjects.projects,
        {
          projectId: cleanId,
          workspaceUris,
          primaryPath: primaryPath || workspacePath,
          gitRoot,
          branchName,
          displayName,
        },
        stamp,
      );
      latestProjects.updatedAt = stamp;
      writeJsonAtomic(projectsPath, latestProjects);
      return saved;
    });
  }

  function listProjects() {
    const data = loadProjects();
    const index = loadIndex();
    const counts = new Map();
    for (const sess of Object.values(index.sessions || {})) {
      const pid = safeStr(sess?.projectId);
      if (pid) counts.set(pid, (counts.get(pid) || 0) + 1);
    }

    return Object.values(data.projects || {})
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        ...p,
        sessionCount: counts.get(p.projectId) || 0,
      }))
      .sort((a, b) => {
        const diff = parseTimeMs(b.lastSeenAt, 0) - parseTimeMs(a.lastSeenAt, 0);
        if (diff !== 0) return diff;
        return String(a.displayName || a.projectId || '').localeCompare(
          String(b.displayName || b.projectId || ''),
        );
      });
  }

  function saveHandoffFile({
    title = '',
    markdown,
    content,
    sourceSessionId = '',
    sessionId = '',
  } = {}) {
    const body = typeof markdown === 'string' ? markdown : content;
    if (typeof body !== 'string') {
      throw new TypeError('markdown must be a string');
    }

    const rawLabel = safeStr(title) || safeStr(sourceSessionId) || safeStr(sessionId) || 'handoff';
    let slug = '';
    try {
      slug = safeStr(slugify(rawLabel));
    } catch {
      slug = '';
    }
    const safeSlug = (slug || 'handoff').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'handoff';
    const stamp = formatArchiveTimestamp(new Date());

    ensureDir(resolvedDataDir);
    ensureDir(handoffsDir);

    return withLock(lockPath, () => {
      let filename = `${stamp}-${safeSlug}.md`;
      let candidatePath = join(handoffsDir, filename);
      let attempt = 0;
      while (existsSync(candidatePath) && attempt < 16) {
        const suffix = randomBytes(3).toString('hex');
        filename = `${stamp}-${safeSlug}-${suffix}.md`;
        candidatePath = join(handoffsDir, filename);
        attempt += 1;
      }

      if (!isValidArchiveFilename(filename) || !isPathInsideDir(candidatePath, handoffsDir)) {
        throw new Error('Generated archive path failed safety validation');
      }

      atomicWriteFile(candidatePath, body);
      return {
        filePath: candidatePath,
        filename,
        bytes: Buffer.byteLength(body, 'utf-8'),
      };
    });
  }

  function listArchives() {
    if (!existsSync(handoffsDir) || !isNotSymlink(handoffsDir)) return [];
    const dirStat = safeStat(handoffsDir);
    if (!dirStat || !dirStat.isDirectory()) return [];

    let realDir;
    try {
      realDir = realpathSync(handoffsDir);
    } catch {
      return [];
    }

    const entries = safeReaddir(handoffsDir);
    if (!Array.isArray(entries)) return [];

    const archives = [];
    for (const rawEntry of entries) {
      const filename =
        typeof rawEntry === 'string'
          ? rawEntry
          : rawEntry && typeof rawEntry.name === 'string'
            ? rawEntry.name
            : '';
      if (!isValidArchiveFilename(filename)) continue;

      const filePath = join(handoffsDir, filename);
      if (!isPathInsideDir(filePath, handoffsDir)) continue;
      if (!isNotSymlink(filePath)) continue;

      let realTarget;
      try {
        realTarget = realpathSync(filePath);
      } catch {
        continue;
      }
      if (!isPathInsideDir(realTarget, realDir)) continue;

      const st = safeStat(realTarget);
      if (!st || !st.isFile()) continue;

      archives.push({
        filename,
        filePath,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }

    archives.sort(
      (a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename),
    );
    return archives;
  }

  function readArchive(filename) {
    if (!isValidArchiveFilename(filename)) {
      return { ok: false, error: 'Invalid archive filename' };
    }

    if (!existsSync(handoffsDir)) {
      return { ok: false, error: 'Archive file not found' };
    }

    if (!isNotSymlink(handoffsDir)) {
      return { ok: false, error: 'Refusing to read symbolic link archive directory' };
    }

    const filePath = join(handoffsDir, filename);
    if (!isPathInsideDir(filePath, handoffsDir)) {
      return { ok: false, error: 'Archive path outside handoffs directory' };
    }

    if (!existsSync(filePath)) {
      return { ok: false, error: 'Archive file not found' };
    }

    if (!isNotSymlink(filePath)) {
      return { ok: false, error: 'Refusing to read symbolic link archive' };
    }

    let realDir;
    let realTarget;
    try {
      realDir = realpathSync(handoffsDir);
      realTarget = realpathSync(filePath);
    } catch {
      return { ok: false, error: 'Archive file not found' };
    }

    if (!isPathInsideDir(realTarget, realDir)) {
      return { ok: false, error: 'Archive realpath outside handoffs directory' };
    }

    const st = safeStat(realTarget);
    if (!st || !st.isFile()) {
      return { ok: false, error: 'Archive file not found' };
    }

    if (st.size > MAX_ARCHIVE_BYTES) {
      return {
        ok: false,
        error: `Archive file exceeds 16 MiB limit (${st.size} bytes)`,
      };
    }

    try {
      const content = readFileSync(realTarget, 'utf-8');
      return {
        ok: true,
        filename,
        filePath,
        content,
        size: st.size,
      };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || 'Failed to read archive file',
      };
    }
  }

  function recordLineage(record) {
    const base = record && typeof record === 'object' ? { ...record } : {};
    ensureDir(resolvedDataDir);

    return withLock(lockPath, () => {
      const data = loadLineage();
      const stamp = nowIso();
      const saved = {
        ...base,
        id: safeStr(base.id) || randomUUID(),
        createdAt: safeStr(base.createdAt) || stamp,
      };
      data.records.push(saved);
      data.updatedAt = stamp;
      writeJsonAtomic(lineagePath, data);
      return saved;
    });
  }

  function listLineage() {
    const data = loadLineage();
    return [...data.records].sort((a, b) => {
      const diff = parseTimeMs(b?.createdAt, 0) - parseTimeMs(a?.createdAt, 0);
      if (diff !== 0) return diff;
      return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
    });
  }

  return {
    getDataDir: () => resolvedDataDir,
    syncAll,
    syncSingle,
    listSessions,
    getSessionDetail,
    getSession: getSessionDetail,
    getFullStepContent,
    enrichProjects,
    enrichProjectsAsync,
    registerWorkspaceProject,
    registerWorkspace: registerWorkspaceProject,
    listProjects,
    saveHandoffFile,
    listArchives,
    readArchive,
    recordLineage,
    listLineage,
  };
}

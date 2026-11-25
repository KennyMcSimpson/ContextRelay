import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileUriToPath, getDataDir } from '../core/fs-utils.mjs';
import { applySurgeryPreset } from '../core/turn-parser.mjs';
import { collectGitAnchor } from '../core/git-anchor.mjs';
import {
  buildHandoffBundle,
  buildLaunchPrompt,
  HARD_INLINE_LIMIT_BYTES,
  INLINE_LIMIT_BYTES,
} from '../core/handoff-builder.mjs';
import { createAgentApiClient } from '../core/agentapi.mjs';
import { createRelayStore } from '../core/store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UI_DIR = resolve(__dirname, '..', 'ui');

const DEFAULT_SYNC_COOLDOWN_MS = 3000;
const VALID_PRESETS = new Set(['smart-clean', 'backbone', 'truncate-at', 'all', 'none']);

function normalizeBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return defaultValue;
}

function normalizePreset(raw, fallback = 'smart-clean') {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return VALID_PRESETS.has(s) ? s : fallback;
}

function getSessionId(session) {
  if (!session || typeof session !== 'object') return '';
  return String(session.sessionId || session.id || '').trim();
}

function deriveModelsFromSessions(sessions) {
  const set = new Set();
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.lastModel === 'string' && s.lastModel.trim()) set.add(s.lastModel.trim());
    if (typeof s.firstModel === 'string' && s.firstModel.trim()) set.add(s.firstModel.trim());
    if (typeof s.model === 'string' && s.model.trim()) set.add(s.model.trim());
    if (Array.isArray(s.modelsUsed)) {
      for (const m of s.modelsUsed) {
        if (typeof m === 'string' && m.trim()) set.add(m.trim());
      }
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function normalizeWorkspaceInputs(body = {}) {
  const uris = [];
  if (Array.isArray(body.workspaceUris)) {
    for (const u of body.workspaceUris) {
      if (typeof u === 'string' && u.trim()) uris.push(u.trim());
    }
  }
  if (typeof body.workspaceUri === 'string' && body.workspaceUri.trim()) {
    uris.push(body.workspaceUri.trim());
  }

  const paths = [];
  const seen = new Set();
  const pushPath = (p) => {
    if (typeof p !== 'string') return;
    const trimmed = p.trim();
    if (!trimmed) return;
    const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(trimmed);
  };

  for (const u of uris) {
    try {
      const converted = fileUriToPath(u);
      pushPath(converted || u);
    } catch {
      pushPath(u);
    }
  }
  if (Array.isArray(body.workspacePaths)) {
    for (const p of body.workspacePaths) pushPath(p);
  }
  if (typeof body.workspacePath === 'string') {
    pushPath(body.workspacePath);
  }
  return { uris, paths };
}

/**
 * Create the pure-JS API controller shared by SidecarApp and the standalone HTTP server.
 */
export function createApiController({
  dataDir,
  agentApi,
  store,
  syncCooldownMs = DEFAULT_SYNC_COOLDOWN_MS,
} = {}) {
  const resolvedDataDir = getDataDir(dataDir || '');
  const apiClient = agentApi || createAgentApiClient();
  const relayStore = store || createRelayStore({ dataDir: resolvedDataDir, agentApi: apiClient });

  let lastSyncAt = 0;
  let lastSyncError = '';
  let isSyncing = false;
  let lastSyncResult = null;
  const assetCache = new Map();
  const runtimeWorkspaceCache = new Map();

  function readStaticAsset(filename) {
    const filePath = join(UI_DIR, filename);
    const st = statSync(filePath);
    const cached = assetCache.get(filename);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.content;
    }
    const content = readFileSync(filePath, 'utf-8');
    assetCache.set(filename, { mtimeMs: st.mtimeMs, size: st.size, content });
    return content;
  }

  function getHtml({ injectPreload = false } = {}) {
    let html = readStaticAsset('index.html');
    if (injectPreload && !html.includes('<script src="/preload.js"></script>')) {
      if (html.includes('<!-- HOST_PRELOAD -->')) {
        html = html.replace('<!-- HOST_PRELOAD -->', () => '<script src="/preload.js"></script>');
      } else if (/<\/head>/i.test(html)) {
        html = html.replace(/<\/head>/i, (match) => `  <script src="/preload.js"></script>\n${match}`);
      } else {
        html = `<script src="/preload.js"></script>\n${html}`;
      }
    }
    return html;
  }

  function getCss() {
    return readStaticAsset('styles.css');
  }

  function getJs() {
    return readStaticAsset('app.js');
  }

  function isAgentApiAvailable() {
    try {
      const res =
        typeof apiClient?.resolveAgentApiExecutable === 'function'
          ? apiClient.resolveAgentApiExecutable()
          : null;
      return Boolean(res && res.available);
    } catch {
      return false;
    }
  }

  function getStatus() {
    return {
      lastSyncAt,
      lastSyncError,
      isSyncing,
      syncCooldownMs,
      lastSyncResult,
    };
  }

  function listProjectsSafe() {
    if (typeof relayStore?.listProjects !== 'function') return [];
    const res = relayStore.listProjects();
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.projects)) return res.projects;
    return [];
  }

  function listSessionsNormalized(opts = {}) {
    const fn =
      typeof relayStore?.listSessions === 'function'
        ? relayStore.listSessions.bind(relayStore)
        : typeof relayStore?.searchSessions === 'function'
          ? relayStore.searchSessions.bind(relayStore)
          : null;
    if (!fn) {
      return { sessions: [], total: 0, models: [] };
    }
    const raw = fn(opts);
    if (Array.isArray(raw)) {
      return {
        sessions: raw,
        total: raw.length,
        models: deriveModelsFromSessions(raw),
      };
    }
    const sessions = Array.isArray(raw?.sessions)
      ? raw.sessions
      : Array.isArray(raw?.items)
        ? raw.items
        : [];
    const total = typeof raw?.total === 'number' ? raw.total : sessions.length;
    const models =
      Array.isArray(raw?.models) && raw.models.length > 0
        ? raw.models
        : typeof relayStore?.listModels === 'function'
          ? relayStore.listModels()
          : deriveModelsFromSessions(sessions);
    return { sessions, total, models };
  }

  function loadSessionNormalized(id) {
    if (!id || typeof id !== 'string') return null;
    const fn =
      typeof relayStore?.getSessionDetail === 'function'
        ? relayStore.getSessionDetail.bind(relayStore)
        : typeof relayStore?.getSession === 'function'
          ? relayStore.getSession.bind(relayStore)
          : typeof relayStore?.getParsedSession === 'function'
            ? relayStore.getParsedSession.bind(relayStore)
            : typeof relayStore?.loadSession === 'function'
              ? relayStore.loadSession.bind(relayStore)
              : null;
    if (!fn) return null;
    const raw = fn(id);
    if (!raw || typeof raw !== 'object') return null;
    const session = raw.session && typeof raw.session === 'object' ? raw.session : raw;
    if (!session.workspacePath) {
      const cached = runtimeWorkspaceCache.get(id);
      if (cached?.workspacePath) {
        return {
          ...session,
          workspacePath: cached.workspacePath,
          projectId: session.projectId || cached.projectId || '',
        };
      }
    }
    return session;
  }

  function runSync({ force = false, enrichProjects = false, targetSessionIds = [] } = {}) {
    if (isSyncing) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_syncing',
        sync: null,
        enrich: null,
      };
    }

    const now = Date.now();
    const withinCooldown = !force && lastSyncAt > 0 && now - lastSyncAt < syncCooldownMs;
    if (withinCooldown && !enrichProjects) {
      return {
        ok: true,
        skipped: true,
        reason: 'cooldown',
        sync: lastSyncResult,
        enrich: null,
      };
    }

    isSyncing = true;
    try {
      let sync = lastSyncResult;
      if (!withinCooldown && typeof relayStore?.syncAll === 'function') {
        sync = relayStore.syncAll({ force: Boolean(force) });
        lastSyncAt = Date.now();
        lastSyncResult = sync;
      }

      let enrich = null;
      if (enrichProjects && typeof relayStore?.enrichProjects === 'function') {
        const targets = Array.isArray(targetSessionIds)
          ? targetSessionIds.filter((s) => typeof s === 'string' && s.trim())
          : [];
        enrich = relayStore.enrichProjects({
          limit: 8,
          targetSessionIds: targets,
        });
      }

      lastSyncError = '';
      return {
        ok: true,
        skipped: false,
        sync,
        enrich,
        syncedAt: lastSyncAt,
      };
    } catch (err) {
      lastSyncError = err?.message || String(err);
      return {
        ok: false,
        skipped: false,
        error: lastSyncError,
        sync: null,
        enrich: null,
      };
    } finally {
      isSyncing = false;
    }
  }

  async function runSyncAsync({ force = false, enrichProjects = false, targetSessionIds = [] } = {}) {
    if (isSyncing) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_syncing',
        sync: null,
        enrich: null,
      };
    }

    const now = Date.now();
    const withinCooldown = !force && lastSyncAt > 0 && now - lastSyncAt < syncCooldownMs;
    if (withinCooldown && !enrichProjects) {
      return {
        ok: true,
        skipped: true,
        reason: 'cooldown',
        sync: lastSyncResult,
        enrich: null,
      };
    }

    isSyncing = true;
    try {
      let sync = lastSyncResult;
      if (!withinCooldown && typeof relayStore?.syncAll === 'function') {
        sync = await Promise.resolve(relayStore.syncAll({ force: Boolean(force) }));
        lastSyncAt = Date.now();
        lastSyncResult = sync;
      }

      let enrich = null;
      if (enrichProjects) {
        const targets = Array.isArray(targetSessionIds)
          ? targetSessionIds.filter((s) => typeof s === 'string' && s.trim())
          : [];
        if (typeof relayStore?.enrichProjectsAsync === 'function') {
          enrich = await relayStore.enrichProjectsAsync({
            limit: 8,
            targetSessionIds: targets,
          });
        } else if (typeof relayStore?.enrichProjects === 'function') {
          enrich = await Promise.resolve(
            relayStore.enrichProjects({
              limit: 8,
              targetSessionIds: targets,
            }),
          );
        }
      }

      lastSyncError = '';
      return {
        ok: true,
        skipped: false,
        sync,
        enrich,
        syncedAt: lastSyncAt,
      };
    } catch (err) {
      lastSyncError = err?.message || String(err);
      return {
        ok: false,
        skipped: false,
        error: lastSyncError,
        sync: null,
        enrich: null,
      };
    } finally {
      isSyncing = false;
    }
  }

  function maybeIncrementalSync(query = {}) {
    if (query.noSync === '1' || query.noSync === 'true' || query.noSync === true) {
      return;
    }
    if (lastSyncAt === 0 || Date.now() - lastSyncAt >= syncCooldownMs) {
      runSync({ force: false, enrichProjects: false });
    }
  }

  function handleState(query = {}, hostConvId = '') {
    maybeIncrementalSync(query);

    const listed = listSessionsNormalized({
      hideSubagents: true,
      limit: 200,
    });

    const requestedConvId =
      (typeof query.conversationId === 'string' && query.conversationId.trim()) ||
      (typeof query.id === 'string' && query.id.trim()) ||
      '';
    const hostId = typeof hostConvId === 'string' ? hostConvId.trim() : '';
    const targetId = requestedConvId || hostId;

    let currentSession = null;
    if (targetId) {
      currentSession = loadSessionNormalized(targetId);
    } else {
      const latestMain =
        listed.sessions.find((s) => !s?.isSubagent) || listed.sessions[0] || null;
      const fallbackId = getSessionId(latestMain);
      if (fallbackId) {
        currentSession = loadSessionNormalized(fallbackId);
      }
    }

    const preset = normalizePreset(query.preset, 'smart-clean');
    const defaultSelection = currentSession
      ? applySurgeryPreset(currentSession, preset)
      : { selectedTurnIds: [], selectedItemIds: [] };

    const gitAnchor =
      currentSession && currentSession.workspacePath
        ? collectGitAnchor(currentSession.workspacePath)
        : null;

    const currentSessionId = currentSession ? getSessionId(currentSession) : '';

    return {
      ok: true,
      currentSessionId,
      hostConversationId: hostId,
      agentApiAvailable: isAgentApiAvailable(),
      dataDir: resolvedDataDir,
      status: getStatus(),
      projects: listProjectsSafe(),
      models: listed.models,
      sessionsCount: listed.total,
      currentSession,
      defaultSelection,
      gitAnchor,
    };
  }

  function handleSessions(query = {}) {
    maybeIncrementalSync(query);

    const hideSubagents = query.hideSubagents !== '0' && query.hideSubagents !== 'false' && query.hideSubagents !== false;
    const rawLimit = Number(query.limit);
    const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 80));
    const rawOffset = Number(query.offset);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const searchQuery =
      typeof query.q === 'string'
        ? query.q
        : typeof query.query === 'string'
          ? query.query
          : '';

    const listed = listSessionsNormalized({
      q: searchQuery,
      query: searchQuery,
      projectId: typeof query.projectId === 'string' ? query.projectId.trim() : '',
      workspace: typeof query.workspace === 'string' ? query.workspace.trim() : '',
      model: typeof query.model === 'string' ? query.model.trim() : '',
      hideSubagents,
      limit,
      offset,
    });

    return {
      ok: true,
      sessions: listed.sessions,
      total: listed.total,
      models: listed.models,
      projects: listProjectsSafe(),
    };
  }

  function handleSessionDetail(query = {}) {
    const id = typeof query.id === 'string' ? query.id.trim() : '';
    if (!id) {
      return { ok: false, status: 404, error: 'Session not found' };
    }

    let session = loadSessionNormalized(id);
    if (!session) {
      return { ok: false, status: 404, error: 'Session not found' };
    }

    // On-demand single-session metadata enrichment when projectId or workspacePath is missing
    if ((!session.projectId || !session.workspacePath) && isAgentApiAvailable()) {
      try {
        if (typeof relayStore?.enrichProjects === 'function') {
          relayStore.enrichProjects({ limit: 1, targetSessionIds: [id] });
          const refreshed = loadSessionNormalized(id);
          if (refreshed) session = refreshed;
        }
        if ((!session.projectId || !session.workspacePath) && typeof apiClient?.getConversationMetadata === 'function') {
          const meta = apiClient.getConversationMetadata(id);
          if (meta && meta.ok) {
            session = {
              ...session,
              projectId: session.projectId || meta.projectId || '',
              workspacePath: session.workspacePath || meta.primaryPath || '',
            };
          }
        }
      } catch {
        // Non-fatal metadata enrichment error
      }
    }

    const workspacePath =
      (typeof query.workspace === 'string' && query.workspace.trim()) ||
      session.workspacePath ||
      '';
    const gitAnchor = workspacePath ? collectGitAnchor(workspacePath) : null;
    const preset = normalizePreset(query.preset, 'smart-clean');
    const defaultSelection = applySurgeryPreset(session, preset);

    return {
      ok: true,
      session,
      defaultSelection,
      gitAnchor,
      projects: listProjectsSafe(),
    };
  }

  function handleStepFull(query = {}) {
    const id = typeof query.id === 'string' ? query.id.trim() : '';
    const stepIndex = Number(query.stepIndex);
    if (!id || !Number.isInteger(stepIndex) || stepIndex < 0) {
      return { ok: false, status: 400, error: 'Invalid id or stepIndex' };
    }
    if (typeof relayStore?.getFullStepContent !== 'function') {
      return { ok: false, status: 501, error: 'Full step retrieval not supported' };
    }
    const res = relayStore.getFullStepContent(id, stepIndex);
    if (!res) {
      return { ok: false, status: 404, error: 'Step not found' };
    }
    if (typeof res === 'object' && 'ok' in res) {
      if (!res.ok && typeof res.status !== 'number') {
        return { ...res, status: 404 };
      }
      return res;
    }
    return { ok: true, ...res };
  }

  function resolveRequestSessionId(body = {}) {
    return (
      (typeof body.id === 'string' && body.id.trim()) ||
      (typeof body.sessionId === 'string' && body.sessionId.trim()) ||
      ''
    );
  }

  function resolveSelectedTurnIds(session, body = {}) {
    if (Array.isArray(body.selectedTurnIds)) {
      return body.selectedTurnIds;
    }
    if (Array.isArray(body.selectedTurnIndices)) {
      const turns = Array.isArray(session?.turns) ? session.turns : [];
      const hasNumericIndex = turns.some((t) => typeof t?.index === 'number');
      const ids = [];
      const seen = new Set();
      for (const rawIdx of body.selectedTurnIndices) {
        const idx = Number(rawIdx);
        if (!Number.isInteger(idx) || idx < 0) continue;
        let turn = null;
        if (hasNumericIndex) {
          // Prefer exact 1-based turn.index match first; allow 0 to map to first turn for legacy 0-based callers.
          turn = turns.find((t) => t?.index === idx) || (idx === 0 ? turns[0] : null);
        } else {
          turn = turns[idx] || null;
        }
        if (turn?.id && !seen.has(turn.id)) {
          seen.add(turn.id);
          ids.push(turn.id);
        }
      }
      return ids;
    }
    return undefined;
  }

  function buildBundleForRequest(session, body = {}) {
    const id = getSessionId(session) || resolveRequestSessionId(body);
    const includeGitAnchor = body.includeGitAnchor !== false;
    const targetWorkspace =
      typeof body.targetWorkspace === 'string' ? body.targetWorkspace.trim() : '';
    const workspacePath =
      (typeof body.workspacePath === 'string' && body.workspacePath.trim()) ||
      session.workspacePath ||
      targetWorkspace ||
      '';
    const gitAnchor =
      includeGitAnchor && workspacePath
        ? collectGitAnchor(workspacePath, {
            includeDiffSnippet: Boolean(body.includeDiffSnippet),
          })
        : null;

    const fullStepLoader = (stepIdx) => {
      try {
        const loaded = relayStore?.getFullStepContent?.(id, stepIdx);
        return typeof loaded?.content === 'string' ? loaded.content : '';
      } catch {
        return '';
      }
    };

    const selectedTurnIds = resolveSelectedTurnIds(session, body);
    const bundle = buildHandoffBundle(session, {
      ...body,
      targetWorkspace,
      ...(selectedTurnIds !== undefined ? { selectedTurnIds } : {}),
      gitAnchor,
      fullStepLoader,
    });
    return { bundle, gitAnchor };
  }

  function handlePreview(body = {}) {
    const id = resolveRequestSessionId(body);
    if (!id) {
      return { ok: false, status: 400, error: 'Missing session id' };
    }
    const session = loadSessionNormalized(id);
    if (!session) {
      return { ok: false, status: 404, error: 'Session not found' };
    }

    const { bundle } = buildBundleForRequest(session, body);
    return {
      ok: true,
      bundle,
      inlineLimitBytes: INLINE_LIMIT_BYTES,
    };
  }

  function handleExport(body = {}) {
    const preview = handlePreview(body);
    if (!preview.ok) return preview;

    const id = resolveRequestSessionId(body);
    const session = loadSessionNormalized(id);
    const title =
      (typeof body.title === 'string' && body.title.trim()) ||
      session?.title ||
      id;

    const saved = relayStore.saveHandoffFile({
      title,
      markdown: preview.bundle.markdown,
      sourceSessionId: id,
    });

    return {
      ok: true,
      ...saved,
      bundle: preview.bundle,
    };
  }

  function handleLaunch(body = {}) {
    if (!isAgentApiAvailable()) {
      return {
        ok: false,
        status: 400,
        error:
          'Antigravity agentapi is unavailable in standalone web mode. Use Copy or Export MD, or launch inside the Antigravity sidebar.',
      };
    }

    const id = resolveRequestSessionId(body);
    if (!id) {
      return { ok: false, status: 400, error: 'Missing session id' };
    }
    const session = loadSessionNormalized(id);
    if (!session) {
      return { ok: false, status: 404, error: 'Session not found' };
    }

    const { bundle } = buildBundleForRequest(session, body);
    const exceedsHardLimit = (bundle.bytes || 0) > HARD_INLINE_LIMIT_BYTES;
    const useFileMode =
      exceedsHardLimit ||
      body.mode === 'file' ||
      (body.mode !== 'inline' && Boolean(bundle.recommendFileMode));

    const relayTitle =
      (typeof body.title === 'string' && body.title.trim()) ||
      `[Relay] ${session.title || id}`;

    let saved = null;
    if (useFileMode || body.alwaysArchive !== false) {
      saved = relayStore.saveHandoffFile({
        title: (typeof body.title === 'string' && body.title.trim()) || session.title || id,
        markdown: bundle.markdown,
        sourceSessionId: id,
      });
    }

    const launch = buildLaunchPrompt({
      bundle,
      markdown: bundle.markdown,
      handoffFilePath: useFileMode ? saved?.filePath || '' : '',
      targetWorkspace: typeof body.targetWorkspace === 'string' ? body.targetWorkspace.trim() : '',
      extraInstruction: typeof body.extraInstruction === 'string' ? body.extraInstruction : '',
      forceFileMode: useFileMode,
      redact: body.redact !== false,
    });

    const targetModel =
      (typeof body.model === 'string' && body.model.trim()) ||
      session.lastModel ||
      session.model ||
      '';
    const targetProjectId =
      (typeof body.targetProjectId === 'string' && body.targetProjectId.trim()) ||
      session.projectId ||
      '';

    const startRes = apiClient.startNewConversation({
      prompt: launch.prompt,
      model: targetModel,
      title: relayTitle,
      projectId: targetProjectId,
    });

    if (!startRes || !startRes.ok || !startRes.conversationId) {
      return {
        ok: false,
        status: 502,
        error: startRes?.error || 'Failed to start new conversation via agentapi',
        handoffFilePath: saved?.filePath || '',
      };
    }

    const conversationId = startRes.conversationId;
    const bundleBytes =
      typeof bundle.bytes === 'number'
        ? bundle.bytes
        : Buffer.byteLength(bundle.markdown || '', 'utf-8');
    const estimatedTokens = typeof bundle.estimatedTokens === 'number' ? bundle.estimatedTokens : 0;
    const originalPeakTokens =
      bundle.originalPeakTokens ?? session.peakContextTokens ?? 0;
    const redactionCount = typeof bundle.redactionCount === 'number' ? bundle.redactionCount : 0;
    const savedPercent = typeof bundle.savedPercent === 'number' ? bundle.savedPercent : 0;

    const lineageEntry = relayStore.recordLineage({
      sourceSessionId: id,
      sourceTitle: session.title || '',
      sourceProjectId: session.projectId || '',
      sourceWorkspacePath: session.workspacePath || '',
      targetSessionId: conversationId,
      targetConversationId: conversationId,
      targetTitle: relayTitle,
      targetProjectId,
      targetWorkspace: typeof body.targetWorkspace === 'string' ? body.targetWorkspace.trim() : '',
      model: targetModel,
      mode: launch.mode,
      launchMode: launch.mode,
      handoffFilePath: saved?.filePath || '',
      handoffFilename: saved?.filename || '',
      preset: typeof body.preset === 'string' ? body.preset : '',
      originalPeakTokens,
      savedPercent,
      bytes: bundleBytes,
      estimatedTokens,
      redactionCount,
    });

    return {
      ok: true,
      conversationId,
      launchMode: launch.mode,
      handoffFilePath: saved?.filePath || '',
      savedPercent,
      lineageEntry,
      bundleStats: {
        bytes: bundleBytes,
        estimatedTokens,
        redactionCount,
      },
    };
  }

  function handleLineage() {
    const lineage =
      typeof relayStore?.listLineage === 'function' ? relayStore.listLineage() : [];
    const archives =
      typeof relayStore?.listArchives === 'function' ? relayStore.listArchives() : [];
    return {
      ok: true,
      lineage: Array.isArray(lineage) ? lineage : lineage?.lineage || lineage?.items || [],
      archives: Array.isArray(archives) ? archives : archives?.archives || archives?.files || [],
    };
  }

  function handleArchiveRead(query = {}) {
    const filename = typeof query.filename === 'string' ? query.filename.trim() : '';
    if (!filename) {
      return { ok: false, status: 400, error: 'Missing archive filename' };
    }
    const res = relayStore.readArchive(filename);
    if (!res) {
      return { ok: false, status: 404, error: 'Archive not found' };
    }
    if (typeof res === 'object' && 'ok' in res) {
      if (!res.ok && typeof res.status !== 'number') {
        const msg = String(res.error || '').toLowerCase();
        const status =
          msg.includes('invalid') || msg.includes('traversal') || msg.includes('outside')
            ? 400
            : 404;
        return { ...res, status };
      }
      return res;
    }
    return { ok: true, ...res };
  }

  function handleSync(body = {}) {
    const force = normalizeBool(body?.force, false);
    const enrichProjects = normalizeBool(body?.enrichProjects, false);
    const targetSessionIds = Array.isArray(body?.targetSessionIds)
      ? body.targetSessionIds.filter((s) => typeof s === 'string' && s.trim())
      : [];

    const res = runSync({ force, enrichProjects, targetSessionIds });
    if (!res.ok) {
      return {
        ok: false,
        status: 500,
        error: res.error || 'Sync failed',
        sync: res.sync,
        enrich: res.enrich,
        projects: listProjectsSafe(),
      };
    }

    return {
      ok: true,
      sync: res.sync,
      enrich: res.enrich,
      projects: listProjectsSafe(),
      status: getStatus(),
    };
  }

  function handleRegisterWorkspace(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, status: 400, error: 'Invalid workspace payload' };
    }
    if (body.workspaceUris !== undefined && !Array.isArray(body.workspaceUris)) {
      return { ok: false, status: 400, error: 'workspaceUris must be an array' };
    }
    if (body.workspacePaths !== undefined && !Array.isArray(body.workspacePaths)) {
      return { ok: false, status: 400, error: 'workspacePaths must be an array' };
    }

    const conversationId =
      (typeof body.conversationId === 'string' && body.conversationId.trim()) ||
      (typeof body.hostConversationId === 'string' && body.hostConversationId.trim()) ||
      '';
    let projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    const { uris, paths } = normalizeWorkspaceInputs(body);
    const primaryPath = paths[0] || '';

    const allStrings = [conversationId, projectId, ...uris, ...paths];
    if (allStrings.some((s) => s.includes('\0'))) {
      return { ok: false, status: 400, error: 'Invalid NUL byte in workspace registration payload' };
    }

    if (uris.length === 0 && paths.length === 0 && !projectId) {
      return {
        ok: false,
        status: 400,
        error: 'Missing workspaceUris, workspacePath, or projectId',
      };
    }

    if (!projectId && conversationId) {
      const existing = loadSessionNormalized(conversationId);
      if (existing?.projectId) {
        projectId = existing.projectId;
      } else if (isAgentApiAvailable() && typeof apiClient?.getConversationMetadata === 'function') {
        try {
          const meta = apiClient.getConversationMetadata(conversationId);
          if (meta?.ok && meta.projectId) {
            projectId = meta.projectId;
          }
        } catch {
          // Non-fatal metadata lookup error
        }
      }
    }

    if (conversationId && (primaryPath || projectId)) {
      runtimeWorkspaceCache.set(conversationId, {
        workspacePath: primaryPath,
        workspaceUris: uris,
        workspacePaths: paths,
        projectId,
        updatedAt: Date.now(),
      });
    }

    const registerFn =
      typeof relayStore?.registerWorkspaceProject === 'function'
        ? relayStore.registerWorkspaceProject.bind(relayStore)
        : typeof relayStore?.registerWorkspace === 'function'
          ? relayStore.registerWorkspace.bind(relayStore)
          : null;

    if (projectId && registerFn) {
      try {
        const regRes = registerFn({
          projectId,
          workspaceUris: uris,
          primaryPath,
          workspacePath: primaryPath,
          gitRoot: typeof body.gitRoot === 'string' ? body.gitRoot.trim() : '',
          branchName: typeof body.branchName === 'string' ? body.branchName.trim() : '',
          displayName: typeof body.displayName === 'string' ? body.displayName.trim() : '',
        });
        if (regRes && typeof regRes === 'object' && regRes.ok === false) {
          return {
            ok: false,
            status: 400,
            error: regRes.error || 'Workspace registration validation failed',
          };
        }
      } catch (err) {
        return {
          ok: false,
          status: 400,
          error: err?.message || 'Workspace registration failed',
        };
      }
    }

    return {
      ok: true,
      conversationId,
      projectId,
      workspacePaths: paths,
      projects: listProjectsSafe(),
    };
  }

  return {
    getHtml,
    getCss,
    getJs,
    getStatus,
    runSync,
    runSyncAsync,
    handleState,
    handleSessions,
    handleSessionDetail,
    handleStepFull,
    handlePreview,
    handleExport,
    handleLaunch,
    handleLineage,
    handleArchiveRead,
    handleSync,
    handleRegisterWorkspace,
  };
}

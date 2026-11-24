(function () {
  'use strict';

  /* ========================================================================
     1. Utilities & Strict XSS-Safe Helpers
     ======================================================================== */

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return ch;
      }
    });
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(2)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${Math.round(v)} B`;
  }

  function utf8ByteLength(str) {
    if (!str) return 0;
    try {
      return new TextEncoder().encode(str).length;
    } catch {
      return str.length * 2;
    }
  }

  function fmtRelTime(input) {
    if (!input) return '—';
    const ts = typeof input === 'number' ? input : Date.parse(String(input));
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60_000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const days = Math.floor(hr / 24);
    if (days < 7) return `${days} 天前`;
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function shortPath(rawPath, segments = 2) {
    const clean = String(rawPath || '').trim().replace(/[\\/]+$/, '');
    if (!clean) return '未关联目录';
    const parts = clean.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= segments) return clean;
    return `…/${parts.slice(-segments).join('/')}`;
  }

  function fileBasename(rawPath) {
    const clean = String(rawPath || '').trim().replace(/[\\/]+$/, '');
    if (!clean) return '';
    const parts = clean.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || clean;
  }

  function collapseLine(text, maxLen = 220) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLen) return cleaned;
    return `${cleaned.slice(0, maxLen - 1)}…`;
  }

  function tokenLevel(tokens) {
    const n = Number(tokens) || 0;
    if (n >= 150_000) return { level: 'err', label: '降智预警' };
    if (n >= 100_000) return { level: 'warn', label: '偏高' };
    return { level: 'ok', label: '健康' };
  }

  function normalizePathLower(p) {
    return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  async function copyToClipboard(text) {
    const str = String(text ?? '');
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(str);
        return true;
      } catch {
        // Fallback below for restricted webview permissions
      }
    }
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  function debounce(fn, waitMs) {
    let timer = null;
    const debounced = function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, waitMs);
    };
    debounced.isPending = () => timer !== null;
    debounced.cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return debounced;
  }

  /* ========================================================================
     2. Toast Notification System
     ======================================================================== */

  function showToast(message, type = 'info', durationMs = 3200) {
    const container = $('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;

    const dot = document.createElement('span');
    dot.className = 'toast-dot';

    const span = document.createElement('span');
    span.textContent = String(message || '');

    el.appendChild(dot);
    el.appendChild(span);
    container.appendChild(el);

    while (container.children.length > 4) {
      container.firstElementChild?.remove();
    }

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 180ms ease';
      setTimeout(() => el.remove(), 200);
    }, durationMs);
  }

  /* ========================================================================
     3. HostBridge — Sidecar & Local Web Unified Transport (No AbortSignal!)
     ======================================================================== */

  const urlParams = new URLSearchParams(window.location.search);
  const isSidecar = typeof window !== 'undefined' && Boolean(window.sidecar);

  const reqSeq = Object.create(null);

  const HostBridge = {
    isSidecar,

    getHostConversationId() {
      return String(window.sidecar?.conversationId || urlParams.get('conversationId') || '').trim();
    },

    /**
     * Unified fetch wrapper.
     * CRITICAL: Never forward `signal` / `AbortSignal` to `window.sidecar.fetch`
     * (Chromium IPC structured-clone throws DataCloneError). Instead use monotonic
     * `reqSeq[channel]` to discard stale out-of-order responses.
     */
    async request(path, { method = 'GET', body, channel = '' } = {}) {
      let seq = 0;
      if (channel) {
        seq = (reqSeq[channel] || 0) + 1;
        reqSeq[channel] = seq;
      }

      const methodUpper = String(method || 'GET').toUpperCase();
      const fetchOpts = { method: methodUpper };
      if (methodUpper === 'POST' || body !== undefined) {
        fetchOpts.headers = {
          'Content-Type': 'application/json',
          'X-Context-Relay': '1',
        };
        fetchOpts.body = JSON.stringify(body !== undefined ? body : {});
      }
      // Explicitly guarantee no non-cloneable signal property exists
      delete fetchOpts.signal;

      const transport =
        isSidecar && typeof window.sidecar.fetch === 'function'
          ? window.sidecar.fetch.bind(window.sidecar)
          : window.fetch.bind(window);

      const res = await transport(path, fetchOpts);

      if (channel && seq !== reqSeq[channel]) {
        return { _stale: true };
      }

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (channel && seq !== reqSeq[channel]) {
        return { _stale: true };
      }

      if (!res.ok) {
        const msg = (data && typeof data.error === 'string' && data.error) || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      if (data && data.ok === false && data.error) {
        throw new Error(String(data.error));
      }

      return data || { ok: true };
    },

    get(path, channel = '') {
      return this.request(path, { method: 'GET', channel });
    },

    post(path, body, channel = '') {
      return this.request(path, { method: 'POST', body, channel });
    },

    async openConversation(convId) {
      const cleanId = String(convId || '').trim();
      if (!cleanId) return;

      if (isSidecar && typeof window.sidecar?.ui?.toggleConversation === 'function') {
        try {
          await window.sidecar.ui.toggleConversation(cleanId);
          showToast('已在 Antigravity 主壳切换至目标会话', 'success');
          return;
        } catch (err) {
          const copied = await copyToClipboard(cleanId);
          showToast(
            copied
              ? `切换会话失败（${err?.message || '未知错误'}），已复制会话 ID`
              : `切换会话失败：${err?.message || '未知错误'}`,
            'warn',
            4200,
          );
          return;
        }
      }

      const copied = await copyToClipboard(cleanId);
      if (copied) {
        showToast(
          `已复制会话 ID（${cleanId.slice(0, 12)}…）— 独立 Web 模式请在 Antigravity 中切换打开`,
          'info',
          4000,
        );
      } else {
        showToast(`会话 ID：${cleanId}`, 'info', 4000);
      }
    },

    bindWorkspaceChange(onSynced) {
      if (!isSidecar || typeof window.sidecar?.onWorkspaceChange !== 'function') return;
      try {
        window.sidecar.onWorkspaceChange((rawUris) => {
          const list = Array.isArray(rawUris)
            ? rawUris
                .map((u) => (typeof u === 'string' ? u : u?.uri || u?.path || ''))
                .filter(Boolean)
            : typeof rawUris === 'string' && rawUris
              ? [rawUris]
              : [];
          if (list.length === 0) return;

          this.post('/api/workspace', {
            conversationId: this.getHostConversationId(),
            workspaceUris: list,
          })
            .then(() => {
              if (typeof onSynced === 'function') onSynced(list);
            })
            .catch(() => {});
        });
      } catch {
        // Ignore if host version lacks workspace listener
      }
    },
  };

  /* ========================================================================
     4. Host Theme Auto-Detection (Sidecar) & Manual Toggle (Standalone Web)
     ======================================================================== */

  const THEME_STORAGE_KEY = 'context-relay:theme';

  function computeColorLuminance(colorStr) {
    if (!colorStr) return null;
    const nums = (colorStr.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3 || nums.some((v) => !Number.isFinite(v))) return null;
    const scale = colorStr.startsWith('color(') ? 1 : 255;
    const r = nums[0] / scale;
    const g = nums[1] / scale;
    const b = nums[2] / scale;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function initThemeSync() {
    const btnTheme = $('btn-theme');

    if (isSidecar) {
      if (btnTheme) btnTheme.classList.add('hidden');

      const probe = document.createElement('span');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;color:var(--background, #ffffff);';
      document.documentElement.appendChild(probe);

      const syncHostTheme = () => {
        const computed = getComputedStyle(probe).color;
        const lum = computeColorLuminance(computed);
        if (lum === null) return;
        document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
      };

      syncHostTheme();
      const observer = new MutationObserver(syncHostTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style'],
      });
      return;
    }

    // Standalone Local Web mode: manual toggle persisted to localStorage
    if (btnTheme) btnTheme.classList.remove('hidden');

    let saved = '';
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY) || '';
    } catch {
      saved = '';
    }

    const applyWebTheme = (theme) => {
      document.documentElement.dataset.theme = theme;
      if (btnTheme) {
        btnTheme.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        btnTheme.title = theme === 'dark' ? '当前深色模式 — 点击切回浅色' : '当前浅色模式 — 点击切换深色';
      }
    };

    if (saved === 'dark' || saved === 'light') {
      applyWebTheme(saved);
    } else {
      const prefersDark =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyWebTheme(prefersDark ? 'dark' : 'light');
    }

    if (btnTheme) {
      btnTheme.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyWebTheme(next);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // Ignore storage errors
        }
      });
    }
  }

  /* ========================================================================
     5. Defensive Data Normalizers (Aligned with Backend Core Modules)
     ======================================================================== */

  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const projectId = String(raw.projectId || raw.id || '').trim();
    const primaryPath = String(raw.primaryPath || raw.workspacePath || raw.path || '').trim();
    const displayName =
      String(raw.displayName || raw.name || '').trim() ||
      fileBasename(primaryPath) ||
      projectId ||
      '未命名项目';
    if (!projectId && !primaryPath) return null;
    return {
      projectId: projectId || primaryPath,
      displayName,
      primaryPath,
      sessionCount: Number(raw.sessionCount) || 0,
      workspaceUris: Array.isArray(raw.workspaceUris) ? raw.workspaceUris : [],
    };
  }

  function normalizeItem(raw, turnId, idx) {
    const id = String(raw?.id ?? raw?.itemId ?? `${turnId}-item-${idx}`);
    const toolName = String(raw?.toolName || raw?.name || raw?.tool || 'step');
    const isError = Boolean(
      raw?.isError ||
        raw?.status === 'ERROR' ||
        raw?.status === 'error' ||
        (typeof raw?.exitCode === 'number' && raw.exitCode > 0),
    );
    const isWrite = Boolean(raw?.isWrite || raw?.category === 'write' || raw?.category === 'edit');
    const isRead = Boolean(raw?.isRead || raw?.category === 'read');
    const category =
      raw?.category ||
      (isWrite
        ? 'write'
        : isRead
          ? 'read'
          : /command|exec|shell|bash/i.test(toolName)
            ? 'command'
            : /search|grep|find/i.test(toolName)
              ? 'search'
              : 'other');

    const stepIndex =
      raw?.resultStepIndex !== null && raw?.resultStepIndex !== undefined
        ? Number(raw.resultStepIndex)
        : raw?.stepIndex !== null && raw?.stepIndex !== undefined
          ? Number(raw.stepIndex)
          : null;

    const bytes = Number(raw?.resultBytes ?? raw?.bytes ?? raw?.outputBytes ?? 0) || 0;
    const summary = String(
      raw?.actionSummary || raw?.summary || raw?.argSummary || raw?.targetPath || raw?.command || '',
    );

    return {
      id,
      turnId,
      toolName,
      category,
      isWrite,
      isRead,
      isError,
      isNoisy: Boolean(raw?.isNoisy),
      defaultInclude: raw?.defaultInclude !== undefined ? Boolean(raw.defaultInclude) : !raw?.isNoisy,
      isTruncated: Boolean(raw?.truncated || raw?.isTruncated),
      stepIndex: Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : null,
      bytes,
      summary,
      resultPreview: String(raw?.resultPreview || ''),
    };
  }

  function normalizeTurn(raw, idx) {
    const id = String(raw?.id ?? raw?.turnId ?? `turn-${idx + 1}`);
    const rawIndex = raw?.index ?? raw?.turnIndex;
    const index =
      typeof rawIndex === 'number' && Number.isFinite(rawIndex)
        ? rawIndex === 0 && idx === 0
          ? 1
          : rawIndex
        : idx + 1;

    const rawItems = Array.isArray(raw?.items) ? raw.items : [];
    const items = rawItems.map((it, i) => normalizeItem(it, id, i));

    let editCount = 0;
    let readCount = 0;
    let cmdCount = 0;
    let errCount = 0;
    for (const it of items) {
      if (it.isWrite || it.category === 'write') editCount += 1;
      else if (it.isRead || it.category === 'read' || it.category === 'search') readCount += 1;
      else if (it.category === 'command') cmdCount += 1;
      if (it.isError) errCount += 1;
    }
    if (typeof raw?.errorCount === 'number' && raw.errorCount > errCount) {
      errCount = raw.errorCount;
    }

    const deltaTokens =
      Number(raw?.deltaContextTokens ?? raw?.deltaTokens ?? raw?.estimatedTurnTokens ?? raw?.estimatedTokens ?? 0) ||
      0;

    let noiseRatio = Number(raw?.noiseRatio);
    if (!Number.isFinite(noiseRatio)) {
      noiseRatio = raw?.isNoisy ? 0.85 : 0;
    } else if (noiseRatio > 1 && noiseRatio <= 100) {
      noiseRatio = noiseRatio / 100;
    }
    noiseRatio = Math.max(0, Math.min(1, noiseRatio));

    return {
      id,
      index,
      userText: String(raw?.userText || raw?.userSummary || '(无用户输入摘要)'),
      assistantText: String(raw?.assistantText || raw?.assistantSummary || ''),
      deltaTokens,
      estimatedTurnTokens: Number(raw?.estimatedTurnTokens ?? raw?.estimatedTokens ?? 0) || 0,
      noiseRatio,
      isNoisy: Boolean(raw?.isNoisy),
      filesModified: Array.isArray(raw?.filesModified) ? raw.filesModified : [],
      filesRead: Array.isArray(raw?.filesRead) ? raw.filesRead : [],
      counts: {
        edit: editCount,
        read: readCount,
        command: cmdCount,
        error: errCount,
      },
      items,
    };
  }

  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sessionId = String(raw.sessionId || raw.id || raw.conversationId || '').trim();
    if (!sessionId) return null;

    const rawTurns = Array.isArray(raw.turns) ? raw.turns : [];
    const turns = rawTurns.map((t, i) => normalizeTurn(t, i));

    let modified = [];
    let read = [];
    if (raw.filesTouched && typeof raw.filesTouched === 'object' && !Array.isArray(raw.filesTouched)) {
      modified = Array.isArray(raw.filesTouched.modified) ? raw.filesTouched.modified : [];
      read = Array.isArray(raw.filesTouched.read) ? raw.filesTouched.read : [];
    } else {
      if (Array.isArray(raw.filesModified)) modified = raw.filesModified;
      if (Array.isArray(raw.filesRead)) read = raw.filesRead;
    }

    return {
      sessionId,
      title: String(raw.title || `会话 ${sessionId.slice(0, 8)}`),
      projectId: String(raw.projectId || ''),
      workspacePath: String(raw.workspacePath || raw.primaryPath || ''),
      lastModel: String(raw.lastModel || raw.model || raw.firstModel || ''),
      firstModel: String(raw.firstModel || ''),
      modelsUsed: Array.isArray(raw.modelsUsed) ? raw.modelsUsed : [],
      peakContextTokens: Number(raw.peakContextTokens) || 0,
      turnCount: Number(raw.turnCount ?? turns.length) || turns.length,
      updatedAt: raw.updatedAt || raw.mtimeMs || null,
      createdAt: raw.createdAt || null,
      isSubagent: Boolean(raw.isSubagent),
      parentSessionId: String(raw.parentSessionId || ''),
      filesTouched: { modified, read },
      turns,
    };
  }

  function normalizeBundle(res) {
    const b = res?.bundle || res || {};
    const markdown = String(b.markdown ?? b.content ?? b.text ?? '');
    const bytes = Number(b.bytes ?? b.sizeBytes ?? utf8ByteLength(markdown)) || 0;
    const inlineLimitBytes = Number(res?.inlineLimitBytes) || 10 * 1024;
    const estimatedTokens = Number(b.estimatedTokens ?? b.tokens ?? Math.ceil(bytes / 3.5)) || 0;
    const originalPeakTokens =
      Number(b.originalPeakTokens ?? state.currentSession?.peakContextTokens ?? 0) || 0;
    const savedPercent =
      typeof b.savedPercent === 'number' && Number.isFinite(b.savedPercent)
        ? Math.round(b.savedPercent)
        : originalPeakTokens > 0
          ? Math.max(0, Math.min(99, Math.round((1 - estimatedTokens / originalPeakTokens) * 100)))
          : 0;
    const redactionCount = Number(b.redactionCount ?? b.redactedCount ?? b.redactions ?? 0) || 0;
    const recommendFileMode =
      b.recommendFileMode !== undefined ? Boolean(b.recommendFileMode) : bytes > inlineLimitBytes;

    return {
      markdown,
      bytes,
      inlineLimitBytes,
      estimatedTokens,
      originalPeakTokens,
      savedPercent,
      redactionCount,
      recommendFileMode,
    };
  }

  /* ========================================================================
     6. Application State
     ======================================================================== */

  const state = {
    activeTab: 'surgery',
    agentApiAvailable: true,
    hostConversationId: HostBridge.getHostConversationId(),
    projects: [],
    models: [],
    sessionsCount: 0,

    // Tab 1: Surgery
    currentSession: null,
    gitAnchor: null,
    activePreset: 'smart-clean',
    selectedTurnIds: new Set(),
    selectedItemIds: new Set(),
    expandedTurnIds: new Set(),
    expandFullStepIds: new Set(), // stepIndex strings included in bundle
    visibleFullSteps: new Set(),  // `${sessionId}:${stepIndex}` boxes open in UI
    fullStepCache: new Map(),     // `${sessionId}:${stepIndex}` -> full content string
    loadingFullSteps: new Set(),
    options: {
      includeAssistantReplies: true,
      includeToolDetails: true,
      includeFilesTouched: true,
      includeGitAnchor: true,
      redact: true,
    },
    filesExpanded: false,
    lpConfigOpen: false,
    titleDirty: false,
    projectSelectionDirty: false,
    latestBundle: null,
    previewDirty: false,
    previewLoading: false,
    launching: false,
    exporting: false,
    syncing: false,
    coldSyncAttempted: false,

    // Tab 2: Sessions Radar
    radar: {
      q: '',
      projectId: '',
      model: '',
      hideSubagents: true,
      sessions: [],
      total: 0,
      loaded: false,
      loading: false,
    },

    // Tab 3: Lineage & Archives
    lineage: [],
    archives: [],
    lineageLoaded: false,

    // Modal
    modalContent: '',
  };

  /* ========================================================================
     7. Preview & Surgery Selection Logic
     ======================================================================== */

  function applySelection(selection, session = state.currentSession) {
    state.selectedTurnIds.clear();
    state.selectedItemIds.clear();
    const turns = Array.isArray(selection?.selectedTurnIds) ? selection.selectedTurnIds : [];
    const items = Array.isArray(selection?.selectedItemIds) ? selection.selectedItemIds : [];

    if (session && Array.isArray(session.turns)) {
      const validTurns = new Set(session.turns.map((t) => t.id));
      const validItems = new Set();
      for (const t of session.turns) {
        for (const it of t.items) validItems.add(it.id);
      }
      for (const id of turns) {
        const s = String(id);
        if (validTurns.has(s)) state.selectedTurnIds.add(s);
      }
      for (const id of items) {
        const s = String(id);
        if (validItems.has(s)) state.selectedItemIds.add(s);
      }
      return;
    }

    for (const id of turns) state.selectedTurnIds.add(String(id));
    for (const id of items) state.selectedItemIds.add(String(id));
  }

  function reconcileSelectionOnRefresh(prevSession, freshSession, defaultSelection) {
    const prevTurnIds = new Set((prevSession?.turns || []).map((t) => t.id));
    const prevItemIds = new Set();
    for (const t of prevSession?.turns || []) {
      for (const it of t.items) prevItemIds.add(it.id);
    }

    const validTurnIds = new Set();
    const validItemIds = new Set();
    const validStepKeys = new Set();
    for (const t of freshSession?.turns || []) {
      validTurnIds.add(t.id);
      for (const it of t.items) {
        validItemIds.add(it.id);
        if (it.stepIndex !== null) validStepKeys.add(String(it.stepIndex));
      }
    }

    const defTurnIds = new Set((defaultSelection?.selectedTurnIds || []).map(String));
    const defItemIds = new Set((defaultSelection?.selectedItemIds || []).map(String));

    const nextTurns = new Set();
    for (const id of state.selectedTurnIds) {
      if (validTurnIds.has(id)) nextTurns.add(id);
    }
    for (const t of freshSession?.turns || []) {
      if (!prevTurnIds.has(t.id) && defTurnIds.has(t.id)) {
        nextTurns.add(t.id);
      }
    }

    const nextItems = new Set();
    for (const id of state.selectedItemIds) {
      if (validItemIds.has(id)) nextItems.add(id);
    }
    for (const t of freshSession?.turns || []) {
      for (const it of t.items) {
        if (!prevItemIds.has(it.id) && defItemIds.has(it.id)) {
          nextItems.add(it.id);
        }
      }
    }

    state.selectedTurnIds = nextTurns;
    state.selectedItemIds = nextItems;

    for (const id of Array.from(state.expandedTurnIds)) {
      if (!validTurnIds.has(id)) state.expandedTurnIds.delete(id);
    }
    for (const stepKey of Array.from(state.expandFullStepIds)) {
      if (!validStepKeys.has(stepKey)) state.expandFullStepIds.delete(stepKey);
    }
  }

  function computeLocalPreset(session, preset) {
    const turns = session?.turns || [];
    const selectedTurnIds = [];
    const selectedItemIds = [];
    if (!turns.length || preset === 'none') {
      return { selectedTurnIds, selectedItemIds };
    }
    if (preset === 'all') {
      for (const t of turns) {
        selectedTurnIds.push(t.id);
        for (const it of t.items) selectedItemIds.push(it.id);
      }
      return { selectedTurnIds, selectedItemIds };
    }
    if (preset === 'backbone') {
      const recentStart = Math.max(1, turns.length - 2);
      for (const t of turns) {
        if (t.index === 1 || t.index >= recentStart || t.filesModified.length > 0) {
          selectedTurnIds.push(t.id);
          for (const it of t.items) {
            if (it.isWrite) selectedItemIds.push(it.id);
          }
        }
      }
      return { selectedTurnIds, selectedItemIds };
    }
    // smart-clean
    for (const t of turns) {
      selectedTurnIds.push(t.id);
      for (const it of t.items) {
        if (it.defaultInclude) selectedItemIds.push(it.id);
      }
    }
    return { selectedTurnIds, selectedItemIds };
  }

  function findMatchingProjectForSession(sess) {
    if (!sess || state.projects.length === 0) return null;
    if (sess.projectId) {
      const byId = state.projects.find((p) => p.projectId === sess.projectId);
      if (byId) return byId;
    }
    const wsNorm = normalizePathLower(sess.workspacePath);
    if (wsNorm) {
      const byPath = state.projects.find((p) => normalizePathLower(p.primaryPath) === wsNorm);
      if (byPath) return byPath;
    }
    return null;
  }

  function getSelectedTargetProject() {
    const sel = $('lp-project');
    const projectId = sel ? sel.value : '';
    const match = projectId ? state.projects.find((p) => p.projectId === projectId) || null : null;
    const sessionWs = state.currentSession?.workspacePath || '';
    return {
      projectId: match ? match.projectId : '',
      workspacePath: match?.primaryPath || sessionWs,
      displayName: match
        ? match.displayName
        : sessionWs
          ? `${fileBasename(sessionWs)}（当前会话）`
          : '沿用当前会话目录',
    };
  }

  function buildPreviewPayload() {
    const sess = state.currentSession;
    if (!sess) return null;
    const target = getSelectedTargetProject();
    const extraEl = $('lp-instruction');

    return {
      id: sess.sessionId,
      selectedTurnIds: Array.from(state.selectedTurnIds),
      selectedItemIds: Array.from(state.selectedItemIds),
      includeAssistantReplies: state.options.includeAssistantReplies,
      includeToolDetails: state.options.includeToolDetails,
      includeFilesTouched: state.options.includeFilesTouched,
      includeGitAnchor: state.options.includeGitAnchor,
      redact: state.options.redact,
      extraInstruction: extraEl ? extraEl.value.trim() : '',
      targetWorkspace: target.workspacePath,
      expandFullStepIds: Array.from(state.expandFullStepIds),
    };
  }

  const debouncedPreview = debounce(() => {
    runPreviewNow();
  }, 160);

  function schedulePreview() {
    state.previewDirty = true;
    debouncedPreview();
  }

  async function runPreviewNow() {
    debouncedPreview.cancel();
    const payload = buildPreviewPayload();
    if (!payload) return null;

    state.previewDirty = false;
    state.previewLoading = true;
    renderLaunchpadTelemetry();

    try {
      const res = await HostBridge.post('/api/preview', payload, 'preview');
      if (res?._stale) return null;
      state.latestBundle = normalizeBundle(res);
      state.previewLoading = false;
      renderLaunchpadTelemetry();
      return state.latestBundle;
    } catch (err) {
      state.previewLoading = false;
      renderLaunchpadTelemetry();
      showToast(`预览计算失败：${err?.message || '网络错误'}`, 'error');
      return null;
    }
  }

  /* ========================================================================
     8. Data Loading Actions
     ======================================================================== */

  function updateProjectsAndModels(projects, models) {
    if (Array.isArray(projects)) {
      const normalized = [];
      const seen = new Set();
      for (const raw of projects) {
        const p = normalizeProject(raw);
        if (!p || seen.has(p.projectId)) continue;
        seen.add(p.projectId);
        normalized.push(p);
      }
      state.projects = normalized;
    }

    if (Array.isArray(models)) {
      const seen = new Set();
      const cleaned = [];
      for (const m of models) {
        const s = String(m || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        cleaned.push(s);
      }
      state.models = cleaned;
    }

    renderProjectSelectors();
    renderModelOptions();
  }

  function defaultRelayTitleForSession(sess) {
    const baseTitle = sess.title.replace(/^\[Relay\]\s*/i, '').trim() || sess.title;
    return `[Relay] ${baseTitle}`;
  }

  function hydrateSessionIntoSurgery(rawSession, defaultSelection, gitAnchor) {
    const sess = normalizeSession(rawSession);
    state.currentSession = sess;
    state.gitAnchor = gitAnchor || null;
    state.expandedTurnIds.clear();
    state.expandFullStepIds.clear();
    state.visibleFullSteps.clear();
    state.latestBundle = null;
    state.previewDirty = false;
    state.titleDirty = false;
    state.projectSelectionDirty = false;

    if (!sess) {
      renderProjectSelectors();
      renderSurgeryView();
      return;
    }

    if (defaultSelection && Array.isArray(defaultSelection.selectedTurnIds)) {
      applySelection(defaultSelection, sess);
    } else {
      applySelection(computeLocalPreset(sess, state.activePreset), sess);
    }

    // Populate launchpad form defaults for this session
    const titleInput = $('lp-title');
    if (titleInput && !state.titleDirty) {
      titleInput.value = defaultRelayTitleForSession(sess);
    }

    const modelInput = $('lp-model');
    if (modelInput) {
      modelInput.value = sess.lastModel || sess.firstModel || 'pro';
    }

    selectMatchingProjectForSession(sess);
    renderSurgeryView();
    runPreviewNow();
  }

  function selectMatchingProjectForSession(sess) {
    renderProjectSelectors();
    const sel = $('lp-project');
    if (!sel || !sess) return;

    const matched = findMatchingProjectForSession(sess);
    sel.value = matched ? matched.projectId : '';
    updateLaunchpadConfigSummary();
  }

  async function loadInitialState({ noSync = 1 } = {}) {
    const hostId = HostBridge.getHostConversationId();
    state.hostConversationId = hostId;

    const qs = new URLSearchParams();
    if (hostId) qs.set('conversationId', hostId);
    qs.set('noSync', String(noSync));

    try {
      const res = await HostBridge.get(`/api/state?${qs.toString()}`, 'state');
      if (res?._stale) return;

      if (typeof res.hostConversationId === 'string' && res.hostConversationId) {
        state.hostConversationId = res.hostConversationId;
      }
      state.agentApiAvailable = res.agentApiAvailable !== false;
      state.sessionsCount = Number(res.sessionsCount) || 0;

      updateProjectsAndModels(res.projects, res.models);
      updateNavBadges();
      updateLaunchpadCapabilities();

      // Cold-start fallback: if index is empty on first noSync=1 paint, trigger one incremental sync
      if (noSync === 1 && !res.currentSession && state.sessionsCount === 0 && !state.coldSyncAttempted) {
        state.coldSyncAttempted = true;
        return loadInitialState({ noSync: 0 });
      }

      $('surgery-loading')?.classList.add('hidden');
      state.activePreset = 'smart-clean';
      hydrateSessionIntoSurgery(res.currentSession, res.defaultSelection, res.gitAnchor);

      // Load lineage badge count quietly in background
      loadLineage({ silent: true });
    } catch (err) {
      $('surgery-loading')?.classList.add('hidden');
      renderSurgeryView();
      showToast(`初始化载入失败：${err?.message || '服务未响应'}`, 'error', 4200);
    }
  }

  async function loadSessionById(
    sessionId,
    { preset = 'smart-clean', switchToSurgery = false, isPresetSwitch = false, isRefresh = false } = {},
  ) {
    const cleanId = String(sessionId || '').trim();
    if (!cleanId) return;

    const qs = new URLSearchParams({ id: cleanId });
    if (preset) qs.set('preset', preset);

    try {
      const res = await HostBridge.get(`/api/session?${qs.toString()}`, 'session');
      if (res?._stale) return;

      const prevSession = state.currentSession;
      const isSameSession = Boolean(prevSession && prevSession.sessionId === cleanId);
      const freshSession = normalizeSession(res.session);

      if (Array.isArray(res.projects)) {
        updateProjectsAndModels(res.projects, null);
      }

      if (isSameSession && freshSession && isPresetSwitch) {
        // Preset switch on the same session: update session & anchor, replace selection with preset
        state.currentSession = freshSession;
        state.gitAnchor = res.gitAnchor || null;
        state.activePreset = preset || 'smart-clean';
        applySelection(res.defaultSelection || computeLocalPreset(freshSession, state.activePreset), freshSession);
        renderProjectSelectors();
        renderHealthCard();
        renderFilesCard();
        renderPresetButtons();
        renderTurnList();
        updateNavBadges();
        runPreviewNow();
      } else if (isSameSession && freshSession && (isRefresh || switchToSurgery)) {
        // Same-session refresh: update session, gitAnchor, projects while preserving user selections & custom title
        state.currentSession = freshSession;
        state.gitAnchor = res.gitAnchor || null;
        reconcileSelectionOnRefresh(prevSession, freshSession, res.defaultSelection);
        const titleInput = $('lp-title');
        if (titleInput && !state.titleDirty) {
          titleInput.value = defaultRelayTitleForSession(freshSession);
        }
        renderProjectSelectors();
        renderHealthCard();
        renderFilesCard();
        renderPresetButtons();
        renderTurnList();
        updateNavBadges();
        runPreviewNow();
      } else {
        state.activePreset = preset || 'smart-clean';
        hydrateSessionIntoSurgery(res.session, res.defaultSelection, res.gitAnchor);
      }

      if (switchToSurgery) {
        setActiveTab('surgery');
        window.scrollTo(0, 0);
      }
    } catch (err) {
      showToast(`载入会话失败：${err?.message || '未知错误'}`, 'error');
    }
  }

  async function loadSessionsRadar() {
    state.radar.loading = true;
    const qs = new URLSearchParams();
    if (state.radar.q.trim()) qs.set('q', state.radar.q.trim());
    if (state.radar.projectId) qs.set('projectId', state.radar.projectId);
    if (state.radar.model) qs.set('model', state.radar.model);
    qs.set('hideSubagents', state.radar.hideSubagents ? '1' : '0');
    qs.set('limit', '80');
    qs.set('noSync', '1');

    try {
      const res = await HostBridge.get(`/api/sessions?${qs.toString()}`, 'sessions');
      if (res?._stale) return;

      state.radar.loading = false;
      state.radar.loaded = true;
      state.radar.sessions = Array.isArray(res.sessions)
        ? res.sessions.map((s) => normalizeSession(s)).filter(Boolean)
        : [];
      state.radar.total = Number(res.total ?? state.radar.sessions.length) || 0;

      if (!state.radar.q && !state.radar.projectId && !state.radar.model) {
        state.sessionsCount = state.radar.total;
      }

      updateProjectsAndModels(res.projects, res.models);
      updateNavBadges();
      renderSessionsRadar();
    } catch (err) {
      state.radar.loading = false;
      showToast(`获取会话列表失败：${err?.message || '未知错误'}`, 'error');
    }
  }

  async function loadLineage({ silent = false } = {}) {
    try {
      const res = await HostBridge.get('/api/lineage', 'lineage');
      if (res?._stale) return;

      state.lineage = Array.isArray(res.lineage) ? res.lineage : [];
      state.archives = Array.isArray(res.archives) ? res.archives : [];
      state.lineageLoaded = true;
      updateNavBadges();
      if (state.activeTab === 'lineage') {
        renderLineageTab();
      }
    } catch (err) {
      if (!silent) {
        showToast(`加载血缘与档案失败：${err?.message || '未知错误'}`, 'error');
      }
    }
  }

  async function triggerSync({ force = true } = {}) {
    if (state.syncing) return;
    state.syncing = true;
    const btnSync = $('btn-sync');
    if (btnSync) {
      btnSync.classList.add('spinning');
      btnSync.disabled = true;
    }

    try {
      const res = await HostBridge.post('/api/sync', { force, enrichProjects: true });
      if (Array.isArray(res?.projects)) {
        updateProjectsAndModels(res.projects, null);
      }

      if (state.currentSession) {
        await loadSessionById(state.currentSession.sessionId, {
          preset: state.activePreset || 'smart-clean',
          switchToSurgery: false,
          isRefresh: true,
        });
      } else {
        await loadInitialState({ noSync: 1 });
      }

      if (state.radar.loaded || state.activeTab === 'sessions') {
        await loadSessionsRadar();
      }
      await loadLineage({ silent: true });

      const added = Number(res?.sync?.indexed ?? res?.sync?.updated ?? 0);
      showToast(added > 0 ? `索引刷新完成（更新 ${added} 条会话）` : '索引与项目列表已刷新', 'success');
    } catch (err) {
      showToast(`刷新索引失败：${err?.message || '未知错误'}`, 'error');
    } finally {
      state.syncing = false;
      if (btnSync) {
        btnSync.classList.remove('spinning');
        btnSync.disabled = false;
      }
    }
  }

  async function handleExpandFullStep(item, turnId) {
    const sess = state.currentSession;
    if (!sess || item.stepIndex === null) return;

    const cacheKey = `${sess.sessionId}:${item.stepIndex}`;
    const stepKey = String(item.stepIndex);

    // Toggle off if already expanded & included
    if (state.expandFullStepIds.has(stepKey) && state.visibleFullSteps.has(cacheKey)) {
      state.expandFullStepIds.delete(stepKey);
      state.visibleFullSteps.delete(cacheKey);
      renderTurnList();
      schedulePreview();
      return;
    }

    // Ensure parent turn and item are selected so full step actually enters bundle
    state.selectedTurnIds.add(turnId);
    state.selectedItemIds.add(item.id);
    state.activePreset = '';

    if (state.fullStepCache.has(cacheKey)) {
      state.expandFullStepIds.add(stepKey);
      state.visibleFullSteps.add(cacheKey);
      renderPresetButtons();
      renderTurnList();
      updateNavBadges();
      schedulePreview();
      return;
    }

    state.loadingFullSteps.add(cacheKey);
    renderTurnList();

    try {
      const qs = new URLSearchParams({
        id: sess.sessionId,
        stepIndex: String(item.stepIndex),
      });
      const res = await HostBridge.get(`/api/step-full?${qs.toString()}`);
      const content =
        typeof res?.content === 'string'
          ? res.content
          : typeof res?.step?.content === 'string'
            ? res.step.content
            : '(该步骤全文为空)';

      state.fullStepCache.set(cacheKey, content);
      state.expandFullStepIds.add(stepKey);
      state.visibleFullSteps.add(cacheKey);
      showToast(`已载入 step#${item.stepIndex} 全文并纳入交接包`, 'success');
      schedulePreview();
    } catch (err) {
      showToast(`展开全文失败：${err?.message || '未找到完整日志'}`, 'error');
    } finally {
      state.loadingFullSteps.delete(cacheKey);
      renderPresetButtons();
      renderTurnList();
      updateNavBadges();
    }
  }

  /* ========================================================================
     9. Launchpad Actions (Launch / Copy / Preview / Export)
     ======================================================================== */

  async function handleLaunch() {
    if (state.launching) return;
    if (!isSidecar || !state.agentApiAvailable) {
      showToast('需在 Antigravity 侧栏内一键启动新会话；请改用「复制交接包」或「导出 MD」', 'warn', 4000);
      return;
    }

    const basePayload = buildPreviewPayload();
    if (!basePayload) return;

    if (basePayload.selectedTurnIds.length === 0) {
      showToast('请至少勾选 1 轮对话后再启动接力会话', 'warn');
      return;
    }

    const target = getSelectedTargetProject();
    const model = ($('lp-model')?.value || '').trim() || state.currentSession?.lastModel || 'pro';
    const title = ($('lp-title')?.value || '').trim() || `[Relay] ${state.currentSession?.title || '新会话'}`;

    state.launching = true;
    const btn = $('btn-launch');
    if (btn) {
      btn.disabled = true;
      btn.lastElementChild.textContent = '正在拉起新会话…';
    }

    try {
      const res = await HostBridge.post('/api/launch', {
        ...basePayload,
        targetProjectId: target.projectId,
        model,
        title,
        preset: state.activePreset || 'custom',
        mode: 'auto',
      });

      const modeText = res?.launchMode === 'file' ? '落盘移交' : '直传内联';
      const savedText = typeof res?.savedPercent === 'number' ? `减负 ${Math.round(res.savedPercent)}%` : '已剪枝';
      showToast(`新会话已启动（${savedText} · ${modeText}）`, 'success', 4200);

      loadLineage({ silent: true });

      if (res?.conversationId) {
        await HostBridge.openConversation(res.conversationId);
      }
    } catch (err) {
      showToast(`启动新会话失败：${err?.message || '宿主接口报错'}`, 'error', 4800);
    } finally {
      state.launching = false;
      if (btn) {
        btn.lastElementChild.textContent = '启动新会话并跳转';
      }
      updateLaunchpadCapabilities();
    }
  }

  async function handleCopyBundle() {
    const needsFresh =
      debouncedPreview.isPending() ||
      state.previewLoading ||
      state.previewDirty ||
      !state.latestBundle;
    const bundle = needsFresh ? await runPreviewNow() : state.latestBundle;
    if (!bundle || !bundle.markdown) {
      showToast('当前没有可复制的交接包内容', 'warn');
      return;
    }

    const ok = await copyToClipboard(bundle.markdown);
    if (ok) {
      showToast(
        `已复制交接包（${fmtBytes(bundle.bytes)} · ~${fmtTokens(bundle.estimatedTokens)} tokens）`,
        'success',
      );
    } else {
      showToast('剪贴板写入被拒绝，请点击「预览」手动复制', 'warn');
    }
  }

  async function handleOpenPreview() {
    const bundle = await runPreviewNow();
    if (!bundle) return;

    const badges = [
      { text: fmtBytes(bundle.bytes), cls: '' },
      { text: `~${fmtTokens(bundle.estimatedTokens)} tokens`, cls: '' },
      { text: `减负 ${bundle.savedPercent}%`, cls: 'pill-ok' },
    ];
    if (bundle.redactionCount > 0) {
      badges.push({ text: `脱敏 ${bundle.redactionCount} 处`, cls: 'pill-redact' });
    }
    if (bundle.recommendFileMode) {
      badges.push({ text: '>10 KB 自动落盘移交', cls: 'pill-warn' });
    }

    openModal({
      title: `交接包预览 — ${state.currentSession?.title || ''}`,
      content: bundle.markdown,
      badges,
      filePath: state.currentSession?.workspacePath || '',
    });
  }

  async function handleExportMarkdown() {
    if (state.exporting) return;
    const basePayload = buildPreviewPayload();
    if (!basePayload) return;

    const title = ($('lp-title')?.value || '').trim() || state.currentSession?.title || 'handoff';
    state.exporting = true;
    const btn = $('btn-export');
    if (btn) btn.disabled = true;

    try {
      const res = await HostBridge.post('/api/export', {
        ...basePayload,
        title,
      });

      const fname = res?.filename || fileBasename(res?.filePath) || 'handoff.md';
      showToast(`已导出 ${fname}（${fmtBytes(res?.bytes || 0)}）`, 'success', 4200);
      loadLineage({ silent: true });
    } catch (err) {
      showToast(`导出 Markdown 失败：${err?.message || '写入错误'}`, 'error');
    } finally {
      state.exporting = false;
      if (btn) btn.disabled = false;
    }
  }

  async function openArchivePreview(filename, { copyOnly = false } = {}) {
    const clean = String(filename || '').trim();
    if (!clean) return;

    try {
      const qs = new URLSearchParams({ filename: clean });
      const res = await HostBridge.get(`/api/archive?${qs.toString()}`);
      const content = String(res?.content || '');

      if (copyOnly) {
        const ok = await copyToClipboard(content);
        showToast(ok ? `已复制档案 ${clean}` : '复制失败，请预览后手动复制', ok ? 'success' : 'warn');
        return;
      }

      openModal({
        title: res?.filename || clean,
        content,
        badges: [{ text: fmtBytes(res?.size ?? utf8ByteLength(content)), cls: '' }],
        filePath: res?.filePath || '',
      });
    } catch (err) {
      showToast(`读取档案失败：${err?.message || '文件不存在'}`, 'error');
    }
  }

  /* ========================================================================
     10. Rendering Functions (Zero Raw HTML Injection)
     ======================================================================== */

  function updateNavBadges() {
    const badgeSurgery = $('badge-surgery');
    const badgeSessions = $('badge-sessions');
    const badgeLineage = $('badge-lineage');

    if (badgeSurgery) {
      const totalTurns = state.currentSession?.turns?.length || 0;
      badgeSurgery.textContent =
        totalTurns > 0 ? `${state.selectedTurnIds.size}/${totalTurns}` : '0';
    }
    if (badgeSessions) {
      badgeSessions.textContent = String(state.sessionsCount || state.radar.total || 0);
    }
    if (badgeLineage) {
      badgeLineage.textContent = String(state.lineage.length + state.archives.length);
    }
  }

  function updateLaunchpadCapabilities() {
    const lp = $('launchpad');
    const btnLaunch = $('btn-launch');
    const hint = $('lp-web-hint');

    const canLaunch = isSidecar && state.agentApiAvailable;

    if (lp) {
      lp.classList.toggle('promote-offline', !canLaunch);
    }
    if (btnLaunch) {
      btnLaunch.disabled = !canLaunch || state.launching;
      if (!isSidecar) {
        btnLaunch.title = '需在 Antigravity 侧栏内一键启动新会话；独立 Web 模式请使用「复制交接包」或「导出 MD」';
      } else if (!state.agentApiAvailable) {
        btnLaunch.title = '当前宿主未暴露 Agent API，请改用「复制交接包」或「导出 MD」';
      } else {
        btnLaunch.title = '自动剪枝并启动新会话，完成后立即跳转';
      }
    }
    if (hint) {
      if (!isSidecar) {
        hint.textContent = '独立 Web 模式不支持一键拉起宿主会话，已高亮「复制交接包」与「导出 MD」。';
        hint.classList.remove('hidden');
      } else if (!state.agentApiAvailable) {
        hint.textContent = '未检测到宿主 Agent API，请使用「复制交接包」或「导出 MD」接力。';
        hint.classList.remove('hidden');
      } else {
        hint.classList.add('hidden');
      }
    }
  }

  function renderProjectSelectors() {
    const lpSelect = $('lp-project');
    const radarSelect = $('radar-project');

    if (lpSelect) {
      const prevVal = lpSelect.value;
      const matched = findMatchingProjectForSession(state.currentSession);
      lpSelect.innerHTML = '';

      if (!matched) {
        const fallbackOpt = document.createElement('option');
        fallbackOpt.value = '';
        fallbackOpt.textContent = '沿用当前会话目录（未在已知项目列表）';
        lpSelect.appendChild(fallbackOpt);
      }

      for (const p of state.projects) {
        const opt = document.createElement('option');
        opt.value = p.projectId;
        opt.textContent = p.primaryPath ? `${p.displayName} — ${p.primaryPath}` : p.displayName;
        lpSelect.appendChild(opt);
      }

      if (
        state.projectSelectionDirty &&
        prevVal &&
        state.projects.some((p) => p.projectId === prevVal)
      ) {
        lpSelect.value = prevVal;
      } else if (state.projectSelectionDirty && prevVal === '' && !matched) {
        lpSelect.value = '';
      } else if (matched) {
        lpSelect.value = matched.projectId;
      } else {
        lpSelect.value = '';
      }
      updateLaunchpadConfigSummary();
    }

    if (radarSelect) {
      const prevVal = radarSelect.value;
      radarSelect.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = '全部项目';
      radarSelect.appendChild(allOpt);

      for (const p of state.projects) {
        const opt = document.createElement('option');
        opt.value = p.projectId;
        opt.textContent =
          p.sessionCount > 0 ? `${p.displayName} (${p.sessionCount})` : p.displayName;
        radarSelect.appendChild(opt);
      }
      radarSelect.value = prevVal;
    }
  }

  function renderModelOptions() {
    const datalist = $('model-options');
    const radarModel = $('radar-model');
    const baseModels = ['pro', 'flash', 'flash_lite'];
    const merged = [...baseModels];
    const seen = new Set(baseModels);
    for (const m of state.models) {
      if (!seen.has(m)) {
        seen.add(m);
        merged.push(m);
      }
    }

    if (datalist) {
      datalist.innerHTML = '';
      for (const m of merged) {
        const opt = document.createElement('option');
        opt.value = m;
        datalist.appendChild(opt);
      }
    }

    if (radarModel) {
      const prev = radarModel.value;
      radarModel.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = '全部模型';
      radarModel.appendChild(allOpt);

      for (const m of state.models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        radarModel.appendChild(opt);
      }
      radarModel.value = prev;
    }
  }

  function updateLaunchpadConfigSummary() {
    const summaryEl = $('lp-config-summary');
    if (!summaryEl) return;
    const target = getSelectedTargetProject();
    const model = ($('lp-model')?.value || '').trim() || 'pro';
    summaryEl.textContent = `${target.displayName} · ${model}`;
  }

  function renderSurgeryView() {
    const emptyEl = $('surgery-empty');
    const layoutEl = $('surgery-layout');
    const sess = state.currentSession;

    if (!sess) {
      emptyEl?.classList.remove('hidden');
      layoutEl?.classList.add('hidden');
      updateNavBadges();
      return;
    }

    emptyEl?.classList.add('hidden');
    layoutEl?.classList.remove('hidden');

    renderHealthCard();
    renderPresetButtons();
    renderFilesCard();
    renderTurnList();
    renderLaunchpadTelemetry();
    updateLaunchpadCapabilities();
    updateLaunchpadConfigSummary();
    updateNavBadges();
  }

  function renderHealthCard() {
    const sess = state.currentSession;
    if (!sess) return;

    const titleEl = $('health-title');
    if (titleEl) {
      titleEl.textContent = sess.title;
      titleEl.title = `${sess.title}\nID: ${sess.sessionId}`;
    }

    const pathEl = $('health-path');
    if (pathEl) {
      pathEl.textContent = shortPath(sess.workspacePath, 2);
      pathEl.title = sess.workspacePath || '未记录工作区路径';
    }

    const modelEl = $('health-model');
    if (modelEl) {
      modelEl.textContent = sess.lastModel || '未知模型';
      modelEl.title =
        sess.modelsUsed.length > 1 ? `使用过的模型：${sess.modelsUsed.join(', ')}` : modelEl.textContent;
    }

    // "在主壳打开" shown when viewing a session different from host current conversation
    const btnHost = $('btn-open-host');
    if (btnHost) {
      const showOpenBtn = Boolean(
        sess.sessionId &&
          (!state.hostConversationId || sess.sessionId !== state.hostConversationId),
      );
      btnHost.classList.toggle('hidden', !showOpenBtn);
      btnHost.textContent = isSidecar ? '在主壳打开' : '复制会话 ID';
    }

    // Waterline bar
    const peak = sess.peakContextTokens;
    const { level, label } = tokenLevel(peak);
    const pct = Math.min(100, Math.max(peak > 0 ? 3 : 0, (peak / 200_000) * 100));

    const tokEl = $('waterline-tokens');
    if (tokEl) tokEl.textContent = peak > 0 ? `${fmtTokens(peak)} tokens` : '0 tokens';

    const stEl = $('waterline-status');
    if (stEl) {
      stEl.textContent = label;
      stEl.className = `pill pill-status pill-${level}`;
    }

    const turnsEl = $('waterline-turns');
    if (turnsEl) turnsEl.textContent = `${sess.turns.length} 轮`;

    const fillEl = $('waterline-fill');
    if (fillEl) {
      fillEl.style.width = `${pct.toFixed(1)}%`;
      fillEl.className = `progress-fill level-${level}`;
    }

    // Compact Git Anchor
    const gitBar = $('git-anchor-bar');
    const g = state.gitAnchor;
    if (gitBar) {
      if (g && (g.isGitRepo || g.branch || g.headSha)) {
        gitBar.classList.remove('hidden');
        const branch = String(g.branch || 'HEAD');
        const sha = String(g.headSha || g.sha || g.commit || '').slice(0, 8);
        const dirty = (Number(g.dirtyCount) || 0) + (Number(g.untrackedCount) || 0);

        const refEl = $('git-ref');
        if (refEl) {
          refEl.textContent = sha ? `${branch} @ ${sha}` : branch;
        }

        const dirtyEl = $('git-dirty');
        if (dirtyEl) {
          if (dirty > 0) {
            dirtyEl.textContent = `${dirty} 个脏文件`;
            dirtyEl.className = 'pill pill-warn mono';
          } else {
            dirtyEl.textContent = '工作区干净';
            dirtyEl.className = 'pill pill-ok';
          }
        }

        const tipLines = [];
        if (g.repoRoot) tipLines.push(`仓库: ${g.repoRoot}`);
        if (g.headSubject) tipLines.push(`提交: ${g.headSubject}`);
        if (g.statusShort) tipLines.push(`\n${g.statusShort}`);
        gitBar.title = tipLines.join('\n');
      } else {
        gitBar.classList.add('hidden');
      }
    }
  }

  function renderPresetButtons() {
    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.activePreset);
    });
  }

  function renderFilesCard() {
    const section = $('files-section');
    const sess = state.currentSession;
    if (!section || !sess) return;

    const modified = sess.filesTouched?.modified || [];
    const read = sess.filesTouched?.read || [];
    if (modified.length === 0 && read.length === 0) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    const modEl = $('files-mod-count');
    const readEl = $('files-read-count');
    if (modEl) modEl.textContent = `已修改 ${modified.length}`;
    if (readEl) readEl.textContent = `已读取 ${read.length}`;

    const toggleBtn = $('btn-toggle-files');
    const bodyEl = $('files-body');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', state.filesExpanded ? 'true' : 'false');
    if (bodyEl) bodyEl.classList.toggle('hidden', !state.filesExpanded);

    const pillsWrap = $('files-pills');
    if (!pillsWrap) return;
    pillsWrap.innerHTML = '';

    const modSet = new Set(modified.map((p) => normalizePathLower(p)));
    const combined = [
      ...modified.map((p) => ({ path: p, modified: true })),
      ...read.filter((p) => !modSet.has(normalizePathLower(p))).map((p) => ({ path: p, modified: false })),
    ];

    for (const entry of combined) {
      const chip = document.createElement('span');
      chip.className = `file-chip mono${entry.modified ? ' is-modified' : ''}`;
      chip.title = `${entry.modified ? '[已修改] ' : '[已读取] '}${entry.path}`;

      const dot = document.createElement('span');
      dot.className = 'file-dot';

      const name = document.createElement('span');
      name.className = 'file-chip-name';
      name.textContent = shortPath(entry.path, 2);

      chip.appendChild(dot);
      chip.appendChild(name);
      pillsWrap.appendChild(chip);
    }
  }

  function renderTurnList() {
    const listEl = $('turn-list');
    const statEl = $('turn-selection-stat');
    const sess = state.currentSession;
    if (!listEl || !sess) return;

    const turns = sess.turns || [];
    let selectedItemsInSelectedTurns = 0;
    for (const t of turns) {
      if (!state.selectedTurnIds.has(t.id)) continue;
      for (const it of t.items) {
        if (state.selectedItemIds.has(it.id)) selectedItemsInSelectedTurns += 1;
      }
    }

    if (statEl) {
      statEl.textContent = `已选 ${state.selectedTurnIds.size}/${turns.length} 轮 · ${selectedItemsInSelectedTurns} 步`;
    }

    if (turns.length === 0) {
      listEl.innerHTML =
        '<div class="card empty-state"><p class="empty-desc">该会话暂无可展示的对话轮次。</p></div>';
      return;
    }

    const htmlParts = [];
    for (const turn of turns) {
      const isTurnChecked = state.selectedTurnIds.has(turn.id);
      const isExpanded = state.expandedTurnIds.has(turn.id);
      const turnIdEsc = escapeHtml(turn.id);

      const deltaCls =
        turn.deltaTokens >= 40_000
          ? 'delta-pill mono is-huge'
          : turn.deltaTokens >= 15_000
            ? 'delta-pill mono is-heavy'
            : 'delta-pill mono';
      const deltaLabel = turn.deltaTokens > 0 ? `+${fmtTokens(turn.deltaTokens)}` : `~${fmtTokens(turn.estimatedTurnTokens)}`;

      const noisePct = Math.round(turn.noiseRatio * 100);
      const noiseCls =
        noisePct >= 65 ? 'noise-fill is-very-noisy' : noisePct >= 30 ? 'noise-fill is-noisy' : 'noise-fill';

      // Tool stats badges
      let toolsSectionHtml = '';
      if (turn.items.length > 0) {
        const pickedInTurn = turn.items.filter((it) => state.selectedItemIds.has(it.id)).length;
        const badges = [];
        if (turn.counts.edit > 0) {
          badges.push(`<span class="pill pill-edit mono">改 ${turn.counts.edit}</span>`);
        }
        if (turn.counts.read > 0) {
          badges.push(`<span class="pill pill-read mono">读 ${turn.counts.read}</span>`);
        }
        if (turn.counts.command > 0) {
          badges.push(`<span class="pill pill-cmd mono">命令 ${turn.counts.command}</span>`);
        }
        if (turn.counts.error > 0) {
          badges.push(`<span class="pill pill-err mono">错误 ${turn.counts.error}</span>`);
        }
        if (badges.length === 0) {
          badges.push(`<span class="pill mono">工具 ${turn.items.length}</span>`);
        }

        let itemsHtml = '';
        if (isExpanded) {
          const rows = [];
          for (const item of turn.items) {
            const itemChecked = state.selectedItemIds.has(item.id);
            const itemIdEsc = escapeHtml(item.id);
            const cacheKey = item.stepIndex !== null ? `${sess.sessionId}:${item.stepIndex}` : '';
            const stepKey = item.stepIndex !== null ? String(item.stepIndex) : '';
            const isFullIncluded = stepKey !== '' && state.expandFullStepIds.has(stepKey);
            const isFullVisible = cacheKey !== '' && state.visibleFullSteps.has(cacheKey);
            const isFullLoading = cacheKey !== '' && state.loadingFullSteps.has(cacheKey);

            const toolKindCls = item.isError
              ? 'tool-name mono kind-error'
              : item.isWrite
                ? 'tool-name mono kind-edit'
                : item.category === 'command'
                  ? 'tool-name mono kind-command'
                  : 'tool-name mono';

            const bytesCls = item.isError
              ? 'item-bytes mono is-error'
              : item.bytes > 4096
                ? 'item-bytes mono is-large'
                : 'item-bytes mono';

            const bytesText = item.isError
              ? `ERR · ${fmtBytes(item.bytes)}`
              : item.bytes > 0
                ? fmtBytes(item.bytes)
                : '';

            let expandBtnHtml = '';
            if (item.isTruncated && item.stepIndex !== null) {
              const btnLabel = isFullLoading
                ? '载入中…'
                : isFullIncluded && isFullVisible
                  ? '已含全文'
                  : '展开全文';
              expandBtnHtml = `<button class="btn-expand-full${isFullIncluded && isFullVisible ? ' is-active' : ''}" type="button" data-action="expand-full" data-turn-id="${turnIdEsc}" data-item-id="${itemIdEsc}"${isFullLoading ? ' disabled' : ''} title="从完整日志按需加载 step#${item.stepIndex} 原文并纳入交接包">${escapeHtml(btnLabel)}</button>`;
            }

            let fullBoxHtml = '';
            if (isFullVisible && state.fullStepCache.has(cacheKey)) {
              const fullText = state.fullStepCache.get(cacheKey) || '';
              fullBoxHtml = `
                <div class="item-full-box">
                  <div class="item-full-head mono">
                    <span>step#${item.stepIndex} 完整输出（${escapeHtml(fmtBytes(utf8ByteLength(fullText)))}）</span>
                    <span>已纳入交接包</span>
                  </div>
                  <pre class="item-full-pre">${escapeHtml(fullText)}</pre>
                </div>`;
            }

            rows.push(`
              <div class="item-row${itemChecked && isTurnChecked ? '' : ' is-unchecked'}">
                <div class="item-main">
                  <input class="item-check" type="checkbox" data-action="toggle-item" data-turn-id="${turnIdEsc}" data-item-id="${itemIdEsc}"${itemChecked ? ' checked' : ''} aria-label="勾选步骤 ${escapeHtml(item.toolName)}" />
                  <div class="item-info">
                    <div class="item-top-line">
                      <span class="${toolKindCls}">${escapeHtml(item.toolName)}</span>
                      <span class="item-summary mono" title="${escapeHtml(item.summary)}">${escapeHtml(collapseLine(item.summary, 110))}</span>
                    </div>
                  </div>
                  <div class="item-right">
                    ${bytesText ? `<span class="${bytesCls}" title="输出大小">${escapeHtml(bytesText)}</span>` : ''}
                    ${expandBtnHtml}
                  </div>
                </div>
                ${fullBoxHtml}
              </div>`);
          }
          itemsHtml = `<div class="turn-items">${rows.join('')}</div>`;
        }

        toolsSectionHtml = `
          <div class="turn-tools-row">
            <button class="turn-tools-toggle" type="button" data-action="toggle-expand" data-turn-id="${turnIdEsc}" aria-expanded="${isExpanded ? 'true' : 'false'}">
              <span class="turn-tools-badges">
                <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
                ${badges.join('')}
              </span>
              <span class="turn-tools-selected mono">已选 ${pickedInTurn}/${turn.items.length}</span>
            </button>
            ${itemsHtml}
          </div>`;
      }

      // Assistant Reply Summary
      let replyHtml = '';
      if (turn.assistantText) {
        const replyMuted = !state.options.includeAssistantReplies ? ' is-muted' : '';
        replyHtml = `
          <div class="turn-reply${replyMuted}" title="${escapeHtml(collapseLine(turn.assistantText, 600))}">
            <span class="reply-tag mono">AI</span>
            <span class="reply-text">${escapeHtml(collapseLine(turn.assistantText, 220))}</span>
          </div>`;
      }

      htmlParts.push(`
        <article class="turn-card${isTurnChecked ? '' : ' is-unchecked'}" role="listitem" data-turn-id="${turnIdEsc}">
          <div class="turn-head">
            <div class="turn-check-wrap">
              <input class="turn-check" type="checkbox" data-action="toggle-turn" data-turn-id="${turnIdEsc}"${isTurnChecked ? ' checked' : ''} aria-label="勾选第 ${turn.index} 轮" />
              <span class="turn-idx mono">#${turn.index}</span>
            </div>
            <div class="turn-user-col">
              <div class="turn-user-text" title="${escapeHtml(collapseLine(turn.userText, 500))}">${escapeHtml(collapseLine(turn.userText, 180))}</div>
            </div>
            <div class="turn-right">
              <div class="turn-right-top">
                <span class="${deltaCls}" title="本轮上下文增量体积">${escapeHtml(deltaLabel)}</span>
                <button class="btn-cutoff" type="button" data-action="cutoff-turn" data-turn-index="${turn.index}" title="仅保留至第 #${turn.index} 轮，移除之后全部轮次">截断至此</button>
              </div>
              <div class="noise-bar-wrap" title="噪声输出占比约 ${noisePct}%">
                <div class="noise-track"><div class="${noiseCls}" style="width:${noisePct}%;"></div></div>
                <span class="noise-label mono">噪 ${noisePct}%</span>
              </div>
            </div>
          </div>
          ${toolsSectionHtml}
          ${replyHtml}
        </article>`);
    }

    listEl.innerHTML = htmlParts.join('');
  }

  function renderLaunchpadTelemetry() {
    const spinner = $('lp-spinner');
    const slimText = $('lp-slim-text');
    const savedBadge = $('lp-saved-badge');
    const redactBadge = $('lp-redact-badge');
    const modeBadge = $('lp-mode-badge');

    if (spinner) {
      spinner.classList.toggle('hidden', !state.previewLoading);
    }

    const b = state.latestBundle;
    if (!b) {
      const peak = state.currentSession?.peakContextTokens || 0;
      if (slimText) {
        slimText.textContent = peak > 0 ? `原峰值 ${fmtTokens(peak)} → 计算中…` : '等待裁剪预览…';
      }
      savedBadge?.classList.add('hidden');
      redactBadge?.classList.add('hidden');
      if (modeBadge) {
        modeBadge.textContent = '—';
        modeBadge.className = 'pill pill-mode mono';
      }
      return;
    }

    if (slimText) {
      slimText.textContent = `原峰值 ${fmtTokens(b.originalPeakTokens)} → 裁剪后 ~${fmtTokens(b.estimatedTokens)}`;
    }

    if (savedBadge) {
      if (b.originalPeakTokens > 0) {
        savedBadge.textContent = `减负 ${b.savedPercent}%`;
        savedBadge.classList.remove('hidden');
      } else {
        savedBadge.classList.add('hidden');
      }
    }

    if (redactBadge) {
      if (b.redactionCount > 0) {
        redactBadge.textContent = `脱敏 ${b.redactionCount} 处`;
        redactBadge.classList.remove('hidden');
      } else {
        redactBadge.classList.add('hidden');
      }
    }

    if (modeBadge) {
      const limitKb = Math.round((b.inlineLimitBytes || 10240) / 1024);
      if (b.recommendFileMode) {
        modeBadge.textContent = `${fmtBytes(b.bytes)} · >${limitKb} KB 自动落盘移交`;
        modeBadge.className = 'pill pill-mode is-file mono';
      } else {
        modeBadge.textContent = `${fmtBytes(b.bytes)} · 直传内联`;
        modeBadge.className = 'pill pill-mode mono';
      }
    }
  }

  function renderSessionsRadar() {
    const listEl = $('sessions-list');
    const countEl = $('radar-count');
    const resetBtn = $('btn-reset-filters');
    if (!listEl) return;

    const hasFilters = Boolean(
      state.radar.q.trim() || state.radar.projectId || state.radar.model || !state.radar.hideSubagents,
    );
    resetBtn?.classList.toggle('hidden', !hasFilters);

    if (countEl) {
      countEl.textContent = `共 ${state.radar.total} 条会话${
        state.radar.sessions.length < state.radar.total ? `（展示前 ${state.radar.sessions.length} 条）` : ''
      }`;
    }

    if (state.radar.sessions.length === 0) {
      listEl.innerHTML = `
        <div class="card empty-state" style="grid-column: 1 / -1;">
          <h3 class="empty-title">没有匹配的会话</h3>
          <p class="empty-desc">尝试放宽搜索关键词、切换项目筛选或点击顶部刷新索引。</p>
        </div>`;
      return;
    }

    const parts = [];
    for (const s of state.radar.sessions) {
      const sidEsc = escapeHtml(s.sessionId);
      const isCurrentSurgery = state.currentSession?.sessionId === s.sessionId;
      const isHostCurrent = state.hostConversationId && state.hostConversationId === s.sessionId;
      const { level } = tokenLevel(s.peakContextTokens);

      const badges = [];
      if (isCurrentSurgery) badges.push('<span class="pill pill-edit">手术中</span>');
      if (isHostCurrent) badges.push('<span class="pill pill-ok">当前</span>');
      if (s.isSubagent) badges.push('<span class="pill pill-warn">子代理</span>');

      parts.push(`
        <article class="card session-card${isCurrentSurgery ? ' is-current-surgery' : ''}" role="listitem" data-session-id="${sidEsc}">
          <div class="session-top">
            <h3 class="session-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</h3>
            <div class="session-badges">${badges.join('')}</div>
          </div>
          <div class="session-path mono" title="${escapeHtml(s.workspacePath || '未记录目录')}">${escapeHtml(shortPath(s.workspacePath, 2))}</div>
          <div class="session-meta">
            <span class="pill pill-model mono">${escapeHtml(s.lastModel || '未知模型')}</span>
            <span class="mono">${s.turnCount} 轮</span>
            <span class="pill pill-${level} mono" title="上下文峰值 token">${escapeHtml(fmtTokens(s.peakContextTokens))}</span>
            <span>${escapeHtml(fmtRelTime(s.updatedAt))}</span>
          </div>
          <div class="session-actions">
            <button class="btn btn-primary" type="button" data-action="load-surgery" data-session-id="${sidEsc}">送入手术台</button>
            <button class="btn btn-ghost" type="button" data-action="open-session" data-session-id="${sidEsc}">${isSidecar ? '打开会话' : '复制 ID'}</button>
          </div>
        </article>`);
    }

    listEl.innerHTML = parts.join('');
  }

  function renderLineageTab() {
    const lineageList = $('lineage-list');
    const archivesList = $('archives-list');
    const lineageCount = $('lineage-count');
    const archivesCount = $('archives-count');

    if (lineageCount) lineageCount.textContent = `${state.lineage.length} 条记录`;
    if (archivesCount) archivesCount.textContent = `${state.archives.length} 份档案`;

    if (lineageList) {
      if (state.lineage.length === 0) {
        lineageList.innerHTML = `
          <div class="card empty-state">
            <h3 class="empty-title">暂无交接血缘记录</h3>
            <p class="empty-desc">在「手术台」一键启动新会话后，源会话与接力会话的减负链路会自动记录在此。</p>
          </div>`;
      } else {
        const parts = [];
        for (const rec of state.lineage) {
          const srcId = String(rec.sourceSessionId || rec.parentSessionId || '');
          const srcTitle = String(rec.sourceTitle || (srcId ? `会话 ${srcId.slice(0, 8)}` : '源会话'));
          const srcPeak = Number(rec.originalPeakTokens ?? rec.sourcePeakTokens ?? 0) || 0;
          const estTokens = Number(rec.estimatedTokens) || 0;
          const srcSubText =
            srcPeak > 0
              ? `源 · ${fmtTokens(srcPeak)} tokens`
              : estTokens > 0
                ? `源 · 裁剪后 ~${fmtTokens(estTokens)} tokens`
                : `源 · ${shortPath(rec.sourceWorkspacePath || '', 2)}`;
          const dstId = String(rec.targetSessionId || rec.childSessionId || rec.conversationId || '');
          const dstTitle = String(rec.targetTitle || rec.title || (dstId ? `新会话 ${dstId.slice(0, 8)}` : '接力会话'));
          const dstDir = String(rec.targetWorkspace || rec.targetProjectName || '');
          const savedPct = Math.round(Number(rec.savedPercent) || 0);
          const modeLabel = (rec.launchMode || rec.mode) === 'file' ? '落盘' : '内联';
          const archiveFile = String(
            rec.handoffFilename || (rec.handoffFilePath ? fileBasename(rec.handoffFilePath) : ''),
          );

          parts.push(`
            <article class="card lineage-card">
              <div class="lineage-flow">
                <button class="lineage-node" type="button" data-action="lineage-open-source" data-session-id="${escapeHtml(srcId)}" title="送入手术台或跳转源会话">
                  <span class="lineage-node-text">
                    <span class="lineage-node-title">${escapeHtml(srcTitle)}</span>
                    <span class="lineage-node-sub mono">${escapeHtml(srcSubText)}</span>
                  </span>
                </button>
                <div class="lineage-arrow">
                  <span class="pill pill-ok mono">减负 ${savedPct}%</span>
                  <span class="pill mono">${escapeHtml(modeLabel)}</span>
                  <span aria-hidden="true">→</span>
                </div>
                <button class="lineage-node" type="button" data-action="open-session" data-session-id="${escapeHtml(dstId)}" title="跳转接力新会话">
                  <span class="lineage-node-text">
                    <span class="lineage-node-title">${escapeHtml(dstTitle)}</span>
                    <span class="lineage-node-sub mono">@ ${escapeHtml(shortPath(dstDir, 2))}</span>
                  </span>
                </button>
              </div>
              <div class="lineage-foot">
                <span class="mono">${escapeHtml(fmtRelTime(rec.createdAt))}${rec.model ? ` · ${escapeHtml(rec.model)}` : ''}</span>
                ${
                  archiveFile
                    ? `<button class="btn btn-xs btn-ghost" type="button" data-action="preview-archive" data-filename="${escapeHtml(archiveFile)}">预览交接包</button>`
                    : ''
                }
              </div>
            </article>`);
        }
        lineageList.innerHTML = parts.join('');
      }
    }

    if (archivesList) {
      if (state.archives.length === 0) {
        archivesList.innerHTML = `
          <div class="card empty-state">
            <h3 class="empty-title">暂无导出档案</h3>
            <p class="empty-desc">点击「导出 MD」或触发 &gt;10 KB 自动落盘移交时，交接文档将保存在 handoffs/*.md。</p>
          </div>`;
      } else {
        const parts = [];
        for (const arc of state.archives) {
          const fnameEsc = escapeHtml(arc.filename || '');
          parts.push(`
            <article class="card archive-card">
              <div class="archive-info">
                <span class="archive-name mono" title="${fnameEsc}">${fnameEsc}</span>
                <div class="archive-meta mono">
                  <span>${escapeHtml(fmtBytes(arc.size || 0))}</span>
                  <span>${escapeHtml(fmtRelTime(arc.mtimeMs))}</span>
                </div>
              </div>
              <div class="archive-actions">
                <button class="btn btn-xs btn-secondary" type="button" data-action="preview-archive" data-filename="${fnameEsc}">预览</button>
                <button class="btn btn-xs btn-ghost" type="button" data-action="copy-archive" data-filename="${fnameEsc}">复制</button>
              </div>
            </article>`);
        }
        archivesList.innerHTML = parts.join('');
      }
    }
  }

  /* ========================================================================
     11. Preview Modal Controls
     ======================================================================== */

  function openModal({ title = '预览', content = '', badges = [], filePath = '' }) {
    state.modalContent = String(content || '');

    const modal = $('preview-modal');
    const titleEl = $('modal-title');
    const badgesEl = $('modal-badges');
    const codeEl = $('modal-code');
    const pathEl = $('modal-filepath');

    if (titleEl) titleEl.textContent = title;
    if (codeEl) codeEl.textContent = state.modalContent;
    if (pathEl) {
      pathEl.textContent = filePath ? shortPath(filePath, 3) : '';
      pathEl.title = filePath || '';
    }

    if (badgesEl) {
      badgesEl.innerHTML = '';
      for (const b of badges) {
        const span = document.createElement('span');
        span.className = `pill mono${b.cls ? ` ${b.cls}` : ''}`;
        span.textContent = String(b.text || '');
        badgesEl.appendChild(span);
      }
    }

    modal?.classList.remove('hidden');
    $('btn-modal-close')?.focus();
  }

  function closeModal() {
    $('preview-modal')?.classList.add('hidden');
  }

  /* ========================================================================
     12. Tab Navigation & Event Binding
     ======================================================================== */

  function setActiveTab(tabName) {
    state.activeTab = tabName;

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const isMatch = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${tabName}`);
    });

    if (tabName === 'sessions') {
      loadSessionsRadar();
    } else if (tabName === 'lineage') {
      loadLineage();
    }
  }

  function bindEvents() {
    // Environment badge
    const envBadge = $('env-badge');
    if (envBadge) {
      envBadge.textContent = isSidecar ? 'Sidecar' : 'Local Web';
      envBadge.classList.toggle('is-sidecar', isSidecar);
    }

    // Header tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab) setActiveTab(btn.dataset.tab);
      });
    });

    // Header sync & empty state buttons
    $('btn-sync')?.addEventListener('click', () => triggerSync({ force: true }));
    $('btn-empty-sync')?.addEventListener('click', () => triggerSync({ force: true }));
    $('btn-empty-radar')?.addEventListener('click', () => setActiveTab('sessions'));

    // Open session in host shell
    $('btn-open-host')?.addEventListener('click', () => {
      if (state.currentSession?.sessionId) {
        HostBridge.openConversation(state.currentSession.sessionId);
      }
    });

    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        const sess = state.currentSession;
        if (!preset || !sess) return;

        state.activePreset = preset;
        renderPresetButtons();

        if (preset === 'all' || preset === 'none') {
          applySelection(computeLocalPreset(sess, preset), sess);
          renderTurnList();
          updateNavBadges();
          runPreviewNow();
        } else {
          // Request authoritative server preset selection (with immediate local preview responsiveness)
          applySelection(computeLocalPreset(sess, preset), sess);
          renderTurnList();
          updateNavBadges();
          loadSessionById(sess.sessionId, { preset, switchToSurgery: false, isPresetSwitch: true });
        }
      });
    });

    // Option toggle switches
    const wireOptionToggle = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        state.options[key] = el.checked;
        if (key === 'includeAssistantReplies') renderTurnList();
        schedulePreview();
      });
    };
    wireOptionToggle('opt-assistant', 'includeAssistantReplies');
    wireOptionToggle('opt-tools', 'includeToolDetails');
    wireOptionToggle('opt-git', 'includeGitAnchor');
    wireOptionToggle('opt-redact', 'redact');
    wireOptionToggle('opt-files', 'includeFilesTouched');

    // Touched files accordion
    $('btn-toggle-files')?.addEventListener('click', () => {
      state.filesExpanded = !state.filesExpanded;
      renderFilesCard();
    });

    // Turn list delegated events (checkboxes, cutoff, expand drawer, expand full step)
    const turnList = $('turn-list');
    turnList?.addEventListener('change', (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLInputElement)) return;
      const action = target.dataset.action;
      const turnId = target.dataset.turnId;
      const sess = state.currentSession;
      if (!sess || !turnId) return;

      if (action === 'toggle-turn') {
        if (target.checked) {
          state.selectedTurnIds.add(turnId);
        } else {
          state.selectedTurnIds.delete(turnId);
        }
        state.activePreset = '';
        renderPresetButtons();
        renderTurnList();
        updateNavBadges();
        schedulePreview();
      } else if (action === 'toggle-item') {
        const itemId = target.dataset.itemId;
        if (!itemId) return;
        if (target.checked) {
          state.selectedItemIds.add(itemId);
          state.selectedTurnIds.add(turnId);
        } else {
          state.selectedItemIds.delete(itemId);
        }
        state.activePreset = '';
        renderPresetButtons();
        renderTurnList();
        updateNavBadges();
        schedulePreview();
      }
    });

    turnList?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const sess = state.currentSession;
      if (!sess) return;

      if (action === 'toggle-expand') {
        const turnId = btn.dataset.turnId;
        if (!turnId) return;
        if (state.expandedTurnIds.has(turnId)) {
          state.expandedTurnIds.delete(turnId);
        } else {
          state.expandedTurnIds.add(turnId);
        }
        renderTurnList();
      } else if (action === 'cutoff-turn') {
        const maxIndex = Number(btn.dataset.turnIndex);
        if (!Number.isFinite(maxIndex)) return;

        let removedCount = 0;
        for (const t of sess.turns) {
          if (t.index > maxIndex) {
            if (state.selectedTurnIds.has(t.id)) removedCount += 1;
            state.selectedTurnIds.delete(t.id);
            for (const it of t.items) {
              state.selectedItemIds.delete(it.id);
            }
          } else {
            state.selectedTurnIds.add(t.id);
          }
        }
        state.activePreset = '';
        renderPresetButtons();
        renderTurnList();
        updateNavBadges();
        runPreviewNow();
        showToast(
          removedCount > 0
            ? `已截断至第 #${maxIndex} 轮（移除后续 ${removedCount} 轮）`
            : `已保留第 #1–#${maxIndex} 轮`,
          'info',
        );
      } else if (action === 'expand-full') {
        const turnId = btn.dataset.turnId;
        const itemId = btn.dataset.itemId;
        const turn = sess.turns.find((t) => t.id === turnId);
        const item = turn?.items.find((it) => it.id === itemId);
        if (item) {
          handleExpandFullStep(item, turnId);
        }
      }
    });

    // Launchpad config drawer toggle (narrow viewports)
    $('btn-toggle-lp-config')?.addEventListener('click', () => {
      state.lpConfigOpen = !state.lpConfigOpen;
      $('launchpad')?.classList.toggle('config-open', state.lpConfigOpen);
      $('btn-toggle-lp-config')?.setAttribute('aria-expanded', state.lpConfigOpen ? 'true' : 'false');
    });

    // Launchpad inputs
    $('lp-project')?.addEventListener('change', () => {
      state.projectSelectionDirty = true;
      updateLaunchpadConfigSummary();
      schedulePreview();
    });
    $('lp-model')?.addEventListener('input', () => {
      updateLaunchpadConfigSummary();
    });
    $('lp-title')?.addEventListener('input', () => {
      state.titleDirty = true;
    });
    $('lp-instruction')?.addEventListener('input', () => {
      schedulePreview();
    });

    // Launchpad actions
    $('btn-launch')?.addEventListener('click', handleLaunch);
    $('btn-copy')?.addEventListener('click', handleCopyBundle);
    $('btn-preview')?.addEventListener('click', handleOpenPreview);
    $('btn-export')?.addEventListener('click', handleExportMarkdown);

    // Tab 2: Sessions Radar filters
    const debouncedRadarLoad = debounce(() => loadSessionsRadar(), 200);
    const searchInput = $('radar-search');
    const clearSearchBtn = $('btn-clear-search');

    searchInput?.addEventListener('input', () => {
      state.radar.q = searchInput.value;
      clearSearchBtn?.classList.toggle('hidden', !state.radar.q);
      debouncedRadarLoad();
    });

    clearSearchBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      state.radar.q = '';
      clearSearchBtn.classList.add('hidden');
      loadSessionsRadar();
    });

    $('radar-project')?.addEventListener('change', (ev) => {
      state.radar.projectId = ev.target.value;
      loadSessionsRadar();
    });

    $('radar-model')?.addEventListener('change', (ev) => {
      state.radar.model = ev.target.value;
      loadSessionsRadar();
    });

    $('radar-hide-subagents')?.addEventListener('change', (ev) => {
      state.radar.hideSubagents = ev.target.checked;
      loadSessionsRadar();
    });

    $('btn-reset-filters')?.addEventListener('click', () => {
      state.radar.q = '';
      state.radar.projectId = '';
      state.radar.model = '';
      state.radar.hideSubagents = true;
      if (searchInput) searchInput.value = '';
      clearSearchBtn?.classList.add('hidden');
      if ($('radar-project')) $('radar-project').value = '';
      if ($('radar-model')) $('radar-model').value = '';
      if ($('radar-hide-subagents')) $('radar-hide-subagents').checked = true;
      loadSessionsRadar();
    });

    // Sessions list delegated actions
    $('sessions-list')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      const sid = btn.dataset.sessionId;
      if (!sid) return;
      if (btn.dataset.action === 'load-surgery') {
        loadSessionById(sid, { preset: 'smart-clean', switchToSurgery: true });
      } else if (btn.dataset.action === 'open-session') {
        HostBridge.openConversation(sid);
      }
    });

    // Tab 3: Lineage & Archives delegated actions
    $('panel-lineage')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'lineage-open-source') {
        const sid = btn.dataset.sessionId;
        if (sid) loadSessionById(sid, { preset: 'smart-clean', switchToSurgery: true });
      } else if (action === 'open-session') {
        const sid = btn.dataset.sessionId;
        if (sid) HostBridge.openConversation(sid);
      } else if (action === 'preview-archive') {
        const fname = btn.dataset.filename;
        if (fname) openArchivePreview(fname, { copyOnly: false });
      } else if (action === 'copy-archive') {
        const fname = btn.dataset.filename;
        if (fname) openArchivePreview(fname, { copyOnly: true });
      }
    });

    // Modal controls
    $('modal-backdrop')?.addEventListener('click', closeModal);
    $('btn-modal-close')?.addEventListener('click', closeModal);
    $('btn-modal-done')?.addEventListener('click', closeModal);

    $('modal-wrap')?.addEventListener('change', (ev) => {
      $('modal-pre')?.classList.toggle('wrap', ev.target.checked);
    });

    $('btn-modal-copy')?.addEventListener('click', async () => {
      if (!state.modalContent) return;
      const ok = await copyToClipboard(state.modalContent);
      showToast(ok ? '已复制完整 Markdown 到剪贴板' : '复制失败，请手动选中复制', ok ? 'success' : 'warn');
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        const modal = $('preview-modal');
        if (modal && !modal.classList.contains('hidden')) {
          closeModal();
        }
      }
    });

    // Sidecar workspace change notifications
    HostBridge.bindWorkspaceChange(() => {
      HostBridge.get('/api/state?noSync=1')
        .then((res) => {
          if (Array.isArray(res?.projects)) {
            updateProjectsAndModels(res.projects, res.models);
          }
        })
        .catch(() => {});
    });
  }

  /* ========================================================================
     13. Bootstrap
     ======================================================================== */

  function bootstrap() {
    initThemeSync();
    bindEvents();
    updateLaunchpadCapabilities();
    loadInitialState({ noSync: 1 });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();

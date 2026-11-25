import { truncateText } from './fs-utils.mjs';
import { redactSensitive } from './redact.mjs';
import { applySurgeryPreset, estimateTokens } from './turn-parser.mjs';

export const INLINE_LIMIT_BYTES = 10 * 1024;
export const HARD_INLINE_LIMIT_BYTES = 28 * 1024;

const MAX_SINGLE_BLOCK_BYTES = 12 * 1024;
const MAX_FILE_LAUNCH_PROMPT_BYTES = 1536;
const MAX_READ_FILES_DISPLAY = 50;

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Slice a UTF-8 prefix strictly within maxBytes without splitting surrogate pairs.
 */
function sliceUtf8Prefix(str, maxBytes) {
  if (typeof str !== 'string' || !str || maxBytes <= 0) return '';
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    let idx = mid;
    if (idx > 0 && idx < str.length && isHighSurrogate(str.charCodeAt(idx - 1))) {
      idx -= 1;
    }
    if (Buffer.byteLength(str.slice(0, idx), 'utf-8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  let end = lo;
  if (end > 0 && end < str.length && isHighSurrogate(str.charCodeAt(end - 1))) {
    end -= 1;
  }
  while (end > 0 && Buffer.byteLength(str.slice(0, end), 'utf-8') > maxBytes) {
    end -= 1;
    if (end > 0 && isHighSurrogate(str.charCodeAt(end - 1))) {
      end -= 1;
    }
  }
  return str.slice(0, end);
}

/**
 * Slice a UTF-8 suffix strictly within maxBytes without splitting surrogate pairs.
 */
function sliceUtf8Suffix(str, maxBytes) {
  if (typeof str !== 'string' || !str || maxBytes <= 0) return '';
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let idx = mid;
    if (idx > 0 && idx < str.length && isLowSurrogate(str.charCodeAt(idx))) {
      idx += 1;
    }
    if (Buffer.byteLength(str.slice(idx), 'utf-8') <= maxBytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  let start = lo;
  if (start > 0 && start < str.length && isLowSurrogate(str.charCodeAt(start))) {
    start += 1;
  }
  while (start < str.length && Buffer.byteLength(str.slice(start), 'utf-8') > maxBytes) {
    start += 1;
    if (start < str.length && isLowSurrogate(str.charCodeAt(start))) {
      start += 1;
    }
  }
  return str.slice(start);
}

/**
 * Keep full text when <= maxBytes; otherwise preserve head and tail within maxBytes.
 */
function preserveHeadTailUtf8(text, maxBytes = MAX_SINGLE_BLOCK_BYTES) {
  if (typeof text !== 'string' || !text) return '';
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  if (totalBytes <= maxBytes) return text;

  const placeholderMarker = `\n\n... [content truncated: ~${totalBytes} bytes omitted from middle, head and tail preserved] ...\n\n`;
  const markerReserve = Buffer.byteLength(placeholderMarker, 'utf-8') + 16;
  const available = Math.max(64, maxBytes - markerReserve);
  const headBudget = Math.floor(available * 0.55);
  const tailBudget = available - headBudget;

  const head = sliceUtf8Prefix(text, headBudget).trimEnd();
  const tail = sliceUtf8Suffix(text, tailBudget).trimStart();
  const omitted = Math.max(
    0,
    totalBytes - Buffer.byteLength(head, 'utf-8') - Buffer.byteLength(tail, 'utf-8'),
  );
  const marker = `\n\n... [content truncated: ~${omitted} bytes omitted from middle, head and tail preserved] ...\n\n`;
  const combined = `${head}${marker}${tail}`;
  if (Buffer.byteLength(combined, 'utf-8') <= maxBytes) {
    return combined;
  }
  return sliceUtf8Prefix(combined, maxBytes);
}

/**
 * Wrap content in a markdown fenced code block whose delimiter length exceeds any
 * backtick run inside the content.
 */
function safeCodeFence(content, lang = 'text') {
  const str = typeof content === 'string' ? content : String(content ?? '');
  const matches = str.match(/`+/g);
  let maxRun = 2;
  if (matches) {
    for (const run of matches) {
      if (run.length > maxRun) maxRun = run.length;
    }
  }
  const fence = '`'.repeat(Math.max(3, maxRun + 1));
  return `${fence}${lang}\n${str}\n${fence}`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizePathKey(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  const unified = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

function categoryBadge(item) {
  if (item.isError) return 'ERROR';
  switch (item.category) {
    case 'write':
      return 'WRITE';
    case 'read':
      return 'READ';
    case 'command':
      return 'CMD';
    case 'search':
      return 'SEARCH';
    case 'meta':
      return 'META';
    default:
      return 'TOOL';
  }
}

function safeShortPreview(text, maxChars) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  if (maxChars <= 1) return '…';
  let cut = cleaned.slice(0, maxChars - 1);
  if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

function loadExpandedStepContent(fullStepLoader, stepIndex) {
  if (typeof fullStepLoader !== 'function' || stepIndex === null || stepIndex === undefined) {
    return '';
  }
  try {
    const loaded = fullStepLoader(stepIndex);
    if (typeof loaded === 'string') return loaded;
    if (loaded && typeof loaded.content === 'string') return loaded.content;
    return '';
  } catch {
    return '';
  }
}

/**
 * Build a deterministic, high signal-to-noise Markdown context handoff bundle.
 *
 * @param {object} parsedSession
 * @param {object} [options]
 */
export function buildHandoffBundle(parsedSession, options = {}) {
  const session = parsedSession && typeof parsedSession === 'object' ? parsedSession : {};
  const turns = Array.isArray(session.turns) ? session.turns : [];

  const {
    selectedTurnIds,
    selectedItemIds,
    includeAssistantReplies = true,
    includeToolDetails = true,
    includeFilesTouched = true,
    gitAnchor = null,
    redact = true,
    extraInstruction = '',
    targetWorkspace = '',
    fullStepLoader = null,
    expandFullStepIds = [],
  } = options || {};

  let resolvedTurnIds;
  let resolvedItemIds;

  if (selectedTurnIds === undefined || selectedTurnIds === null) {
    const defaultSel = applySurgeryPreset(session, 'smart-clean');
    resolvedTurnIds = defaultSel.selectedTurnIds;
    resolvedItemIds =
      selectedItemIds !== undefined && selectedItemIds !== null
        ? Array.isArray(selectedItemIds)
          ? selectedItemIds
          : []
        : defaultSel.selectedItemIds;
  } else {
    resolvedTurnIds = Array.isArray(selectedTurnIds) ? selectedTurnIds : [];
    if (selectedItemIds !== undefined && selectedItemIds !== null) {
      resolvedItemIds = Array.isArray(selectedItemIds) ? selectedItemIds : [];
    } else {
      const tmpTurnSet = new Set(resolvedTurnIds);
      resolvedItemIds = [];
      for (const turn of turns) {
        if (!tmpTurnSet.has(turn.id)) continue;
        for (const item of turn.items || []) {
          if (item.defaultInclude === true) {
            resolvedItemIds.push(item.id);
          }
        }
      }
    }
  }

  const turnIdSet = new Set(resolvedTurnIds);
  const itemIdSet = new Set(resolvedItemIds);
  const expandSet = new Set(
    Array.isArray(expandFullStepIds) ? expandFullStepIds.map((v) => String(v)) : [],
  );

  const selectedTurns = turns.filter((t) => turnIdSet.has(t.id));
  const totalTurnsCount = turns.length;
  const selectedTurnsCount = selectedTurns.length;

  let totalItemsCount = 0;
  for (const t of turns) {
    totalItemsCount += Array.isArray(t.items) ? t.items.length : 0;
  }

  let selectedItemsCount = 0;
  const selectedItemsByTurn = new Map();
  for (const t of selectedTurns) {
    const picked = includeToolDetails
      ? (t.items || []).filter((item) => itemIdSet.has(item.id))
      : [];
    selectedItemsByTurn.set(t.id, picked);
    selectedItemsCount += picked.length;
  }

  const sections = [];

  // 1. Header
  const title = truncateText(session.title || 'Untitled session', 120) || 'Untitled session';
  const sessionId = session.sessionId || 'unknown';
  const primaryModel = session.lastModel || session.firstModel || 'unknown';
  const allModels =
    Array.isArray(session.modelsUsed) && session.modelsUsed.length > 0
      ? session.modelsUsed.join(', ')
      : primaryModel;
  const modelLine =
    allModels && allModels !== primaryModel
      ? `${primaryModel} (previously used: ${allModels})`
      : primaryModel;
  const effectiveWorkspace = targetWorkspace || session.workspacePath || 'unspecified';
  const generatedAt = new Date().toISOString();

  const headerLines = [
    '# Context Relay Handoff Bundle',
    '',
    `- **Source Title**: ${title}`,
    `- **Source Session ID**: \`${sessionId}\``,
    `- **Source Model**: ${modelLine}`,
    `- **Target Workspace**: \`${effectiveWorkspace}\``,
    `- **Generated At**: ${generatedAt}`,
    `- **Pruning Summary**: kept ${selectedTurnsCount}/${totalTurnsCount} turns, ${selectedItemsCount}/${totalItemsCount} tool steps`,
  ];
  if (session.isSubagent && session.parentSessionId) {
    headerLines.splice(4, 0, `- **Parent Session ID**: \`${session.parentSessionId}\` (subagent session)`);
  }
  sections.push(headerLines.join('\n'));

  // 2. Explicit extra instruction (pinned at top)
  const trimmedInstruction =
    typeof extraInstruction === 'string' ? extraInstruction.trim() : '';
  if (trimmedInstruction) {
    sections.push(`## Explicit Continuation Instruction\n\n${trimmedInstruction}`);
  }

  // 3. Deterministic Git anchor
  if (gitAnchor && gitAnchor.isGitRepo) {
    const anchorDir = gitAnchor.workspacePath || gitAnchor.repoRoot || '';
    const gitLines = [
      '## Live Repository State Anchor (Deterministic)',
      '',
      `- **Captured From**: \`${anchorDir}\``,
      `- **Repository Root**: \`${gitAnchor.repoRoot || ''}\``,
      `- **Current Branch**: \`${gitAnchor.branch || '(detached/unborn)'}\``,
      `- **HEAD Commit**: \`${gitAnchor.headSha || 'no commits'}\`${
        gitAnchor.headSubject ? ` — ${gitAnchor.headSubject}` : ''
      }`,
      `- **Working Tree**: ${gitAnchor.dirtyCount ?? 0} modified tracked, ${
        gitAnchor.untrackedCount ?? 0
      } untracked`,
    ];

    const trimmedTargetWs = typeof targetWorkspace === 'string' ? targetWorkspace.trim() : '';
    if (trimmedTargetWs && anchorDir) {
      const targetKey = normalizePathKey(trimmedTargetWs);
      const anchorKey = normalizePathKey(anchorDir);
      const repoKey = normalizePathKey(gitAnchor.repoRoot || '');
      const insideAnchorRepo =
        targetKey === anchorKey ||
        (repoKey && (targetKey === repoKey || targetKey.startsWith(`${repoKey}/`)));
      if (targetKey && !insideAnchorRepo) {
        gitLines.push(
          `- **Cross-Project Note**: Git state above was captured from \`${anchorDir}\`, which differs from target workspace \`${trimmedTargetWs}\`. Do not conflate the two repositories.`,
        );
      }
    }

    if (gitAnchor.statusShort) {
      gitLines.push('', '### git status --short', '', safeCodeFence(gitAnchor.statusShort, 'text'));
    }
    if (gitAnchor.diffStat) {
      gitLines.push('', '### git diff --stat', '', safeCodeFence(gitAnchor.diffStat, 'text'));
    }
    if (gitAnchor.diffSnippet) {
      gitLines.push('', '### git diff snippet', '', safeCodeFence(gitAnchor.diffSnippet, 'diff'));
    }

    sections.push(gitLines.join('\n'));
  }

  // 4. Files touched
  if (includeFilesTouched) {
    const modified = Array.isArray(session.filesTouched?.modified)
      ? session.filesTouched.modified
      : [];
    const read = Array.isArray(session.filesTouched?.read) ? session.filesTouched.read : [];
    const modifiedKeys = new Set(modified.map(normalizePathKey));
    const readOnly = read.filter((p) => !modifiedKeys.has(normalizePathKey(p)));

    const fileLines = ['## Files Touched in Session'];
    if (modified.length === 0 && readOnly.length === 0) {
      fileLines.push('', '- (No file reads or modifications recorded in this session)');
    } else {
      if (modified.length > 0) {
        fileLines.push('', `### Modified / Created (${modified.length})`, '');
        for (const f of modified) {
          fileLines.push(`- \`${f}\``);
        }
      }
      if (readOnly.length > 0) {
        fileLines.push('', `### Key Files Read (${readOnly.length})`, '');
        const displayRead = readOnly.slice(0, MAX_READ_FILES_DISPLAY);
        for (const f of displayRead) {
          fileLines.push(`- \`${f}\``);
        }
        if (readOnly.length > MAX_READ_FILES_DISPLAY) {
          fileLines.push(`- ... ${readOnly.length - MAX_READ_FILES_DISPLAY} additional read files omitted`);
        }
      }
    }
    sections.push(fileLines.join('\n'));
  }

  // 5. Selected conversation backbone
  const backboneLines = ['## Curated Conversation Backbone (Surgically Pruned)'];

  if (selectedTurns.length === 0) {
    backboneLines.push(
      '',
      '(No prior conversation turns kept. Proceed directly using the continuation instruction and Git state anchor above.)',
    );
  } else {
    let prevIndex = 0;
    for (const turn of selectedTurns) {
      if (turn.index > prevIndex + 1) {
        const gapStart = prevIndex + 1;
        const gapEnd = turn.index - 1;
        backboneLines.push(
          '',
          gapStart === gapEnd
            ? `> _(Pruned turn ${gapStart})_`
            : `> _(Pruned turns ${gapStart}–${gapEnd})_`,
        );
      }
      prevIndex = turn.index;

      const roleTag = turn.sourceType === 'SYSTEM_MESSAGE' ? ' (subagent task)' : '';
      backboneLines.push('', `### Turn ${turn.index}${roleTag}`);

      const metaParts = [];
      if (turn.model) metaParts.push(`Model: ${turn.model}`);
      if (turn.createdAt) metaParts.push(`Time: ${turn.createdAt}`);
      if (Array.isArray(turn.filesModified) && turn.filesModified.length > 0) {
        metaParts.push(`Modified files: ${turn.filesModified.length}`);
      }
      if (metaParts.length > 0) {
        backboneLines.push(`_${metaParts.join(' · ')}_`);
      }

      const cleanUser = preserveHeadTailUtf8(turn.userText || '(empty)', MAX_SINGLE_BLOCK_BYTES);
      backboneLines.push('', '#### User Request', '', cleanUser);

      const pickedItems = selectedItemsByTurn.get(turn.id) || [];
      if (includeToolDetails && pickedItems.length > 0) {
        backboneLines.push('', '#### Key Tool Actions', '');
        for (const item of pickedItems) {
          const badge = categoryBadge(item);
          const sizeTag = item.resultBytes > 0 ? ` · ${formatBytes(item.resultBytes)}` : '';
          const stepTag =
            item.resultStepIndex !== null && item.resultStepIndex !== undefined
              ? ` · step#${item.resultStepIndex}`
              : '';
          backboneLines.push(`- **[${badge}]** \`${item.actionSummary}\`${sizeTag}${stepTag}`);

          const wantsExpand =
            expandSet.has(String(item.id)) ||
            (item.resultStepIndex !== null &&
              item.resultStepIndex !== undefined &&
              expandSet.has(String(item.resultStepIndex)));

          if (wantsExpand) {
            const fullRaw = loadExpandedStepContent(fullStepLoader, item.resultStepIndex);
            const expandedBody = fullRaw
              ? preserveHeadTailUtf8(fullRaw.trim(), MAX_SINGLE_BLOCK_BYTES)
              : preserveHeadTailUtf8((item.resultPreview || '').trim(), MAX_SINGLE_BLOCK_BYTES);
            if (expandedBody) {
              backboneLines.push(
                '',
                `  _Expanded full output for step#${item.resultStepIndex ?? item.plannerStepIndex} on demand (12 KB cap per step):_`,
                '',
                safeCodeFence(expandedBody, 'text'),
                '',
              );
            }
          } else if (
            item.resultPreview &&
            (item.category === 'command' || item.category === 'search' || item.isError)
          ) {
            const preview = safeShortPreview(item.resultPreview, 360);
            if (preview) {
              backboneLines.push('', safeCodeFence(preview, 'text'), '');
            }
          }
        }
      }

      if (includeAssistantReplies && turn.assistantText) {
        const replyBody = preserveHeadTailUtf8(turn.assistantText, MAX_SINGLE_BLOCK_BYTES);
        backboneLines.push('', '#### Assistant Conclusions', '', replyBody);
      }
    }

    if (prevIndex < totalTurnsCount) {
      const tailStart = prevIndex + 1;
      backboneLines.push(
        '',
        tailStart === totalTurnsCount
          ? `> _(Pruned turn ${tailStart})_`
          : `> _(Pruned turns ${tailStart}–${totalTurnsCount})_`,
      );
    }
  }

  sections.push(backboneLines.join('\n'));

  // 6. Lossless traceback pointer so trimmed raw logs remain recoverable on demand (anti-degradation)
  const prunedItemSteps = [];
  for (const turn of turns) {
    const turnItems = Array.isArray(turn.items) ? turn.items : [];
    for (const item of turnItems) {
      const picked = selectedItemsByTurn.get(turn.id)?.some((p) => p.id === item.id);
      if (!picked && (item.resultBytes > 4096 || item.isError)) {
        const idx = item.resultStepIndex ?? item.plannerStepIndex;
        if (idx !== null && idx !== undefined) {
          prunedItemSteps.push(`step#${idx}(${item.toolName || 'tool'}${item.isError ? ',ERR' : ''})`);
        }
      }
    }
  }
  const sourceLogPath = session.fullFilePath || session.filePath || '';
  if (totalItemsCount > selectedItemsCount && sourceLogPath) {
    const traceLines = [
      '## Lossless Verbatim Traceback Index',
      '',
      `- Full source transcript: \`${sourceLogPath}\``,
      `- All selected user requests, assistant conclusions, touched files, and live Git state are preserved verbatim; only ${totalItemsCount - selectedItemsCount} verbose tool logs/progress steps were folded.`,
    ];
    if (prunedItemSteps.length > 0) {
      const shown = prunedItemSteps.slice(-16);
      const more = prunedItemSteps.length > 16 ? ` (${prunedItemSteps.length} steps total)` : '';
      traceLines.push(`- If you need the exact raw output of a folded step, read the corresponding \`step_index\` directly from the transcript above (never guess): ${shown.join(', ')}${more}.`);
    }
    sections.push(traceLines.join('\n'));
  }

  const rawMarkdown = `${sections.join('\n\n---\n\n')}\n`;

  let markdown = rawMarkdown;
  let redactionCount = 0;
  let redactionFindings = [];

  if (redact !== false) {
    const redRes = redactSensitive(rawMarkdown, { enabled: true });
    markdown = redRes.text;
    redactionCount = redRes.count;
    redactionFindings = redRes.findings;
  }

  const bytes = Buffer.byteLength(markdown, 'utf-8');
  const estimatedTokens = estimateTokens(markdown);

  const estimatedTotalTurnTokens = turns.reduce(
    (sum, t) => sum + (Number(t.estimatedTurnTokens) || 0),
    0,
  );
  const originalPeakTokens =
    Number(session.peakContextTokens) > 0
      ? Math.floor(Number(session.peakContextTokens))
      : estimatedTotalTurnTokens;

  const savedPercent =
    originalPeakTokens > 0
      ? Math.max(0, Math.min(99, Math.round((1 - estimatedTokens / originalPeakTokens) * 100)))
      : 0;

  const recommendFileMode = bytes > INLINE_LIMIT_BYTES;

  return {
    markdown,
    bytes,
    estimatedTokens,
    originalPeakTokens,
    savedPercent,
    redactionCount,
    redactionFindings,
    selectedTurnsCount,
    totalTurnsCount,
    selectedItemsCount,
    totalItemsCount,
    recommendFileMode,
  };
}

/**
 * Build either an inline prompt or a compact (<= 1.5 KB) file-based launch prompt.
 *
 * @param {{
 *   bundle: { markdown?: string, bytes?: number },
 *   handoffFilePath?: string,
 *   targetWorkspace?: string,
 *   extraInstruction?: string,
 *   forceFileMode?: boolean,
 *   redact?: boolean,
 * }} params
 * @returns {{ mode: 'inline' | 'file', prompt: string }}
 */
export function buildLaunchPrompt(params = {}) {
  const {
    bundle = {},
    handoffFilePath = '',
    targetWorkspace = '',
    extraInstruction = '',
    forceFileMode = false,
    redact = true,
  } = params || {};

  const shouldRedact = redact !== false;
  const rawBundleMarkdown = typeof bundle?.markdown === 'string' ? bundle.markdown : '';
  const effectiveMarkdown = shouldRedact
    ? redactSensitive(rawBundleMarkdown, { enabled: true }).text
    : rawBundleMarkdown;

  const actualMarkdownBytes = Buffer.byteLength(effectiveMarkdown, 'utf-8');
  const declaredBytes =
    typeof bundle?.bytes === 'number' && Number.isFinite(bundle.bytes) && bundle.bytes >= 0
      ? bundle.bytes
      : 0;
  const bundleBytes = Math.max(declaredBytes, actualMarkdownBytes);

  const normalizedHandoffPath =
    typeof handoffFilePath === 'string' ? handoffFilePath.trim() : '';
  const exceedsHardLimit = bundleBytes > HARD_INLINE_LIMIT_BYTES;

  // Hard guard: never inline when handoffFilePath is set, when bundle exceeds INLINE_LIMIT_BYTES,
  // or when approaching Windows 32 KB CreateProcess command-line limit (28 KB hard ceiling).
  if (
    !forceFileMode &&
    !exceedsHardLimit &&
    !normalizedHandoffPath &&
    bundleBytes <= INLINE_LIMIT_BYTES
  ) {
    return {
      mode: 'inline',
      prompt: effectiveMarkdown,
    };
  }

  const baseLines = [
    'This is a surgically pruned context handoff session created by Context Relay.',
    '',
    `- **Handoff Document**: \`${normalizedHandoffPath || '(handoff path not provided)'}\``,
  ];

  if (typeof targetWorkspace === 'string' && targetWorkspace.trim()) {
    baseLines.push(`- **Target Workspace**: \`${targetWorkspace.trim()}\``);
  }

  baseLines.push(
    '',
    'Follow these steps to resume:',
    '1. Call `read_file` on the handoff document above to review the curated conversation backbone, touched files, and live Git repository anchor.',
    '2. Continue seamlessly from the current state without repeating completed work.',
  );

  let prompt = baseLines.join('\n');
  const rawExtra = typeof extraInstruction === 'string' ? extraInstruction.trim() : '';
  const trimmedExtra =
    rawExtra && shouldRedact ? redactSensitive(rawExtra, { enabled: true }).text : rawExtra;

  if (trimmedExtra) {
    const extraHeader = '\n\nExplicit Continuation Instruction:\n';
    const fullCandidate = `${prompt}${extraHeader}${trimmedExtra}`;
    if (Buffer.byteLength(fullCandidate, 'utf-8') <= MAX_FILE_LAUNCH_PROMPT_BYTES) {
      prompt = fullCandidate;
    } else {
      const truncNotice = '\n… (see full instruction at top of handoff document)';
      const remaining =
        MAX_FILE_LAUNCH_PROMPT_BYTES -
        Buffer.byteLength(prompt, 'utf-8') -
        Buffer.byteLength(extraHeader, 'utf-8') -
        Buffer.byteLength(truncNotice, 'utf-8');
      if (remaining > 32) {
        prompt = `${prompt}${extraHeader}${sliceUtf8Prefix(trimmedExtra, remaining).trimEnd()}${truncNotice}`;
      } else {
        const shortNote = '\n\n(The explicit continuation instruction is pinned at the top of the handoff document.)';
        if (
          Buffer.byteLength(prompt + shortNote, 'utf-8') <= MAX_FILE_LAUNCH_PROMPT_BYTES
        ) {
          prompt += shortNote;
        }
      }
    }
  }

  if (shouldRedact) {
    prompt = redactSensitive(prompt, { enabled: true }).text;
  }

  if (Buffer.byteLength(prompt, 'utf-8') > MAX_FILE_LAUNCH_PROMPT_BYTES) {
    prompt = sliceUtf8Prefix(prompt, MAX_FILE_LAUNCH_PROMPT_BYTES);
  }

  return {
    mode: 'file',
    prompt,
  };
}

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

  const placeholderMarker = `\n\n... [内容过长，中间已省略约 ${totalBytes} 字节，保留首尾上下文] ...\n\n`;
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
  const marker = `\n\n... [内容过长，中间已省略约 ${omitted} 字节，保留首尾上下文] ...\n\n`;
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
  if (item.isError) return '失败';
  switch (item.category) {
    case 'write':
      return '写入';
    case 'read':
      return '读取';
    case 'command':
      return '命令';
    case 'search':
      return '检索';
    case 'meta':
      return '元操作';
    default:
      return '工具';
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
  const title = truncateText(session.title || '未命名会话', 120) || '未命名会话';
  const sessionId = session.sessionId || '未知';
  const primaryModel = session.lastModel || session.firstModel || '未知';
  const allModels =
    Array.isArray(session.modelsUsed) && session.modelsUsed.length > 0
      ? session.modelsUsed.join(', ')
      : primaryModel;
  const modelLine =
    allModels && allModels !== primaryModel
      ? `${primaryModel}（历史使用：${allModels}）`
      : primaryModel;
  const effectiveWorkspace = targetWorkspace || session.workspacePath || '未指定';
  const generatedAt = new Date().toISOString();

  const headerLines = [
    '# ContextRelay 上下文交接包',
    '',
    `- **源会话标题**：${title}`,
    `- **源会话 ID**：\`${sessionId}\``,
    `- **源模型**：${modelLine}`,
    `- **目标目录**：\`${effectiveWorkspace}\``,
    `- **生成时间**：${generatedAt}`,
    `- **裁剪统计**：保留 ${selectedTurnsCount}/${totalTurnsCount} 轮对话，保留 ${selectedItemsCount}/${totalItemsCount} 条工具步骤`,
  ];
  if (session.isSubagent && session.parentSessionId) {
    headerLines.splice(4, 0, `- **源父会话 ID**：\`${session.parentSessionId}\`（子代理会话）`);
  }
  sections.push(headerLines.join('\n'));

  // 2. Explicit extra instruction (pinned at top)
  const trimmedInstruction =
    typeof extraInstruction === 'string' ? extraInstruction.trim() : '';
  if (trimmedInstruction) {
    sections.push(`## 本次续接明确指令\n\n${trimmedInstruction}`);
  }

  // 3. Deterministic Git anchor
  if (gitAnchor && gitAnchor.isGitRepo) {
    const anchorDir = gitAnchor.workspacePath || gitAnchor.repoRoot || '';
    const gitLines = [
      '## 当前仓库真实状态锚点（确定性采集）',
      '',
      `- **采集目录**：\`${anchorDir}\``,
      `- **仓库根目录**：\`${gitAnchor.repoRoot || ''}\``,
      `- **当前分支**：\`${gitAnchor.branch || '(detached/unborn)'}\``,
      `- **最新提交**：\`${gitAnchor.headSha || '无提交'}\`${
        gitAnchor.headSubject ? ` — ${gitAnchor.headSubject}` : ''
      }`,
      `- **工作区变更统计**：已跟踪变更 ${gitAnchor.dirtyCount ?? 0} 项，未跟踪文件 ${
        gitAnchor.untrackedCount ?? 0
      } 项`,
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
          `- **跨项目提示**：上述 Git 状态采集自 \`${anchorDir}\`，与目标目录 \`${trimmedTargetWs}\` 不同，请勿混淆两个目录的仓库状态`,
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
      gitLines.push('', '### git diff 片段', '', safeCodeFence(gitAnchor.diffSnippet, 'diff'));
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

    const fileLines = ['## 会话触碰文件清单'];
    if (modified.length === 0 && readOnly.length === 0) {
      fileLines.push('', '- （本会话未记录文件修改或读取）');
    } else {
      if (modified.length > 0) {
        fileLines.push('', `### 修改 / 新建文件（${modified.length}）`, '');
        for (const f of modified) {
          fileLines.push(`- \`${f}\``);
        }
      }
      if (readOnly.length > 0) {
        fileLines.push('', `### 关键读取文件（${readOnly.length}）`, '');
        const displayRead = readOnly.slice(0, MAX_READ_FILES_DISPLAY);
        for (const f of displayRead) {
          fileLines.push(`- \`${f}\``);
        }
        if (readOnly.length > MAX_READ_FILES_DISPLAY) {
          fileLines.push(`- ... 另有 ${readOnly.length - MAX_READ_FILES_DISPLAY} 个已读文件已省略`);
        }
      }
    }
    sections.push(fileLines.join('\n'));
  }

  // 5. Selected conversation backbone
  const backboneLines = ['## 精选对话脉络（已外科剪枝）'];

  if (selectedTurns.length === 0) {
    backboneLines.push(
      '',
      '（未保留历史对话轮次，请直接依据上方续接指令与仓库状态锚点开展工作。）',
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
            ? `> _（已剪除第 ${gapStart} 轮对话）_`
            : `> _（已剪除第 ${gapStart}–${gapEnd} 轮对话）_`,
        );
      }
      prevIndex = turn.index;

      const roleTag = turn.sourceType === 'SYSTEM_MESSAGE' ? '（子代理任务）' : '';
      backboneLines.push('', `### 第 ${turn.index} 轮${roleTag}`);

      const metaParts = [];
      if (turn.model) metaParts.push(`模型：${turn.model}`);
      if (turn.createdAt) metaParts.push(`时间：${turn.createdAt}`);
      if (Array.isArray(turn.filesModified) && turn.filesModified.length > 0) {
        metaParts.push(`修改文件：${turn.filesModified.length} 个`);
      }
      if (metaParts.length > 0) {
        backboneLines.push(`_${metaParts.join(' · ')}_`);
      }

      const cleanUser = preserveHeadTailUtf8(turn.userText || '（空）', MAX_SINGLE_BLOCK_BYTES);
      backboneLines.push('', '#### 用户请求', '', cleanUser);

      const pickedItems = selectedItemsByTurn.get(turn.id) || [];
      if (includeToolDetails && pickedItems.length > 0) {
        backboneLines.push('', '#### 关键工具动作', '');
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
                `  _以下为 step#${item.resultStepIndex ?? item.plannerStepIndex} 按需展开的完整输出（单步上限 12 KB）：_`,
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
        backboneLines.push('', '#### AI 关键结论', '', replyBody);
      }
    }

    if (prevIndex < totalTurnsCount) {
      const tailStart = prevIndex + 1;
      backboneLines.push(
        '',
        tailStart === totalTurnsCount
          ? `> _（已剪除第 ${tailStart} 轮对话）_`
          : `> _（已剪除第 ${tailStart}–${totalTurnsCount} 轮对话）_`,
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
      '## 原文无损回溯索引（防降智保底）',
      '',
      `- 完整原始日志：\`${sourceLogPath}\``,
      `- 本交接包已完整保留全部选中轮次的原始需求、AI 结论、修改文件清单与真实 Git 状态；仅折叠了 ${totalItemsCount - selectedItemsCount} 步冗长工具日志/进度条。`,
    ];
    if (prunedItemSteps.length > 0) {
      const shown = prunedItemSteps.slice(-16);
      const more = prunedItemSteps.length > 16 ? ` 等共 ${prunedItemSteps.length} 步` : '';
      traceLines.push(`- 如确需复核某步完整原始输出，请直接按行读取上述日志对应 \`step_index\`（严禁猜测）：${shown.join('、')}${more}。`);
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
    '这是一次由 ContextRelay 外科剪枝生成的上下文交接会话。',
    '',
    `- **交接文档路径**：\`${normalizedHandoffPath || '(未提供交接文件路径)'}\``,
  ];

  if (typeof targetWorkspace === 'string' && targetWorkspace.trim()) {
    baseLines.push(`- **目标工作区**：\`${targetWorkspace.trim()}\``);
  }

  baseLines.push(
    '',
    '请严格按以下步骤开始：',
    '1. 首先调用 `read_file` 读取上述交接文档，核实剪枝后的对话脉络、已修改文件清单以及当前 Git 仓库真实状态锚点；',
    '2. 核实完成后，直接衔接当前状态继续执行后续工作，避免重复已完成步骤。',
  );

  let prompt = baseLines.join('\n');
  const rawExtra = typeof extraInstruction === 'string' ? extraInstruction.trim() : '';
  const trimmedExtra =
    rawExtra && shouldRedact ? redactSensitive(rawExtra, { enabled: true }).text : rawExtra;

  if (trimmedExtra) {
    const extraHeader = '\n\n本次续接明确指令：\n';
    const fullCandidate = `${prompt}${extraHeader}${trimmedExtra}`;
    if (Buffer.byteLength(fullCandidate, 'utf-8') <= MAX_FILE_LAUNCH_PROMPT_BYTES) {
      prompt = fullCandidate;
    } else {
      const truncNotice = '\n…（完整指令见交接文档顶部）';
      const remaining =
        MAX_FILE_LAUNCH_PROMPT_BYTES -
        Buffer.byteLength(prompt, 'utf-8') -
        Buffer.byteLength(extraHeader, 'utf-8') -
        Buffer.byteLength(truncNotice, 'utf-8');
      if (remaining > 32) {
        prompt = `${prompt}${extraHeader}${sliceUtf8Prefix(trimmedExtra, remaining).trimEnd()}${truncNotice}`;
      } else {
        const shortNote = '\n\n（本次续接明确指令已置顶写入交接文档，请读取后执行。）';
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

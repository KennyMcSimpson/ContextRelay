import { truncateText } from './fs-utils.mjs';

const IN_PROGRESS_STATUSES = new Set(['PENDING', 'RUNNING', 'IN_PROGRESS', 'STREAMING']);

const WRITE_TOOLS = new Set([
  'edit_file',
  'write_file',
  'multi_replace_file_content',
  'replace_file_content',
  'write_to_file',
]);

const READ_TOOLS = new Set([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
]);

const META_TOOLS = new Set([
  'update_focus',
  'update_steps',
  'manage_subagents',
  'manage_task',
  'list_dir',
  'list_resources',
  'list_plugin_accounts',
  'schedule',
  'task_boundary',
]);

const SEARCH_TOOLS = new Set([
  'grep_search',
  'find_by_name',
  'search_web',
  'search_marketplace',
]);

const COMMAND_TOOLS = new Set([
  'run_command',
  'command_status',
  'send_command_input',
]);

const NOISE_BYTES_THRESHOLD = 4096;
const RESULT_PREVIEW_MAX_CHARS = 600;

const CJK_RE =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g;

const SYSTEM_TAG_STRIP_RES = [
  /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi,
  /<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi,
  /<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi,
  /<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/gi,
  /<ENVIRONMENT_DETAILS>[\s\S]*?<\/ENVIRONMENT_DETAILS>/gi,
  /<IDE_CONTEXT>[\s\S]*?<\/IDE_CONTEXT>/gi,
  /<ACTIVE_DOCUMENT>[\s\S]*?<\/ACTIVE_DOCUMENT>/gi,
  /<OPEN_FILES>[\s\S]*?<\/OPEN_FILES>/gi,
];

const ERROR_TEXT_GENERAL_RE =
  /Encountered error|Command exited with code [1-9]\d*|Traceback|Error:/;
const ERROR_TEXT_READ_TOOL_RE = /Encountered error/;

function toNonNegInt(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function safeTruncate(text, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  if (text.length <= maxChars) return text;
  const result = truncateText(text, maxChars);
  return typeof result === 'string' ? result : text.slice(0, maxChars);
}

function normalizePathKey(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  const unified = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

function pushUniquePath(list, seenSet, rawPath) {
  if (!rawPath) return;
  const key = normalizePathKey(rawPath);
  if (!key || seenSet.has(key)) return;
  seenSet.add(key);
  list.push(rawPath);
}

/**
 * Estimate token count with separate weights for CJK and non-CJK characters.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

/**
 * Unwrap Antigravity tool argument values that may be wrapped in extra JSON quotes.
 * E.g. "\"E:\\\\path\\\\file.js\"" -> "E:\\path\\file.js"
 *
 * @param {unknown} val
 * @returns {string}
 */
export function unwrapToolArg(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'string') {
    if (typeof val === 'number' || typeof val === 'boolean') {
      return String(val);
    }
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }

  let current = val;
  for (let depth = 0; depth < 2; depth += 1) {
    if (current.length >= 2 && current.startsWith('"') && current.endsWith('"')) {
      try {
        const parsed = JSON.parse(current);
        if (typeof parsed === 'string') {
          current = parsed;
          continue;
        }
      } catch {
        return current;
      }
    }
    break;
  }
  return current;
}

function parseRawArgs(tc) {
  const raw = tc?.args ?? tc?.arguments ?? {};
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      obj = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {};
  }

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[k] = unwrapToolArg(v);
    } else if (v === null || v === undefined) {
      out[k] = '';
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function extractModelFromSettingsChange(text) {
  if (typeof text !== 'string' || !text) return '';
  const blocks = [...text.matchAll(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/gi)];
  if (blocks.length === 0) return '';

  let foundModel = '';
  for (const block of blocks) {
    const body = block[1] || '';
    const patterns = [
      /(?:changed|switched)(?:\s+the)?\s+model(?:\s+from\s+[^\s,;]+)?\s+to\s+["'`]?([A-Za-z0-9._:/-]+)["'`]?/i,
      /<model>\s*([A-Za-z0-9._:/-]+)\s*<\/model>/i,
      /\bmodel\s*[:=]\s*["'`]?([A-Za-z0-9._:/-]+)["'`]?/i,
    ];
    for (const re of patterns) {
      const m = body.match(re);
      if (m && m[1]) {
        const cleaned = m[1].replace(/[.,;]+$/, '').trim();
        if (cleaned) {
          foundModel = cleaned;
          break;
        }
      }
    }
  }
  return foundModel;
}

function extractUserRequest(content, media) {
  const raw = typeof content === 'string' ? content : '';
  const settingsModel = extractModelFromSettingsChange(raw);

  const reqMatches = [...raw.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  let cleanText = '';
  if (reqMatches.length > 0) {
    cleanText = reqMatches
      .map((m) => (m[1] || '').trim())
      .filter(Boolean)
      .join('\n\n');
  } else {
    let stripped = raw;
    const unclosedReq = stripped.match(/<USER_REQUEST>([\s\S]*)$/i);
    if (unclosedReq && typeof unclosedReq[1] === 'string') {
      stripped = unclosedReq[1];
    }
    for (const re of SYSTEM_TAG_STRIP_RES) {
      stripped = stripped.replace(re, '');
    }
    cleanText = stripped.replace(/<\/?USER_REQUEST>/gi, '').trim();
  }

  if (!cleanText) {
    if (Array.isArray(media) && media.length > 0) {
      cleanText = `[Attachment input x${media.length}]`;
    } else if (settingsModel) {
      cleanText = `(Settings change: switched model to ${settingsModel})`;
    }
  }

  return {
    userText: cleanText,
    settingsModel,
  };
}

function parseSystemMessage(content) {
  let raw = typeof content === 'string' ? content.trim() : '';
  const lower = raw.toLowerCase();
  const openTag = '<system_message>';
  const closeTag = '</system_message>';
  const openIdx = lower.indexOf(openTag);
  if (openIdx !== -1) {
    const closeIdx = lower.indexOf(closeTag, openIdx + openTag.length);
    if (closeIdx !== -1) {
      raw = raw.slice(openIdx + openTag.length, closeIdx).trim();
    }
  }

  const headerSlice = raw.length > 2048 ? raw.slice(0, 2048) : raw;
  const isSessionStartHook = /injected by a SessionStart hook/i.test(headerSlice);
  const senderMatch = headerSlice.match(/\bsender=([^\s\]\r\n]+)/);
  const sender = senderMatch ? senderMatch[1].trim() : '';

  // O(N) linear scan for "[Message] ... content=" to avoid O(N^2) regex backtracking
  let body = raw;
  const msgIdx = raw.indexOf('[Message]');
  if (msgIdx !== -1) {
    const nlIdx = raw.indexOf('\n', msgIdx);
    const crIdx = raw.indexOf('\r', msgIdx);
    let headerEnd = raw.length;
    if (nlIdx !== -1 && nlIdx < headerEnd) headerEnd = nlIdx;
    if (crIdx !== -1 && crIdx < headerEnd) headerEnd = crIdx;

    let searchFrom = msgIdx + '[Message]'.length;
    while (searchFrom < headerEnd) {
      const contentIdx = raw.indexOf('content=', searchFrom);
      if (contentIdx === -1 || contentIdx >= headerEnd) break;
      const prevCode = contentIdx > 0 ? raw.charCodeAt(contentIdx - 1) : 32;
      // Word boundary before "content=" (space, tab, or closing bracket ']')
      if (prevCode === 32 || prevCode === 9 || prevCode === 93) {
        body = raw.slice(contentIdx + 'content='.length).trim();
        break;
      }
      searchFrom = contentIdx + 1;
    }
  }

  return {
    raw,
    body,
    sender,
    isSessionStartHook,
    isSubagentDirective: Boolean(sender),
  };
}

function classifyTool(toolName) {
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  if (META_TOOLS.has(toolName)) return 'meta';
  if (COMMAND_TOOLS.has(toolName)) return 'command';
  if (SEARCH_TOOLS.has(toolName)) return 'search';
  return 'other';
}

function extractTargetPath(toolName, args) {
  const fileKeys = ['Path', 'AbsolutePath', 'TargetFile', 'path', 'FilePath', 'file_path'];
  for (const key of fileKeys) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      return args[key].trim();
    }
  }
  if (!WRITE_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) {
    const fallbackKeys = ['DirectoryPath', 'SearchPath', 'TargetDirectory', 'Cwd', 'Uri'];
    for (const key of fallbackKeys) {
      if (typeof args[key] === 'string' && args[key].trim()) {
        return args[key].trim();
      }
    }
  }
  return '';
}

function buildActionSummary(toolName, category, args, targetPath, command) {
  if (category === 'write') {
    return `${toolName} ${targetPath || '(unspecified path)'}`;
  }
  if (category === 'read') {
    const start = args.StartLine ?? args.startLine;
    const end = args.EndLine ?? args.endLine;
    const range = start || end ? ` (L${start || 1}-${end || 'EOF'})` : '';
    return `${toolName} ${targetPath || '(unspecified path)'}${range}`;
  }
  if (category === 'command') {
    const summaryLabel =
      typeof args.toolSummary === 'string' && args.toolSummary.trim()
        ? `[${args.toolSummary.trim()}] `
        : '';
    const oneLineCmd = command.replace(/\s+/g, ' ').trim();
    return `${toolName}: ${summaryLabel}${safeTruncate(oneLineCmd || '(empty command)', 140)}`;
  }
  if (category === 'search') {
    const q = args.Query || args.query || args.Pattern || args.pattern || '';
    const loc = targetPath ? ` @ ${targetPath}` : '';
    return `${toolName}: ${safeTruncate(String(q || targetPath || ''), 120)}${q ? loc : ''}`;
  }
  if (targetPath) {
    return `${toolName} ${targetPath}`;
  }
  if (toolName === 'invoke_subagent' && (args.Role || args.TypeName)) {
    return `${toolName} (${args.TypeName || 'subagent'}: ${args.Role || ''})`;
  }
  return toolName;
}

function detectStepError(toolName, resultStep, resultContent, resultBytes) {
  const statusUpper =
    typeof resultStep?.status === 'string' ? resultStep.status.toUpperCase() : '';
  if (statusUpper === 'ERROR') return true;
  if (!resultContent) return false;

  if (READ_TOOLS.has(toolName)) {
    if (ERROR_TEXT_READ_TOOL_RE.test(resultContent)) return true;
    // Only treat generic "Error:" / "Traceback" inside read_file as a tool error when
    // the payload is short (an actual error message rather than source code content).
    if (resultBytes < 512 && ERROR_TEXT_GENERAL_RE.test(resultContent)) return true;
    return false;
  }

  return ERROR_TEXT_GENERAL_RE.test(resultContent);
}

function extractTitleFromText(text, fallback = 'Untitled session') {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').replace(/^[-*>\s]+/, '').trim())
    .filter(Boolean);
  const firstLine = lines[0] || text.trim();
  const singleLine = firstLine.replace(/\s+/g, ' ').trim();
  return safeTruncate(singleLine, 80) || fallback;
}

function truncateMultiline(text, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 1) return '…';
  let cut = trimmed.slice(0, maxChars - 1);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

function finalizeItemWithResult(item, resultStep) {
  const resultContent = typeof resultStep?.content === 'string' ? resultStep.content : '';
  const resultBytes = Buffer.byteLength(resultContent, 'utf-8');
  const status = typeof resultStep?.status === 'string' ? resultStep.status : 'UNKNOWN';
  const truncated = Boolean(
    Array.isArray(resultStep?.truncated_fields) &&
      resultStep.truncated_fields.includes('content'),
  );
  const isError = detectStepError(item.toolName, resultStep, resultContent, resultBytes);
  const isNoisy =
    resultBytes > NOISE_BYTES_THRESHOLD || isError || item.isMeta || item.isDuplicateRead;

  let defaultInclude = false;
  if (item.isWrite && !isError) {
    defaultInclude = true;
  } else if (!isNoisy && !item.isMeta && resultBytes <= NOISE_BYTES_THRESHOLD) {
    defaultInclude = true;
  }

  item.resultStepIndex =
    resultStep && resultStep.step_index !== undefined ? resultStep.step_index : null;
  item.status = status;
  item.truncated = truncated;
  item.resultBytes = resultBytes;
  item.resultTokens = estimateTokens(resultContent);
  item.resultPreview = truncateMultiline(resultContent, RESULT_PREVIEW_MAX_CHARS);
  item.isError = isError;
  item.isNoisy = isNoisy;
  item.defaultInclude = defaultInclude;
}

/**
 * Parse Antigravity transcript.jsonl step objects into structured turns and tool items.
 *
 * @param {Array<object>} steps
 * @param {object} [meta]
 */
export function parseSessionTranscript(steps, meta = {}) {
  const safeSteps = Array.isArray(steps) ? steps : [];
  const safeMeta = meta && typeof meta === 'object' ? meta : {};

  const sessionId = String(safeMeta.sessionId || safeMeta.id || '');
  const workspacePath = String(safeMeta.workspacePath || '');

  const modelsUsed = [];
  const modelsUsedSet = new Set();
  let firstModel = '';
  let lastModel = '';

  const recordSessionModel = (m) => {
    if (typeof m !== 'string') return;
    const trimmed = m.trim();
    if (!trimmed) return;
    if (!firstModel) firstModel = trimmed;
    lastModel = trimmed;
    if (!modelsUsedSet.has(trimmed)) {
      modelsUsedSet.add(trimmed);
      modelsUsed.push(trimmed);
    }
  };

  let createdAt = typeof safeMeta.createdAt === 'string' ? safeMeta.createdAt : '';
  let updatedAt = typeof safeMeta.updatedAt === 'string' ? safeMeta.updatedAt : '';
  let parentSessionId = typeof safeMeta.parentSessionId === 'string' ? safeMeta.parentSessionId : '';
  let isSubagent = Boolean(safeMeta.isSubagent || parentSessionId);

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let peakContextTokens = 0;

  const sessionModified = [];
  const sessionModifiedSet = new Set();
  const sessionRead = [];
  const sessionReadSet = new Set();
  const seenReadPathKeys = new Set();

  const hasAnyUserInput = safeSteps.some((s) => s && s.type === 'USER_INPUT');

  const turns = [];
  let currentTurn = null;
  let pendingToolCalls = [];
  let fallbackSystemStep = null;

  const flushPendingCalls = () => {
    while (pendingToolCalls.length > 0) {
      const item = pendingToolCalls.shift();
      finalizeItemWithResult(item, null);
    }
  };

  const openTurn = ({ sourceType, stepIndex, createdAt: ts, userText, rawLength }) => {
    flushPendingCalls();
    const index = turns.length + 1;
    const turn = {
      id: `turn-${index}`,
      index,
      sourceType,
      stepIndex,
      createdAt: ts || '',
      userText: userText || '',
      rawUserLength: rawLength || 0,
      assistantReplies: [],
      assistantText: '',
      model: '',
      modelsUsed: [],
      _modelsSet: new Set(),
      items: [],
      filesModified: [],
      _filesModifiedSet: new Set(),
      filesRead: [],
      _filesReadSet: new Set(),
      contextTokensAfter: 0,
      deltaContextTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      estimatedTurnTokens: 0,
      totalResultBytes: 0,
      noiseBytes: 0,
      noiseRatio: 0,
      errorCount: 0,
      stepRange: {
        start: stepIndex,
        end: stepIndex,
      },
    };
    turns.push(turn);
    currentTurn = turn;
    return turn;
  };

  const recordTurnModel = (turn, m) => {
    if (!turn || typeof m !== 'string') return;
    const trimmed = m.trim();
    if (!trimmed) return;
    turn.model = trimmed;
    if (!turn._modelsSet.has(trimmed)) {
      turn._modelsSet.add(trimmed);
      turn.modelsUsed.push(trimmed);
    }
  };

  for (let i = 0; i < safeSteps.length; i += 1) {
    const step = safeSteps[i];
    if (!step || typeof step !== 'object') continue;

    const stepIndex = step.step_index !== undefined ? step.step_index : i;
    const ts = typeof step.created_at === 'string' ? step.created_at : '';
    if (ts) {
      if (!createdAt || ts < createdAt) createdAt = ts;
      if (!updatedAt || ts > updatedAt) updatedAt = ts;
    }

    const type = step.type;

    if (type === 'USER_INPUT') {
      const rawContent = typeof step.content === 'string' ? step.content : '';
      const { userText, settingsModel } = extractUserRequest(rawContent, step.media);
      const turn = openTurn({
        sourceType: 'USER_INPUT',
        stepIndex,
        createdAt: ts,
        userText,
        rawLength: rawContent.length,
      });
      if (settingsModel) {
        recordSessionModel(settingsModel);
        recordTurnModel(turn, settingsModel);
      }
      continue;
    }

    if (type === 'SYSTEM_MESSAGE') {
      const parsed = parseSystemMessage(step.content);
      if (parsed.sender && !parentSessionId) {
        parentSessionId = parsed.sender;
      }

      if (!currentTurn) {
        if (parsed.isSubagentDirective) {
          isSubagent = true;
          openTurn({
            sourceType: 'SYSTEM_MESSAGE',
            stepIndex,
            createdAt: ts,
            userText: parsed.body || parsed.raw,
            rawLength: parsed.raw.length,
          });
        } else if (!hasAnyUserInput && !parsed.isSessionStartHook && parsed.body) {
          isSubagent = true;
          openTurn({
            sourceType: 'SYSTEM_MESSAGE',
            stepIndex,
            createdAt: ts,
            userText: parsed.body,
            rawLength: parsed.raw.length,
          });
        } else if (!fallbackSystemStep && parsed.body) {
          fallbackSystemStep = { stepIndex, createdAt: ts, parsed };
        }
      } else if (
        !hasAnyUserInput &&
        parsed.isSubagentDirective &&
        currentTurn.assistantReplies.length > 0 &&
        (!parentSessionId || parsed.sender === parentSessionId)
      ) {
        openTurn({
          sourceType: 'SYSTEM_MESSAGE',
          stepIndex,
          createdAt: ts,
          userText: parsed.body || parsed.raw,
          rawLength: parsed.raw.length,
        });
      }
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const statusUpper = typeof step.status === 'string' ? step.status.toUpperCase() : '';
      if (IN_PROGRESS_STATUSES.has(statusUpper)) {
        continue;
      }

      if (!currentTurn) {
        if (fallbackSystemStep) {
          if (!hasAnyUserInput) isSubagent = true;
          openTurn({
            sourceType: 'SYSTEM_MESSAGE',
            stepIndex: fallbackSystemStep.stepIndex,
            createdAt: fallbackSystemStep.createdAt,
            userText: fallbackSystemStep.parsed.body || fallbackSystemStep.parsed.raw,
            rawLength: fallbackSystemStep.parsed.raw.length,
          });
          fallbackSystemStep = null;
        } else {
          openTurn({
            sourceType: 'SYSTEM_MESSAGE',
            stepIndex,
            createdAt: ts,
            userText: '(no explicit user input)',
            rawLength: 0,
          });
        }
      }

      currentTurn.stepRange.end = stepIndex;

      if (typeof step.model === 'string' && step.model.trim()) {
        recordSessionModel(step.model);
        recordTurnModel(currentTurn, step.model);
      }

      const inTok = toNonNegInt(step.input_tokens);
      const cacheTok = toNonNegInt(step.cache_read_tokens);
      const outTok = toNonNegInt(step.output_tokens);
      totalInputTokens += inTok;
      totalCacheReadTokens += cacheTok;
      totalOutputTokens += outTok;
      currentTurn.inputTokens += inTok;
      currentTurn.cacheReadTokens += cacheTok;
      currentTurn.outputTokens += outTok;

      const stepContext = inTok + cacheTok;
      if (stepContext > peakContextTokens) {
        peakContextTokens = stepContext;
      }
      if (stepContext > 0) {
        currentTurn.contextTokensAfter = stepContext;
      }

      const replyText = typeof step.content === 'string' ? step.content.trim() : '';
      if (replyText) {
        currentTurn.assistantReplies.push({
          stepIndex,
          text: replyText,
          model: typeof step.model === 'string' ? step.model.trim() : currentTurn.model,
          createdAt: ts,
        });
      }

      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        // Any still-unpaired calls from a previous planner response are finalized first
        flushPendingCalls();

        for (let callIdx = 0; callIdx < step.tool_calls.length; callIdx += 1) {
          const tc = step.tool_calls[callIdx];
          const toolName = String(tc?.name || tc?.tool_name || 'unknown').trim() || 'unknown';
          const category = classifyTool(toolName);
          const args = parseRawArgs(tc);
          const targetPath = extractTargetPath(toolName, args);
          const command =
            typeof args.CommandLine === 'string'
              ? args.CommandLine
              : typeof args.command === 'string'
                ? args.command
                : typeof args.cmd === 'string'
                  ? args.cmd
                  : '';

          const isWrite = WRITE_TOOLS.has(toolName);
          const isRead = READ_TOOLS.has(toolName);
          const isMeta = META_TOOLS.has(toolName);

          let isDuplicateRead = false;
          if (isWrite && targetPath) {
            // Invalidating prior read records for this file: re-reading after a write is never noise.
            const writePathKey = normalizePathKey(targetPath);
            if (writePathKey) {
              const prefix = `${writePathKey}#`;
              for (const existingKey of [...seenReadPathKeys]) {
                if (existingKey === writePathKey || existingKey.startsWith(prefix)) {
                  seenReadPathKeys.delete(existingKey);
                }
              }
            }
          } else if (isRead && targetPath) {
            const pathKey = normalizePathKey(targetPath);
            const startLine = args.StartLine ?? args.start_line ?? args.startLine ?? '';
            const endLine = args.EndLine ?? args.end_line ?? args.endLine ?? '';
            const byteOffset = args.ByteOffset ?? args.byte_offset ?? args.byteOffset ?? '';
            const readKey = `${pathKey}#${startLine}-${endLine}-${byteOffset}`;
            if (seenReadPathKeys.has(readKey)) {
              isDuplicateRead = true;
            } else {
              seenReadPathKeys.add(readKey);
            }
          }

          if (isWrite && targetPath) {
            pushUniquePath(currentTurn.filesModified, currentTurn._filesModifiedSet, targetPath);
            pushUniquePath(sessionModified, sessionModifiedSet, targetPath);
          } else if (isRead && targetPath) {
            pushUniquePath(currentTurn.filesRead, currentTurn._filesReadSet, targetPath);
            pushUniquePath(sessionRead, sessionReadSet, targetPath);
          }

          const item = {
            id: `step-${stepIndex}-c${callIdx}`,
            turnId: currentTurn.id,
            turnIndex: currentTurn.index,
            toolName,
            category,
            targetPath,
            command,
            actionSummary: buildActionSummary(toolName, category, args, targetPath, command),
            plannerStepIndex: stepIndex,
            resultStepIndex: null,
            status: 'UNKNOWN',
            truncated: false,
            resultBytes: 0,
            resultTokens: 0,
            resultPreview: '',
            isWrite,
            isRead,
            isMeta,
            isDuplicateRead,
            isError: false,
            isNoisy: false,
            defaultInclude: false,
          };

          currentTurn.items.push(item);
          pendingToolCalls.push(item);
        }
      }
      continue;
    }

    if (type === 'GENERIC') {
      const statusUpper = typeof step.status === 'string' ? step.status.toUpperCase() : '';
      if (IN_PROGRESS_STATUSES.has(statusUpper)) {
        continue;
      }
      if (currentTurn) {
        currentTurn.stepRange.end = stepIndex;
      }
      if (pendingToolCalls.length > 0) {
        const item = pendingToolCalls.shift();
        finalizeItemWithResult(item, step);
      }
    }
  }

  flushPendingCalls();

  // If transcript only contained a fallback SYSTEM_MESSAGE and no other turns
  if (turns.length === 0 && fallbackSystemStep) {
    if (!hasAnyUserInput) isSubagent = true;
    openTurn({
      sourceType: 'SYSTEM_MESSAGE',
      stepIndex: fallbackSystemStep.stepIndex,
      createdAt: fallbackSystemStep.createdAt,
      userText: fallbackSystemStep.parsed.body || fallbackSystemStep.parsed.raw,
      rawLength: fallbackSystemStep.parsed.raw.length,
    });
  }

  // Finalize per-turn aggregate metrics and strip private helper sets
  let prevContextTokens = 0;
  for (const turn of turns) {
    if (turn.contextTokensAfter > 0) {
      turn.deltaContextTokens = Math.max(0, turn.contextTokensAfter - prevContextTokens);
      prevContextTokens = turn.contextTokensAfter;
    } else {
      turn.deltaContextTokens = 0;
    }

    turn.assistantText = turn.assistantReplies.map((r) => r.text).join('\n\n');

    let totalResultBytes = 0;
    let noiseBytes = 0;
    let errorCount = 0;
    let itemsTokens = 0;

    for (const item of turn.items) {
      totalResultBytes += item.resultBytes;
      if (item.isNoisy) noiseBytes += item.resultBytes;
      if (item.isError) errorCount += 1;
      itemsTokens += estimateTokens(item.actionSummary) + (item.resultTokens || 0);
    }

    const userBytes = Buffer.byteLength(turn.userText, 'utf-8');
    const assistantBytes = Buffer.byteLength(turn.assistantText, 'utf-8');
    const totalTurnBytes = userBytes + assistantBytes + totalResultBytes;

    turn.totalResultBytes = totalResultBytes;
    turn.noiseBytes = noiseBytes;
    turn.noiseRatio =
      totalTurnBytes > 0
        ? Number(Math.min(1, Math.max(0, noiseBytes / totalTurnBytes)).toFixed(4))
        : 0;
    turn.errorCount = errorCount;
    turn.estimatedTurnTokens =
      estimateTokens(turn.userText) + estimateTokens(turn.assistantText) + itemsTokens;

    delete turn._modelsSet;
    delete turn._filesModifiedSet;
    delete turn._filesReadSet;
  }

  if (!firstModel && typeof safeMeta.model === 'string' && safeMeta.model.trim()) {
    recordSessionModel(safeMeta.model);
  }

  const fallbackTitle = sessionId ? `Session ${sessionId.slice(0, 8)}` : 'Untitled session';
  const title =
    typeof safeMeta.title === 'string' && safeMeta.title.trim()
      ? safeMeta.title.trim()
      : turns.length > 0
        ? extractTitleFromText(turns[0].userText, fallbackTitle)
        : fallbackTitle;

  return {
    sessionId,
    workspacePath,
    title,
    firstModel,
    lastModel,
    modelsUsed,
    parentSessionId,
    isSubagent,
    createdAt,
    updatedAt,
    peakContextTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    totalSteps: safeSteps.length,
    filesTouched: {
      modified: sessionModified,
      read: sessionRead,
    },
    turns,
  };
}

/**
 * Compute turn and item selection IDs according to a context-surgery preset.
 *
 * @param {ReturnType<typeof parseSessionTranscript>} parsedSession
 * @param {'smart-clean' | 'backbone' | 'truncate-at' | 'all' | 'none'} [preset]
 * @param {{ maxTurnIndex?: number }} [options]
 * @returns {{ selectedTurnIds: string[], selectedItemIds: string[] }}
 */
export function applySurgeryPreset(parsedSession, preset = 'smart-clean', options = {}) {
  const turns = Array.isArray(parsedSession?.turns) ? parsedSession.turns : [];
  if (turns.length === 0 || preset === 'none') {
    return { selectedTurnIds: [], selectedItemIds: [] };
  }

  const selectedTurnIds = [];
  const selectedItemIds = [];

  if (preset === 'all') {
    for (const turn of turns) {
      selectedTurnIds.push(turn.id);
      for (const item of turn.items || []) {
        selectedItemIds.push(item.id);
      }
    }
    return { selectedTurnIds, selectedItemIds };
  }

  if (preset === 'backbone') {
    const total = turns.length;
    const recentStartIndex = Math.max(1, total - 2); // last 3 turns: total-2, total-1, total
    for (const turn of turns) {
      const isFirst = turn.index === 1;
      const isRecent = turn.index >= recentStartIndex;
      const hasModification = Array.isArray(turn.filesModified) && turn.filesModified.length > 0;
      if (isFirst || isRecent || hasModification) {
        selectedTurnIds.push(turn.id);
        for (const item of turn.items || []) {
          if (item.isWrite || WRITE_TOOLS.has(item.toolName)) {
            selectedItemIds.push(item.id);
          }
        }
      }
    }
    return { selectedTurnIds, selectedItemIds };
  }

  if (preset === 'truncate-at') {
    const maxTurnIndex = Number(options?.maxTurnIndex || turns.length);
    for (const turn of turns) {
      if (turn.index <= maxTurnIndex) {
        selectedTurnIds.push(turn.id);
        for (const item of turn.items || []) {
          if (item.defaultInclude === true) {
            selectedItemIds.push(item.id);
          }
        }
      }
    }
    return { selectedTurnIds, selectedItemIds };
  }

  // Default: 'smart-clean'
  for (const turn of turns) {
    selectedTurnIds.push(turn.id);
    for (const item of turn.items || []) {
      if (item.defaultInclude === true) {
        selectedItemIds.push(item.id);
      }
    }
  }
  return { selectedTurnIds, selectedItemIds };
}

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileUriToPath, isNotSymlink, safeStat } from './fs-utils.mjs';

const CONV_ID_RE = /^[0-9a-zA-Z_-]{8,128}$/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const UNSAFE_SCRIPT_EXT_RE = /\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|com|sh|bash|zsh|ksh|csh|fish)$/i;
const MAX_SHIM_BYTES = 64 * 1024;
const MAX_TITLE_LEN = 256;
const DEFAULT_UNAVAILABLE_REASON =
  'ANTIGRAVITY_AGENTAPI_EXE not available (running outside Antigravity Sidecar)';

function safeTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeTitle(title) {
  let cleaned = safeTrimmedString(title)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= MAX_TITLE_LEN) return cleaned;
  cleaned = cleaned.slice(0, MAX_TITLE_LEN);
  const lastCode = cleaned.charCodeAt(cleaned.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned.trimEnd();
}

function execFileAsyncDefault(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        if (err.stderr === undefined && stderr) {
          err.stderr = stderr;
        }
        rejectPromise(err);
        return;
      }
      resolvePromise(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    });
  });
}

function safeUriToPath(uri) {
  const cleaned = safeTrimmedString(uri);
  if (!cleaned) return '';
  try {
    const decoded = fileUriToPath(cleaned);
    return typeof decoded === 'string' ? decoded : '';
  } catch {
    return '';
  }
}

function parseJsonLenient(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  if (typeof value === 'object') {
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos) && (seconds !== 0 || nanos !== 0)) {
      const date = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
      return Number.isNaN(date.getTime()) ? '' : date.toISOString();
    }
  }
  return '';
}

function formatExecError(err) {
  if (!err) return 'Unknown agentapi execution error';
  const parts = [];
  if (err.code === 'ETIMEDOUT' || (err.killed && err.signal)) {
    parts.push(`agentapi timed out or killed (${err.code || err.signal})`);
  } else if (typeof err.message === 'string' && err.message.trim()) {
    parts.push(err.message.trim().split(/\r?\n/)[0]);
  }
  const stderr =
    typeof err.stderr === 'string'
      ? err.stderr.trim()
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString('utf-8').trim()
        : '';
  if (stderr) {
    parts.push(stderr.slice(0, 400));
  }
  return parts.join(': ') || 'agentapi command failed';
}

function hasInvalidControlChars(value) {
  return typeof value === 'string' && value.includes('\0');
}

function extractConversationId(raw, stdoutText) {
  const candidates = [
    raw?.conversationId,
    raw?.conversation_id,
    raw?.id,
    raw?.response?.conversationId,
    raw?.response?.conversation_id,
    raw?.response?.id,
    raw?.conversation?.conversationId,
    raw?.conversation?.conversation_id,
    raw?.conversation?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && CONV_ID_RE.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  if (typeof stdoutText === 'string') {
    const match = stdoutText.match(UUID_RE);
    if (match) return match[0];
  }
  return '';
}

/**
 * Read-only parser for Antigravity agentapi shim scripts to extract the real native binary path.
 * Never executes the shim script itself.
 */
export function extractBinaryFromShim(content, platform = process.platform) {
  if (typeof content !== 'string') return '';
  const cleaned = content.replace(/^\uFEFF/, '');
  if (!cleaned.trim()) return '';

  const lines = cleaned.split(/\r?\n/);

  if (platform === 'win32') {
    const winPatterns = [
      /^\s*(?:call\s+)?"([^"\r\n]+\.exe)"\s+agentapi(?:\s|$)/i,
      /"([^"\r\n]+\.exe)"\s+agentapi(?:\s|$)/i,
      /"([^"\r\n]+\.exe)"/i,
    ];

    for (const pattern of winPatterns) {
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^(?:@?echo\b|rem\b|::)/i.test(line)) continue;
        const match = line.match(pattern);
        if (!match || !match[1]) continue;
        const candidate = match[1].trim();
        if (!candidate) continue;
        if (/[\0\r\n&|<>;"'`%]/.test(candidate)) continue;
        if (!/\.exe$/i.test(candidate)) continue;
        if (UNSAFE_SCRIPT_EXT_RE.test(candidate)) continue;
        return candidate;
      }
    }
    return '';
  }

  const posixPatterns = [
    /\bexec\s+"([^"\r\n]+)"\s+agentapi(?:\s|$)/,
    /\bexec\s+'([^'\r\n]+)'\s+agentapi(?:\s|$)/,
    /\bexec\s+([^\s"'`\r\n;&|<>]+)\s+agentapi(?:\s|$)/,
    /^\s*"([^"\r\n]+)"\s+agentapi(?:\s|$)/,
    /^\s*'([^'\r\n]+)'\s+agentapi(?:\s|$)/,
  ];

  for (const pattern of posixPatterns) {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(pattern);
      if (!match || !match[1]) continue;
      const candidate = match[1].trim();
      if (!candidate) continue;
      if (/[\0\r\n&|<>;"'`$]/.test(candidate)) continue;
      if (UNSAFE_SCRIPT_EXT_RE.test(candidate)) continue;
      return candidate;
    }
  }

  return '';
}

/**
 * Resolve an available native Antigravity AgentAPI executable path.
 * Never invokes `.bat`/`.cmd`/`.sh` wrapper scripts via `shell: true`, preventing command injection.
 */
export function resolveAgentApiExecutable(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const hasCustomExists = typeof options.existsSync === 'function';
  const checkExists = hasCustomExists ? options.existsSync : existsSync;
  const checkNotSymlink =
    typeof options.isNotSymlink === 'function'
      ? options.isNotSymlink
      : hasCustomExists
        ? () => true
        : isNotSymlink;
  const readText = typeof options.readFileSync === 'function' ? options.readFileSync : readFileSync;
  const home = typeof options.homedir === 'function' ? options.homedir() : homedir();

  const tryCandidate = (candidatePath, { prefixArgs = ['agentapi'], requireExeOnWin = false } = {}) => {
    const trimmed = safeTrimmedString(candidatePath);
    if (!trimmed) return null;
    if (hasInvalidControlChars(trimmed)) return null;
    if (UNSAFE_SCRIPT_EXT_RE.test(trimmed)) return null;
    if (requireExeOnWin && platform === 'win32' && !/\.exe$/i.test(trimmed)) return null;
    try {
      if (!checkExists(trimmed)) return null;
      if (!checkNotSymlink(trimmed)) return null;
      if (!hasCustomExists) {
        const st = safeStat(trimmed);
        if (!st || !st.isFile()) return null;
      }
    } catch {
      return null;
    }
    return { available: true, file: trimmed, prefixArgs };
  };

  // Allow tests or callers to explicitly inject a binary path
  if (options.file || options.executable) {
    const customPrefix = Array.isArray(options.prefixArgs) ? options.prefixArgs : ['agentapi'];
    const explicit = tryCandidate(options.file || options.executable, { prefixArgs: customPrefix });
    if (explicit) return explicit;
  }

  // 1. Prefer the real binary path injected by Antigravity Sidecar
  const sidecarExe = tryCandidate(env?.ANTIGRAVITY_AGENTAPI_EXE);
  if (sidecarExe) return sidecarExe;

  // 2. Fallback to ANTIGRAVITY_EXECUTABLE
  const envExe = tryCandidate(env?.ANTIGRAVITY_EXECUTABLE);
  if (envExe) return envExe;

  // 3. Read-only parse of the agentapi shim script to extract the native binary path (zero execution)
  const binDir = join(home, '.gemini', 'antigravity', 'bin');
  const shimPath =
    platform === 'win32' ? join(binDir, 'agentapi.bat') : join(binDir, 'agentapi');
  try {
    if (checkExists(shimPath) && checkNotSymlink(shimPath)) {
      let canReadShim = true;
      if (!hasCustomExists) {
        const st = safeStat(shimPath);
        if (!st || !st.isFile() || st.size > MAX_SHIM_BYTES) {
          canReadShim = false;
        }
      }
      if (canReadShim) {
        const shimContent = readText(shimPath, 'utf-8');
        const extracted = extractBinaryFromShim(shimContent, platform);
        if (extracted) {
          const fromShim = tryCandidate(extracted, { requireExeOnWin: true });
          if (fromShim) return fromShim;
        }
      }
    }
  } catch {
    // Safely fall back if the shim is unreadable or fails to parse
  }

  // 4. Platform-standard installation directories and legacy fallbacks (no hardcoded personal usernames)
  const fallbackCandidates = [];
  if (platform === 'win32') {
    const localAppData = safeTrimmedString(env?.LOCALAPPDATA);
    if (localAppData) {
      fallbackCandidates.push(
        join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
      );
    }
    fallbackCandidates.push(
      join(binDir, 'language_server_windows_x64.exe'),
      join(binDir, 'language_server.exe'),
    );
  } else {
    fallbackCandidates.push(
      join(binDir, 'language_server_macos_arm64'),
      join(binDir, 'language_server_macos_x64'),
      join(binDir, 'language_server_linux_x64'),
      join(binDir, 'language_server'),
    );
  }

  for (const candidate of fallbackCandidates) {
    const resolved = tryCandidate(candidate);
    if (resolved) return resolved;
  }

  // 5. Silently degrade when unavailable and return the reason
  return {
    available: false,
    reason: DEFAULT_UNAVAILABLE_REASON,
  };
}

/**
 * Normalize and extract metadata from the JSON output of `agentapi get-conversation-metadata`.
 */
export function parseMetadataPayload(raw) {
  const payload = typeof raw === 'string' ? parseJsonLenient(raw) : raw;
  const obj = payload && typeof payload === 'object' ? payload : {};
  const meta =
    obj?.response?.conversationMetadata?.metadata ||
    obj?.response?.conversation_metadata?.metadata ||
    obj?.conversationMetadata?.metadata ||
    obj?.conversation_metadata?.metadata ||
    obj?.metadata ||
    {};

  const projectId =
    safeTrimmedString(meta?.projectId) ||
    safeTrimmedString(meta?.project_id) ||
    safeTrimmedString(obj?.response?.conversationMetadata?.projectId) ||
    safeTrimmedString(obj?.response?.conversation_metadata?.project_id) ||
    safeTrimmedString(obj?.projectId) ||
    safeTrimmedString(obj?.project_id);

  const rawWorkspaces = Array.isArray(meta?.workspaces)
    ? meta.workspaces
    : Array.isArray(meta?.workspace)
      ? meta.workspace
      : [];

  const workspaces = rawWorkspaces
    .filter((ws) => ws && typeof ws === 'object')
    .map((ws) => {
      const workspaceFolderAbsoluteUri =
        safeTrimmedString(ws.workspaceFolderAbsoluteUri) ||
        safeTrimmedString(ws.workspace_folder_absolute_uri) ||
        safeTrimmedString(ws.uri) ||
        safeTrimmedString(ws.folderUri);
      const gitRootAbsoluteUri =
        safeTrimmedString(ws.gitRootAbsoluteUri) ||
        safeTrimmedString(ws.git_root_absolute_uri);
      const branchName =
        safeTrimmedString(ws.branchName) ||
        safeTrimmedString(ws.branch_name) ||
        safeTrimmedString(ws.repository?.branchName) ||
        safeTrimmedString(ws.repository?.branch_name);
      return {
        ...ws,
        workspaceFolderAbsoluteUri,
        gitRootAbsoluteUri,
        branchName,
        path: safeUriToPath(workspaceFolderAbsoluteUri),
        gitRoot: safeUriToPath(gitRootAbsoluteUri),
      };
    });

  const uriSet = new Set();
  const rawUris = Array.isArray(meta?.workspaceUris)
    ? meta.workspaceUris
    : Array.isArray(meta?.workspace_uris)
      ? meta.workspace_uris
      : [];
  for (const uri of rawUris) {
    const cleaned = safeTrimmedString(uri);
    if (cleaned) uriSet.add(cleaned);
  }
  for (const ws of workspaces) {
    if (ws.workspaceFolderAbsoluteUri) {
      uriSet.add(ws.workspaceFolderAbsoluteUri);
    }
  }
  const workspaceUris = [...uriSet];

  const primaryUri = workspaceUris[0] || workspaces[0]?.workspaceFolderAbsoluteUri || '';
  const primaryPath =
    safeUriToPath(primaryUri) ||
    safeTrimmedString(meta?.primaryPath) ||
    safeTrimmedString(meta?.workspacePath);

  const gitRootUri =
    safeTrimmedString(meta?.gitRootAbsoluteUri) ||
    safeTrimmedString(meta?.git_root_absolute_uri) ||
    workspaces.find((ws) => ws.gitRootAbsoluteUri)?.gitRootAbsoluteUri ||
    '';
  const gitRoot =
    safeUriToPath(gitRootUri) ||
    safeTrimmedString(meta?.gitRoot) ||
    safeTrimmedString(meta?.git_root);

  const branchName =
    safeTrimmedString(meta?.branchName) ||
    safeTrimmedString(meta?.branch_name) ||
    workspaces.find((ws) => ws.branchName)?.branchName ||
    '';

  const parentConversationId =
    safeTrimmedString(meta?.parentConversationId) ||
    safeTrimmedString(meta?.parent_conversation_id);
  const rootConversationId =
    safeTrimmedString(meta?.rootConversationId) ||
    safeTrimmedString(meta?.root_conversation_id);

  const rawDepth = meta?.nestingDepth ?? meta?.nesting_depth;
  const parsedDepth =
    typeof rawDepth === 'number'
      ? rawDepth
      : rawDepth != null && rawDepth !== '' && Number.isFinite(Number(rawDepth))
        ? Number(rawDepth)
        : 0;
  const nestingDepth = Number.isFinite(parsedDepth) ? parsedDepth : 0;

  const createdAt = normalizeTimestamp(
    meta?.createdAt ?? meta?.created_at ?? meta?.createTime ?? meta?.create_time,
  );

  return {
    projectId,
    workspaceUris,
    workspaces,
    primaryPath,
    gitRoot,
    branchName,
    parentConversationId,
    rootConversationId,
    nestingDepth,
    createdAt,
  };
}

/**
 * Create an AgentAPI client with injectable dependencies.
 */
export function createAgentApiClient(overrides = {}) {
  const runExecFileSync =
    typeof overrides.execFileSync === 'function' ? overrides.execFileSync : execFileSync;

  const runExecFileAsync =
    typeof overrides.execFileAsync === 'function'
      ? overrides.execFileAsync
      : typeof overrides.execFile === 'function'
        ? (file, args, options) => {
            if (overrides.execFile.length >= 4) {
              return new Promise((resolvePromise, rejectPromise) => {
                overrides.execFile(file, args, options, (err, stdout, stderr) => {
                  if (err) {
                    if (err.stderr === undefined && stderr) err.stderr = stderr;
                    rejectPromise(err);
                    return;
                  }
                  resolvePromise(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
                });
              });
            }
            return Promise.resolve(overrides.execFile(file, args, options));
          }
        : typeof overrides.execFileSync === 'function'
          ? async (file, args, options) => overrides.execFileSync(file, args, options)
          : execFileAsyncDefault;

  const resolveExe =
    typeof overrides.resolveAgentApiExecutable === 'function'
      ? overrides.resolveAgentApiExecutable
      : () => resolveAgentApiExecutable(overrides);

  function prepareMetadataCall(convId, { timeoutMs = 8000 } = {}) {
    if (typeof convId !== 'string' || !CONV_ID_RE.test(convId)) {
      return { error: { ok: false, error: 'Invalid conversationId format' } };
    }

    const resolved = resolveExe();
    if (!resolved?.available || !resolved.file) {
      return { error: { ok: false, error: resolved?.reason || DEFAULT_UNAVAILABLE_REASON } };
    }

    const safeTimeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : 8000;

    return {
      file: resolved.file,
      args: [...(resolved.prefixArgs || ['agentapi']), 'get-conversation-metadata', convId],
      options: {
        encoding: 'utf-8',
        timeout: safeTimeout,
        windowsHide: true,
        shell: false,
        maxBuffer: 4 * 1024 * 1024,
      },
    };
  }

  function parseMetadataStdout(stdout) {
    const raw = parseJsonLenient(stdout);
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        error: 'Invalid JSON response from agentapi get-conversation-metadata',
      };
    }
    const parsed = parseMetadataPayload(raw);
    return {
      ok: true,
      ...parsed,
      raw,
    };
  }

  function prepareStartConversationCall({
    prompt,
    model = '',
    title = '',
    projectId = '',
    profile = '',
    timeoutMs = 20_000,
  } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { error: { ok: false, error: 'prompt must be a non-empty string' } };
    }
    if (
      hasInvalidControlChars(prompt) ||
      hasInvalidControlChars(model) ||
      hasInvalidControlChars(title) ||
      hasInvalidControlChars(projectId) ||
      hasInvalidControlChars(profile)
    ) {
      return { error: { ok: false, error: 'Invalid NUL byte in conversation arguments' } };
    }

    const resolved = resolveExe();
    if (!resolved?.available || !resolved.file) {
      return { error: { ok: false, error: resolved?.reason || DEFAULT_UNAVAILABLE_REASON } };
    }

    const safeTimeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : 20_000;

    const args = [...(resolved.prefixArgs || ['agentapi']), 'new-conversation'];

    const cleanModel = safeTrimmedString(model).replace(/[\r\n]+/g, '');
    if (cleanModel) {
      args.push(`--model=${cleanModel}`);
    }

    const cleanTitle = sanitizeTitle(title);
    if (cleanTitle) {
      args.push(`--title=${cleanTitle}`);
    }

    const cleanProfile = safeTrimmedString(profile).replace(/[\r\n]+/g, '');
    if (cleanProfile) {
      args.push(`--profile=${cleanProfile}`);
    }

    // Prepend a newline if prompt starts with '-' so CLI parsers never treat it as a flag
    const safePrompt = prompt.startsWith('-') ? `\n${prompt}` : prompt;
    args.push(safePrompt);

    const env = { ...(overrides.env || process.env) };
    const cleanProjectId = safeTrimmedString(projectId).replace(/[\r\n]+/g, '');
    if (cleanProjectId) {
      env.ANTIGRAVITY_PROJECT_ID = cleanProjectId;
    }

    return {
      file: resolved.file,
      args,
      options: {
        encoding: 'utf-8',
        env,
        timeout: safeTimeout,
        windowsHide: true,
        shell: false,
        maxBuffer: 4 * 1024 * 1024,
      },
    };
  }

  function parseStartConversationStdout(stdout) {
    const raw = parseJsonLenient(stdout);
    const conversationId = extractConversationId(raw, stdout);
    if (!conversationId) {
      return {
        ok: false,
        error: 'agentapi new-conversation did not return a valid conversationId',
        raw: raw ?? safeTrimmedString(stdout),
      };
    }
    return {
      ok: true,
      conversationId,
      raw: raw ?? safeTrimmedString(stdout),
    };
  }

  const getMetadata =
    typeof overrides.getConversationMetadata === 'function'
      ? overrides.getConversationMetadata
      : function getConversationMetadataImpl(convId, options = {}) {
          const prepared = prepareMetadataCall(convId, options);
          if (prepared.error) return prepared.error;
          try {
            const stdout = runExecFileSync(prepared.file, prepared.args, prepared.options);
            return parseMetadataStdout(stdout);
          } catch (err) {
            return {
              ok: false,
              error: formatExecError(err),
            };
          }
        };

  const getMetadataAsync =
    typeof overrides.getConversationMetadataAsync === 'function'
      ? overrides.getConversationMetadataAsync
      : typeof overrides.getConversationMetadata === 'function'
        ? async (...args) => overrides.getConversationMetadata(...args)
        : async function getConversationMetadataAsyncImpl(convId, options = {}) {
            const prepared = prepareMetadataCall(convId, options);
            if (prepared.error) return prepared.error;
            try {
              const stdout = await runExecFileAsync(prepared.file, prepared.args, prepared.options);
              return parseMetadataStdout(stdout);
            } catch (err) {
              return {
                ok: false,
                error: formatExecError(err),
              };
            }
          };

  const startConv =
    typeof overrides.startNewConversation === 'function'
      ? overrides.startNewConversation
      : function startNewConversationImpl(params = {}) {
          const prepared = prepareStartConversationCall(params);
          if (prepared.error) return prepared.error;
          try {
            const stdout = runExecFileSync(prepared.file, prepared.args, prepared.options);
            return parseStartConversationStdout(stdout);
          } catch (err) {
            return {
              ok: false,
              error: formatExecError(err),
            };
          }
        };

  const startConvAsync =
    typeof overrides.startNewConversationAsync === 'function'
      ? overrides.startNewConversationAsync
      : typeof overrides.startNewConversation === 'function'
        ? async (...args) => overrides.startNewConversation(...args)
        : async function startNewConversationAsyncImpl(params = {}) {
            const prepared = prepareStartConversationCall(params);
            if (prepared.error) return prepared.error;
            try {
              const stdout = await runExecFileAsync(prepared.file, prepared.args, prepared.options);
              return parseStartConversationStdout(stdout);
            } catch (err) {
              return {
                ok: false,
                error: formatExecError(err),
              };
            }
          };

  return {
    resolveAgentApiExecutable: resolveExe,
    parseMetadataPayload,
    getConversationMetadata: getMetadata,
    getConversationMetadataAsync: getMetadataAsync,
    startNewConversation: startConv,
    startNewConversationAsync: startConvAsync,
  };
}

const defaultClient = createAgentApiClient();

export function getConversationMetadata(convId, options) {
  return defaultClient.getConversationMetadata(convId, options);
}

export function getConversationMetadataAsync(convId, options) {
  return defaultClient.getConversationMetadataAsync(convId, options);
}

export function startNewConversation(options) {
  return defaultClient.startNewConversation(options);
}

export function startNewConversationAsync(options) {
  return defaultClient.startNewConversationAsync(options);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes('--check-exe')
) {
  const res = resolveAgentApiExecutable();
  const out = res.available
    ? { available: true, executableName: basename(res.file), prefixArgs: res.prefixArgs }
    : { available: false, reason: res.reason };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

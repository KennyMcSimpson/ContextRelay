import { execFile, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { stat as statAsync } from 'node:fs/promises';
import { promisify } from 'node:util';
import { truncateText } from './fs-utils.mjs';

const execFileAsync = promisify(execFile);

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_LINES = 80;

// Hardened git prefix flags: neutralize untrusted .git/config fsmonitor/pager/diff.external hooks
// and prevent octal escaping of non-ASCII (e.g. CJK) paths on Windows.
const SAFE_GIT_PREFIX_ARGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
];

function makeEmptyAnchor(workspacePath, error = '') {
  return {
    isGitRepo: false,
    workspacePath: typeof workspacePath === 'string' ? workspacePath : '',
    repoRoot: '',
    branch: '',
    headSha: '',
    headSubject: '',
    statusShort: '',
    diffStat: '',
    diffSnippet: '',
    dirtyCount: 0,
    untrackedCount: 0,
    error,
  };
}

function buildGitExecOptions(cwd, timeoutMs) {
  return {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}

function formatGitError(err) {
  const stderr =
    typeof err?.stderr === 'string'
      ? err.stderr.trim()
      : Buffer.isBuffer(err?.stderr)
        ? err.stderr.toString('utf-8').trim()
        : '';
  return stderr || (err instanceof Error ? err.message : String(err));
}

function execGit(cwd, args, timeoutMs) {
  return execFileSync('git', [...SAFE_GIT_PREFIX_ARGS, ...args], {
    ...buildGitExecOptions(cwd, timeoutMs),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function execGitSafe(cwd, args, timeoutMs) {
  try {
    return {
      ok: true,
      stdout: execGit(cwd, args, timeoutMs),
      error: '',
    };
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      error: formatGitError(err),
    };
  }
}

async function execGitSafeAsync(cwd, args, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...SAFE_GIT_PREFIX_ARGS, ...args],
      buildGitExecOptions(cwd, timeoutMs),
    );
    return {
      ok: true,
      stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
      error: '',
    };
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      error: formatGitError(err),
    };
  }
}

function strictTruncateMultiline(text, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 4000;
  if (text.length <= limit) return text;
  const suffix = '\n... [truncated]';
  if (limit <= suffix.length) {
    return text.slice(0, limit);
  }
  let cut = text.slice(0, limit - suffix.length);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut.trimEnd() + suffix;
}

function parseStatusOutput(statusRes) {
  // Preserve leading spaces on the first line (e.g. " M file.js"); only trim trailing newlines
  const rawStatus = statusRes.ok ? statusRes.stdout.replace(/[\r\n]+$/, '') : '';
  const allStatusLines = rawStatus
    ? rawStatus.split(/\r?\n/).filter((line) => line.trim().length > 0)
    : [];

  let dirtyCount = 0;
  let untrackedCount = 0;
  for (const line of allStatusLines) {
    if (line.startsWith('??')) {
      untrackedCount += 1;
    } else {
      dirtyCount += 1;
    }
  }

  let statusShort = '';
  if (allStatusLines.length > MAX_STATUS_LINES) {
    statusShort = [
      ...allStatusLines.slice(0, MAX_STATUS_LINES),
      `... (${allStatusLines.length} total entries, truncated to first ${MAX_STATUS_LINES} lines)`,
    ].join('\n');
  } else {
    statusShort = allStatusLines.join('\n');
  }

  return { statusShort, dirtyCount, untrackedCount };
}

function mergeDiffStats(unstagedStatRes, stagedStatRes) {
  const unstagedStat = unstagedStatRes.ok ? unstagedStatRes.stdout.trim() : '';
  const stagedStat = stagedStatRes.ok ? stagedStatRes.stdout.trim() : '';

  if (unstagedStat && stagedStat) {
    return `[Unstaged]\n${unstagedStat}\n\n[Staged]\n${stagedStat}`;
  }
  if (unstagedStat) return unstagedStat;
  if (stagedStat) return `[Staged]\n${stagedStat}`;
  return '';
}

function mergeDiffSnippets(unstagedDiffRes, stagedDiffRes, maxDiffChars) {
  const unstagedDiff = unstagedDiffRes.ok ? unstagedDiffRes.stdout.trim() : '';
  const stagedDiff = stagedDiffRes.ok ? stagedDiffRes.stdout.trim() : '';

  let combinedDiff = '';
  if (unstagedDiff && stagedDiff) {
    combinedDiff = `# Unstaged Diff\n${unstagedDiff}\n\n# Staged Diff\n${stagedDiff}`;
  } else if (unstagedDiff) {
    combinedDiff = unstagedDiff;
  } else if (stagedDiff) {
    combinedDiff = `# Staged Diff\n${stagedDiff}`;
  }

  return strictTruncateMultiline(combinedDiff, maxDiffChars);
}

function normalizeAnchorOptions(options) {
  const {
    maxDiffChars = 4000,
    includeDiffSnippet = false,
    timeoutMs = 5000,
  } = options || {};

  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 5000;

  return {
    maxDiffChars,
    includeDiffSnippet: Boolean(includeDiffSnippet),
    effectiveTimeout,
  };
}

/**
 * Deterministically collect current Git repository state anchor (sync, no shell).
 *
 * @param {string} workspacePath
 * @param {{ maxDiffChars?: number, includeDiffSnippet?: boolean, timeoutMs?: number }} [options]
 */
export function collectGitAnchor(workspacePath, options = {}) {
  const { maxDiffChars, includeDiffSnippet, effectiveTimeout } = normalizeAnchorOptions(options);

  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    return makeEmptyAnchor('', 'workspacePath is empty');
  }

  const cwd = workspacePath.trim();
  if (!existsSync(cwd)) {
    return makeEmptyAnchor(cwd, `workspacePath does not exist: ${cwd}`);
  }

  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) {
      return makeEmptyAnchor(cwd, `workspacePath is not a directory: ${cwd}`);
    }
  } catch (err) {
    return makeEmptyAnchor(cwd, err instanceof Error ? err.message : String(err));
  }

  const topLevelRes = execGitSafe(cwd, ['rev-parse', '--show-toplevel'], effectiveTimeout);
  if (!topLevelRes.ok || !topLevelRes.stdout.trim()) {
    return makeEmptyAnchor(cwd, topLevelRes.error || 'Not a git repository');
  }

  const repoRoot = topLevelRes.stdout.trim();

  let branch = '';
  const branchRes = execGitSafe(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], effectiveTimeout);
  if (branchRes.ok && branchRes.stdout.trim()) {
    branch = branchRes.stdout.trim();
  } else {
    // Handle unborn HEAD (newly initialized repository with no commits yet)
    const symRes = execGitSafe(cwd, ['symbolic-ref', '--short', 'HEAD'], effectiveTimeout);
    if (symRes.ok && symRes.stdout.trim()) {
      branch = symRes.stdout.trim();
    }
  }

  const headShaRes = execGitSafe(cwd, ['rev-parse', '--short', 'HEAD'], effectiveTimeout);
  const headSha = headShaRes.ok ? headShaRes.stdout.trim() : '';

  const headSubjectRes = execGitSafe(cwd, ['log', '-1', '--pretty=%s'], effectiveTimeout);
  const headSubject = headSubjectRes.ok ? truncateText(headSubjectRes.stdout, 200) : '';

  const statusRes = execGitSafe(cwd, ['status', '--short'], effectiveTimeout);
  const { statusShort, dirtyCount, untrackedCount } = parseStatusOutput(statusRes);

  const unstagedStatRes = execGitSafe(
    cwd,
    ['diff', '--no-ext-diff', '--no-textconv', '--stat'],
    effectiveTimeout,
  );
  const stagedStatRes = execGitSafe(
    cwd,
    ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat'],
    effectiveTimeout,
  );
  const diffStat = mergeDiffStats(unstagedStatRes, stagedStatRes);

  let diffSnippet = '';
  if (includeDiffSnippet) {
    const unstagedDiffRes = execGitSafe(
      cwd,
      ['diff', '--no-ext-diff', '--no-textconv', '--unified=2'],
      effectiveTimeout,
    );
    const stagedDiffRes = execGitSafe(
      cwd,
      ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=2'],
      effectiveTimeout,
    );
    diffSnippet = mergeDiffSnippets(unstagedDiffRes, stagedDiffRes, maxDiffChars);
  }

  return {
    isGitRepo: true,
    workspacePath: cwd,
    repoRoot,
    branch,
    headSha,
    headSubject,
    statusShort,
    diffStat,
    diffSnippet,
    dirtyCount,
    untrackedCount,
    error: '',
  };
}

/**
 * Deterministically collect current Git repository state anchor asynchronously (non-blocking, no shell).
 * Suitable for Sidecar / HTTP server handlers without blocking the Node.js event loop.
 *
 * @param {string} workspacePath
 * @param {{ maxDiffChars?: number, includeDiffSnippet?: boolean, timeoutMs?: number }} [options]
 */
export async function collectGitAnchorAsync(workspacePath, options = {}) {
  const { maxDiffChars, includeDiffSnippet, effectiveTimeout } = normalizeAnchorOptions(options);

  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    return makeEmptyAnchor('', 'workspacePath is empty');
  }

  const cwd = workspacePath.trim();
  try {
    const st = await statAsync(cwd);
    if (!st.isDirectory()) {
      return makeEmptyAnchor(cwd, `workspacePath is not a directory: ${cwd}`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return makeEmptyAnchor(cwd, `workspacePath does not exist: ${cwd}`);
    }
    return makeEmptyAnchor(cwd, err instanceof Error ? err.message : String(err));
  }

  const topLevelRes = await execGitSafeAsync(cwd, ['rev-parse', '--show-toplevel'], effectiveTimeout);
  if (!topLevelRes.ok || !topLevelRes.stdout.trim()) {
    return makeEmptyAnchor(cwd, topLevelRes.error || 'Not a git repository');
  }

  const repoRoot = topLevelRes.stdout.trim();

  const resolveBranchAsync = async () => {
    const branchRes = await execGitSafeAsync(
      cwd,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      effectiveTimeout,
    );
    if (branchRes.ok && branchRes.stdout.trim()) {
      return branchRes.stdout.trim();
    }
    const symRes = await execGitSafeAsync(
      cwd,
      ['symbolic-ref', '--short', 'HEAD'],
      effectiveTimeout,
    );
    return symRes.ok && symRes.stdout.trim() ? symRes.stdout.trim() : '';
  };

  const [
    branch,
    headShaRes,
    headSubjectRes,
    statusRes,
    unstagedStatRes,
    stagedStatRes,
    unstagedDiffRes,
    stagedDiffRes,
  ] = await Promise.all([
    resolveBranchAsync(),
    execGitSafeAsync(cwd, ['rev-parse', '--short', 'HEAD'], effectiveTimeout),
    execGitSafeAsync(cwd, ['log', '-1', '--pretty=%s'], effectiveTimeout),
    execGitSafeAsync(cwd, ['status', '--short'], effectiveTimeout),
    execGitSafeAsync(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--stat'], effectiveTimeout),
    execGitSafeAsync(
      cwd,
      ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat'],
      effectiveTimeout,
    ),
    includeDiffSnippet
      ? execGitSafeAsync(
          cwd,
          ['diff', '--no-ext-diff', '--no-textconv', '--unified=2'],
          effectiveTimeout,
        )
      : Promise.resolve({ ok: true, stdout: '', error: '' }),
    includeDiffSnippet
      ? execGitSafeAsync(
          cwd,
          ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=2'],
          effectiveTimeout,
        )
      : Promise.resolve({ ok: true, stdout: '', error: '' }),
  ]);

  const headSha = headShaRes.ok ? headShaRes.stdout.trim() : '';
  const headSubject = headSubjectRes.ok ? truncateText(headSubjectRes.stdout, 200) : '';
  const { statusShort, dirtyCount, untrackedCount } = parseStatusOutput(statusRes);
  const diffStat = mergeDiffStats(unstagedStatRes, stagedStatRes);
  const diffSnippet = includeDiffSnippet
    ? mergeDiffSnippets(unstagedDiffRes, stagedDiffRes, maxDiffChars)
    : '';

  return {
    isGitRepo: true,
    workspacePath: cwd,
    repoRoot,
    branch,
    headSha,
    headSubject,
    statusShort,
    diffStat,
    diffSnippet,
    dirtyCount,
    untrackedCount,
    error: '',
  };
}

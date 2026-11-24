import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import {
  canonicalRealKey,
  isNotSymlink,
  isPathInsideRoot,
  safeReaddir,
  safeReaddirWithTypes,
  safeStat,
} from '../core/fs-utils.mjs';

function pushBrainRoot(app, brainDir, out, seen) {
  if (!brainDir || !existsSync(brainDir) || !isNotSymlink(brainDir)) return;
  const st = safeStat(brainDir);
  if (!st || !st.isDirectory()) return;
  const rk = canonicalRealKey(brainDir);
  if (seen.has(rk)) return;
  seen.add(rk);
  out.push({ app: app || 'antigravity', brainDir });
}

export function discoverBrainRoots() {
  const roots = [];
  const seen = new Set();

  if (process.env.CONTEXT_RELAY_BRAIN_ROOTS !== undefined) {
    const raw = process.env.CONTEXT_RELAY_BRAIN_ROOTS.trim();
    if (!raw) return [];
    for (const entry of raw.split(delimiter)) {
      const brainDir = entry.trim();
      if (brainDir) {
        pushBrainRoot(basename(dirname(brainDir)) || 'antigravity', brainDir, roots, seen);
      }
    }
    return roots;
  }

  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR.trim();
    if (appDir && isNotSymlink(appDir)) {
      const brainDir = join(appDir, 'brain');
      pushBrainRoot(basename(appDir) || 'antigravity', brainDir, roots, seen);
    }
  }

  const home = homedir();
  const scanGeminiBase = (geminiBase) => {
    if (!existsSync(geminiBase) || !isNotSymlink(geminiBase)) return;
    const directBrain = join(geminiBase, 'brain');
    pushBrainRoot(basename(geminiBase) || 'antigravity', directBrain, roots, seen);
    for (const name of safeReaddir(geminiBase).sort()) {
      if (!name || name.startsWith('.')) continue;
      const appDir = join(geminiBase, name);
      if (!isNotSymlink(appDir)) continue;
      const brainDir = join(appDir, 'brain');
      pushBrainRoot(name, brainDir, roots, seen);
    }
  };

  scanGeminiBase(join(home, '.gemini'));
  const siblingEntries = safeReaddirWithTypes(home)
    .filter((entry) => {
      if (!entry.name || entry.isSymbolicLink() || !entry.isDirectory()) return false;
      const low = entry.name.toLowerCase();
      return low.startsWith('.gemini-') || low.startsWith('.gemini_');
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of siblingEntries) {
    scanGeminiBase(join(home, entry.name));
  }

  return roots;
}

function buildSourceRecord(app, sessionId, convDir) {
  const sysDir = join(convDir, '.system_generated');
  if (!isNotSymlink(sysDir)) return null;
  const logsDir = join(sysDir, 'logs');
  if (!isNotSymlink(logsDir)) return null;
  const filePath = join(logsDir, 'transcript.jsonl');
  if (!existsSync(filePath) || !isNotSymlink(filePath)) return null;

  const st = safeStat(filePath);
  if (!st || !st.isFile()) return null;

  const candidateFull = join(logsDir, 'transcript_full.jsonl');
  const hasFull =
    existsSync(candidateFull) &&
    isNotSymlink(candidateFull) &&
    Boolean(safeStat(candidateFull)?.isFile());

  return {
    agent: 'antigravity',
    app: app || 'antigravity',
    sessionId,
    filePath,
    fullFilePath: hasFull ? candidateFull : null,
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
}

function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string') return false;
  const id = sessionId.trim();
  if (!id || id !== sessionId) return false;
  if (id === '.' || id === '..' || id.startsWith('.')) return false;
  if (id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0') || id.includes(':')) {
    return false;
  }
  return true;
}

export const antigravityAdapter = {
  id: 'antigravity',
  label: 'Antigravity',

  discoverSources() {
    const out = [];
    const seen = new Set();

    for (const { app, brainDir } of discoverBrainRoots()) {
      for (const convId of safeReaddir(brainDir)) {
        if (!convId || convId.startsWith('.')) continue;
        const convDir = join(brainDir, convId);
        if (!isPathInsideRoot(convDir, brainDir) || !isNotSymlink(convDir)) continue;
        const rec = buildSourceRecord(app, convId, convDir);
        if (!rec) continue;
        const key = canonicalRealKey(rec.filePath);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
      }
    }

    out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
    return out;
  },

  inferMeta(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return { agent: 'antigravity', sessionId: 'unknown', app: 'antigravity' };
    }
    const logsDir = dirname(filePath);
    const sysDir = dirname(logsDir);
    const convDir = dirname(sysDir);
    const brainDir = dirname(convDir);
    const appDir = dirname(brainDir);
    return {
      agent: 'antigravity',
      sessionId: basename(convDir) || 'unknown',
      app: basename(brainDir).toLowerCase() === 'brain' ? basename(appDir) || 'antigravity' : 'antigravity',
    };
  },

  matchesPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    if (
      norm.endsWith('/.system_generated/logs/transcript.jsonl') ||
      norm.endsWith('/.system_generated/logs/transcript_full.jsonl')
    ) {
      return true;
    }
    for (const { brainDir } of discoverBrainRoots()) {
      if (
        isPathInsideRoot(filePath, brainDir) &&
        (norm.endsWith('/transcript.jsonl') || norm.endsWith('/transcript_full.jsonl'))
      ) {
        return true;
      }
    }
    return false;
  },

  findTranscriptPath(sessionId) {
    if (!isSafeSessionId(sessionId)) return null;
    for (const { app, brainDir } of discoverBrainRoots()) {
      const convDir = join(brainDir, sessionId);
      if (!isPathInsideRoot(convDir, brainDir) || !isNotSymlink(convDir)) continue;
      const rec = buildSourceRecord(app, sessionId, convDir);
      if (rec) return rec;
    }
    return null;
  },
};

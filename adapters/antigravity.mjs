import { existsSync, readFileSync } from 'node:fs';
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

const MAX_ANNOTATION_BYTES = 64 * 1024;
const MAX_ANNOTATION_TITLE_LEN = 240;
const EMPTY_ANNOTATION = Object.freeze({ title: '', path: '', mtimeMs: 0, size: 0 });

function decodePbtxtQuoted(raw, startIndex) {
  const quote = raw[startIndex];
  if (quote !== '"' && quote !== "'") return null;

  const bytes = [];
  let i = startIndex + 1;
  const len = raw.length;

  const pushUtf8 = (str) => {
    for (const b of Buffer.from(str, 'utf8')) {
      bytes.push(b);
    }
  };

  while (i < len) {
    const ch = raw[i];
    if (ch === quote) {
      return { text: Buffer.from(bytes).toString('utf8'), nextIndex: i + 1 };
    }
    if (ch === '\n' || ch === '\r') {
      return null;
    }
    if (ch === '\\') {
      i += 1;
      if (i >= len) return null;
      const esc = raw[i];
      if (esc >= '0' && esc <= '7') {
        let oct = esc;
        if (i + 1 < len && raw[i + 1] >= '0' && raw[i + 1] <= '7') {
          oct += raw[i + 1];
          i += 1;
          if (i + 1 < len && raw[i + 1] >= '0' && raw[i + 1] <= '7') {
            oct += raw[i + 1];
            i += 1;
          }
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += 1;
        continue;
      }
      if (esc === 'x' || esc === 'X') {
        let hex = '';
        if (i + 1 < len && /[0-9a-fA-F]/.test(raw[i + 1])) {
          hex += raw[i + 1];
          i += 1;
          if (i + 1 < len && /[0-9a-fA-F]/.test(raw[i + 1])) {
            hex += raw[i + 1];
            i += 1;
          }
        }
        if (!hex) return null;
        bytes.push(parseInt(hex, 16) & 0xff);
        i += 1;
        continue;
      }
      if (esc === 'u' || esc === 'U') {
        const width = esc === 'u' ? 4 : 8;
        const hex = raw.slice(i + 1, i + 1 + width);
        if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return null;
        if (cp >= 0xd800 && cp <= 0xdfff) {
          pushUtf8('\uFFFD');
        } else {
          pushUtf8(String.fromCodePoint(cp));
        }
        i += 1 + width;
        continue;
      }
      switch (esc) {
        case 'n':
          pushUtf8('\n');
          break;
        case 'r':
          pushUtf8('\r');
          break;
        case 't':
          pushUtf8('\t');
          break;
        case 'a':
          pushUtf8('\x07');
          break;
        case 'b':
          pushUtf8('\b');
          break;
        case 'f':
          pushUtf8('\f');
          break;
        case 'v':
          pushUtf8('\v');
          break;
        case '\\':
        case '"':
        case "'":
        case '?':
          pushUtf8(esc);
          break;
        default:
          pushUtf8(esc);
          break;
      }
      i += 1;
      continue;
    }

    const cp = raw.codePointAt(i);
    const step = cp > 0xffff ? 2 : 1;
    pushUtf8(raw.slice(i, i + step));
    i += step;
  }

  return null;
}

function skipPbtxtWsAndComments(raw, startIndex) {
  let i = startIndex;
  const len = raw.length;
  while (i < len) {
    const ch = raw[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < len && raw[i] !== '\n') i += 1;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Parse the top-level `title` field from Antigravity's plain-text annotation file
 * (`<appDataDir>/annotations/<sessionId>.pbtxt`).
 * Linear O(N) single-pass scan: ignores comments, nested message blocks, and other string
 * literals, while decoding octal, hexadecimal, and Unicode escapes.
 */
export function parseAnnotationPbtxtTitle(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const text = raw.replace(/^\uFEFF/, '');
  const len = text.length;
  let i = 0;
  let depth = 0;
  let foundTitle = '';

  while (i < len) {
    i = skipPbtxtWsAndComments(text, i);
    if (i >= len) break;

    const ch = text[i];
    if (ch === '{' || ch === '<') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}' || ch === '>') {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const lit = decodePbtxtQuoted(text, i);
      if (!lit) break;
      i = lit.nextIndex;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const idStart = i;
      i += 1;
      while (i < len && /[A-Za-z0-9_]/.test(text[i])) i += 1;
      const ident = text.slice(idStart, i);

      if (depth === 0 && ident === 'title') {
        let j = skipPbtxtWsAndComments(text, i);
        if (j < len && text[j] === ':') {
          j = skipPbtxtWsAndComments(text, j + 1);
          const parts = [];
          while (j < len && (text[j] === '"' || text[j] === "'")) {
            const lit = decodePbtxtQuoted(text, j);
            if (!lit) {
              parts.length = 0;
              break;
            }
            parts.push(lit.text);
            j = skipPbtxtWsAndComments(text, lit.nextIndex);
          }
          if (parts.length > 0) {
            const cleaned = parts
              .join('')
              .replace(/[\x00-\x1f\x7f]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (cleaned) {
              foundTitle =
                cleaned.length > MAX_ANNOTATION_TITLE_LEN
                  ? cleaned.slice(0, MAX_ANNOTATION_TITLE_LEN).trim()
                  : cleaned;
            }
          }
          i = j;
          continue;
        }
      }
      continue;
    }

    i += 1;
  }

  return foundTitle;
}

/**
 * Locate and read-only extract Antigravity's live renamed sidebar title from
 * `<appDataDir>/annotations/<sessionId>.pbtxt` given a transcript path.
 * Never touches any `.sqlite` / `.db` database; strictly enforces path boundaries and rejects symlinks.
 */
export function readAnnotationForTranscript(filePath, sessionId, { statOnly = false } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) return EMPTY_ANNOTATION;
  if (!isSafeSessionId(sessionId)) return EMPTY_ANNOTATION;

  const logsDir = dirname(filePath);
  const sysDir = dirname(logsDir);
  const convDir = dirname(sysDir);
  const brainDir = dirname(convDir);
  if (basename(brainDir).toLowerCase() !== 'brain') return EMPTY_ANNOTATION;

  const appDir = dirname(brainDir);
  const annotationsDir = join(appDir, 'annotations');
  if (!existsSync(annotationsDir) || !isNotSymlink(annotationsDir)) return EMPTY_ANNOTATION;

  const pbtxtPath = join(annotationsDir, `${sessionId}.pbtxt`);
  if (!isPathInsideRoot(pbtxtPath, annotationsDir) || !existsSync(pbtxtPath) || !isNotSymlink(pbtxtPath)) {
    return EMPTY_ANNOTATION;
  }

  const st = safeStat(pbtxtPath);
  if (!st || !st.isFile() || st.size <= 0 || st.size > MAX_ANNOTATION_BYTES) {
    return EMPTY_ANNOTATION;
  }

  if (statOnly) {
    return { title: '', path: pbtxtPath, mtimeMs: st.mtimeMs, size: st.size };
  }

  try {
    const raw = readFileSync(pbtxtPath, 'utf-8');
    const title = parseAnnotationPbtxtTitle(raw);
    return { title, path: pbtxtPath, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { title: '', path: pbtxtPath, mtimeMs: st.mtimeMs, size: st.size };
  }
}

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

  const annMeta = readAnnotationForTranscript(filePath, sessionId, { statOnly: true });

  return {
    agent: 'antigravity',
    app: app || 'antigravity',
    sessionId,
    filePath,
    fullFilePath: hasFull ? candidateFull : null,
    mtimeMs: st.mtimeMs,
    size: st.size,
    annotationMtimeMs: annMeta.mtimeMs,
    annotationSize: annMeta.size,
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

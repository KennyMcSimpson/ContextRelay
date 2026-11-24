import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalFileKey, isNotSymlink, safeStat } from './fs-utils.mjs';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_SINGLE_LINE_BYTES = 256 * 1024 * 1024;
const STEP_INDEX_KEY_BUF = Buffer.from('"step_index"');

function isBlankLineBuffer(buf) {
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    i = 3;
  }
  for (; i < buf.length; i++) {
    const c = buf[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a) return false;
  }
  return true;
}

function tryParseJsonObject(lineBuf) {
  if (!lineBuf || lineBuf.length === 0 || isBlankLineBuffer(lineBuf)) {
    return { blank: true, ok: true, value: null };
  }
  const str = lineBuf.toString('utf-8').replace(/^\uFEFF/, '').trim();
  if (!str) return { blank: true, ok: true, value: null };
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { blank: false, ok: true, value: parsed };
    }
    return { blank: false, ok: false, value: null };
  } catch {
    return { blank: false, ok: false, value: null };
  }
}

export function readJsonlSteps(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (!isNotSymlink(filePath)) return null;

  const st = safeStat(filePath);
  if (!st || !st.isFile()) return null;

  const rawMax = Number(options?.maxBytes);
  const maxBytes = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_MAX_BYTES;

  const steps = [];
  let bytesRead = 0;
  let truncatedTail = false;

  if (st.size === 0) {
    return {
      steps,
      stat: { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino },
      bytesRead: 0,
      truncatedTail: false,
    };
  }

  const bufSize = Math.min(CHUNK_SIZE, Math.max(4096, Math.min(st.size, maxBytes)));
  const chunkBuf = Buffer.allocUnsafe(bufSize);
  let carryParts = [];
  let carryLen = 0;
  let hitMaxBytes = false;

  const fd = openSync(filePath, 'r');
  try {
    while (bytesRead < maxBytes) {
      const toRead = Math.min(bufSize, maxBytes - bytesRead);
      const n = readSync(fd, chunkBuf, 0, toRead, bytesRead);
      if (n <= 0) break;
      bytesRead += n;

      const slice = n === bufSize ? chunkBuf : chunkBuf.subarray(0, n);
      let lineStart = 0;

      while (lineStart < n) {
        const nl = slice.indexOf(0x0a, lineStart);
        if (nl === -1) break;

        let lineBuf;
        if (carryParts.length === 0) {
          lineBuf = slice.subarray(lineStart, nl);
        } else {
          carryParts.push(slice.subarray(lineStart, nl));
          lineBuf = Buffer.concat(carryParts, carryLen + (nl - lineStart));
          carryParts = [];
          carryLen = 0;
        }

        const res = tryParseJsonObject(lineBuf);
        if (res.ok && !res.blank && res.value) {
          steps.push(res.value);
        }

        lineStart = nl + 1;
      }

      if (lineStart < n) {
        const remainder = Buffer.from(slice.subarray(lineStart, n));
        carryParts.push(remainder);
        carryLen += remainder.length;
      }
    }

    if (bytesRead >= maxBytes && bytesRead < st.size) {
      hitMaxBytes = true;
    }
  } finally {
    closeSync(fd);
  }

  if (hitMaxBytes) {
    truncatedTail = true;
  }

  if (carryLen > 0) {
    const tailBuf = carryParts.length === 1 ? carryParts[0] : Buffer.concat(carryParts, carryLen);
    if (!isBlankLineBuffer(tailBuf)) {
      if (hitMaxBytes) {
        truncatedTail = true;
      } else {
        const res = tryParseJsonObject(tailBuf);
        if (res.ok && res.value) {
          steps.push(res.value);
        } else {
          truncatedTail = true;
        }
      }
    }
  }

  return {
    steps,
    stat: { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino },
    bytesRead,
    truncatedTail,
  };
}

function lineMightHaveStepIndex(lineBuf, targetBytes) {
  let pos = 0;
  const keyLen = STEP_INDEX_KEY_BUF.length;
  const targetLen = targetBytes.length;

  while (pos < lineBuf.length) {
    const idx = lineBuf.indexOf(STEP_INDEX_KEY_BUF, pos);
    if (idx === -1) return false;

    let i = idx + keyLen;
    while (i < lineBuf.length && (lineBuf[i] === 0x20 || lineBuf[i] === 0x09 || lineBuf[i] === 0x0d || lineBuf[i] === 0x0a)) {
      i++;
    }

    if (i < lineBuf.length && lineBuf[i] === 0x3a) {
      i++;
      while (i < lineBuf.length && (lineBuf[i] === 0x20 || lineBuf[i] === 0x09 || lineBuf[i] === 0x0d || lineBuf[i] === 0x0a)) {
        i++;
      }

      let quoted = false;
      if (i < lineBuf.length && lineBuf[i] === 0x22) {
        quoted = true;
        i++;
      }

      if (i + targetLen <= lineBuf.length) {
        let matched = true;
        for (let j = 0; j < targetLen; j++) {
          if (lineBuf[i + j] !== targetBytes[j]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          const nextByte = lineBuf[i + targetLen];
          if (quoted) {
            if (nextByte === 0x22) return true;
          } else {
            const isNumCont =
              nextByte !== undefined &&
              ((nextByte >= 0x30 && nextByte <= 0x39) ||
                nextByte === 0x2e ||
                nextByte === 0x65 ||
                nextByte === 0x45);
            if (!isNumCont) return true;
          }
        }
      }
    }

    pos = idx + keyLen;
  }

  return false;
}

function inspectRegularNonSymlink(filePath) {
  try {
    const lst = lstatSync(filePath);
    if (lst.isSymbolicLink()) return 'symlink';
    if (lst.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}

function matchParsedStep(lineBuf, targetIndex, targetBytes) {
  if (!lineBuf || lineBuf.length === 0 || isBlankLineBuffer(lineBuf)) return null;
  if (!lineMightHaveStepIndex(lineBuf, targetBytes)) return null;
  const res = tryParseJsonObject(lineBuf);
  if (!res.ok || !res.value) return null;
  const rawIdx = res.value.step_index;
  if (
    rawIdx === null ||
    rawIdx === undefined ||
    rawIdx === '' ||
    typeof rawIdx === 'boolean'
  ) {
    return null;
  }
  return Number(rawIdx) === targetIndex ? res.value : null;
}

function scanFileForStepIndex(targetPath, targetIndex, targetBytes) {
  const st = safeStat(targetPath);
  if (!st || !st.isFile() || st.size === 0) return null;

  const bufSize = Math.min(CHUNK_SIZE, Math.max(4096, st.size));
  const chunkBuf = Buffer.allocUnsafe(bufSize);

  let carryParts = [];
  let carryLen = 0;
  let discardCurrentLine = false;
  let offset = 0;

  const fd = openSync(targetPath, 'r');
  try {
    while (true) {
      const n = readSync(fd, chunkBuf, 0, bufSize, offset);
      if (n <= 0) break;
      offset += n;

      const slice = n === bufSize ? chunkBuf : chunkBuf.subarray(0, n);
      let lineStart = 0;

      while (lineStart < n) {
        const nl = slice.indexOf(0x0a, lineStart);
        if (nl === -1) break;

        if (!discardCurrentLine) {
          let lineBuf;
          if (carryParts.length === 0) {
            lineBuf = slice.subarray(lineStart, nl);
          } else {
            carryParts.push(slice.subarray(lineStart, nl));
            lineBuf = Buffer.concat(carryParts, carryLen + (nl - lineStart));
            carryParts = [];
            carryLen = 0;
          }

          const hit = matchParsedStep(lineBuf, targetIndex, targetBytes);
          if (hit) return hit;
        } else {
          carryParts = [];
          carryLen = 0;
          discardCurrentLine = false;
        }

        lineStart = nl + 1;
      }

      if (lineStart < n && !discardCurrentLine) {
        const remLen = n - lineStart;
        if (carryLen + remLen > MAX_SINGLE_LINE_BYTES) {
          carryParts = [];
          carryLen = 0;
          discardCurrentLine = true;
        } else {
          carryParts.push(Buffer.from(slice.subarray(lineStart, n)));
          carryLen += remLen;
        }
      }
    }
  } finally {
    closeSync(fd);
  }

  if (!discardCurrentLine && carryLen > 0) {
    const tailBuf = carryParts.length === 1 ? carryParts[0] : Buffer.concat(carryParts, carryLen);
    const hit = matchParsedStep(tailBuf, targetIndex, targetBytes);
    if (hit) return hit;
  }

  return null;
}

export function readFullStepByIndex(transcriptPath, stepIndex) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  if (
    stepIndex === null ||
    stepIndex === undefined ||
    stepIndex === '' ||
    typeof stepIndex === 'boolean'
  ) {
    return null;
  }
  const targetIndex = Number(stepIndex);
  if (!Number.isFinite(targetIndex)) return null;

  const targetBytes = Buffer.from(String(targetIndex), 'utf-8');
  const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl');
  const fullStatus = inspectRegularNonSymlink(fullPath);

  if (fullStatus === 'symlink') {
    return null;
  }

  if (fullStatus === 'file') {
    const hit = scanFileForStepIndex(fullPath, targetIndex, targetBytes);
    if (hit) return hit;
    if (canonicalFileKey(fullPath) === canonicalFileKey(transcriptPath)) {
      return null;
    }
  }

  const fallbackStatus = inspectRegularNonSymlink(transcriptPath);
  if (fallbackStatus !== 'file') return null;

  return scanFileForStepIndex(transcriptPath, targetIndex, targetBytes);
}

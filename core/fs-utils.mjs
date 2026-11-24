import { randomBytes } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENAME_RETRIES = 8;
const IO_RETRIES = 6;
const EMPTY_LOCK_GRACE_MS = 300;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const activeLocks = new Set();
const activeLockPromises = new Map();
const asyncLockQueues = new Map();

function isWindowsTransientIoError(err) {
  return Boolean(err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES'));
}

function sleepAsync(ms) {
  const n = Number(ms);
  const delay = Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1;
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delay);
  });
}

function waitWithTimeout(promise, ms) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolvePromise(false);
    }, Math.max(0, ms));
    promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(true);
      },
    );
  });
}

function writeFileWithRetry(filePath, content) {
  let lastErr = null;
  for (let attempt = 0; attempt < IO_RETRIES; attempt++) {
    try {
      if (Buffer.isBuffer(content)) {
        writeFileSync(filePath, content);
      } else {
        writeFileSync(filePath, String(content ?? ''), { encoding: 'utf-8' });
      }
      return;
    } catch (err) {
      lastErr = err;
      if (isWindowsTransientIoError(err)) {
        sleepMs(15 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function renameWithRetry(fromPath, toPath, retries = RENAME_RETRIES) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      renameSync(fromPath, toPath);
      return;
    } catch (err) {
      lastErr = err;
      if (isWindowsTransientIoError(err)) {
        sleepMs(15 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function getPluginRoot() {
  return PLUGIN_ROOT;
}

export function getDataDir(overrideDir = '') {
  if (typeof overrideDir === 'string' && overrideDir.trim()) {
    return resolve(overrideDir.trim());
  }

  const envDataDir = process.env.CONTEXT_RELAY_DATA_DIR;
  if (typeof envDataDir === 'string' && envDataDir.trim()) {
    return resolve(envDataDir.trim());
  }

  const root = getPluginRoot();
  const localCfg = readJsonFile(join(root, '.local-config.json'), null);
  if (localCfg && typeof localCfg === 'object' && typeof localCfg.dataDir === 'string' && localCfg.dataDir.trim()) {
    return resolve(root, localCfg.dataDir.trim());
  }

  const pluginData = process.env.PLUGIN_DATA;
  if (typeof pluginData === 'string' && pluginData.trim()) {
    return resolve(pluginData.trim());
  }

  return join(homedir(), '.context-relay');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sleepMs(ms) {
  const n = Number(ms);
  const delay = Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1;
  Atomics.wait(SLEEP_BUF, 0, 0, delay);
}

export function isPidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

export function canonicalFileKey(filePath) {
  const abs = resolve(String(filePath || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

export function canonicalRealKey(filePath) {
  let target = String(filePath || '');
  try {
    target = realpathSync(target);
  } catch {
    target = resolve(target);
  }
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

export function isPathInsideRoot(filePath, rootDir) {
  if (!filePath || !rootDir) return false;
  const target = canonicalFileKey(filePath);
  const root = canonicalFileKey(rootDir);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

export function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function safeReaddirWithTypes(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function isNotSymlink(filePath) {
  try {
    return !lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Atomic UTF-8 (no BOM) file write using a bounded per-target `.tmp.<slot>` file
 * and atomic `renameSync` with Windows EPERM/EBUSY/EACCES retry protection.
 */
export function atomicWriteFile(filePath, content) {
  const dir = dirname(filePath);
  ensureDir(dir);
  const tmpPath = `${filePath}.tmp.${process.pid % 4}`;
  writeFileWithRetry(tmpPath, content);
  renameWithRetry(tmpPath, filePath, RENAME_RETRIES);
}

export function readJsonFile(filePath, fallback = null) {
  try {
    const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function inspectLockSlot(slotPath) {
  let raw;
  try {
    raw = readFileSync(slotPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', holder: null };
    if (isWindowsTransientIoError(err)) return { status: 'busy', holder: null };
    return { status: 'corrupt', holder: null };
  }

  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { status: 'empty', holder: null };

  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object') return { status: 'corrupt', holder: null };
    const pid = Number(obj.pid);
    const ts = Number(obj.ts);
    const token = typeof obj.token === 'string' ? obj.token : '';
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ts)) {
      return { status: 'corrupt', holder: null };
    }
    return { status: 'valid', holder: { pid, ts, token } };
  } catch {
    return { status: 'corrupt', holder: null };
  }
}

function isHolderReclaimable(holder, staleMs) {
  if (!holder) return false;
  if (Date.now() - holder.ts > staleMs) return true;
  if (holder.pid !== process.pid && isPidDead(holder.pid)) return true;
  return false;
}

function tryAcquireHeld(heldPath, donePath, token) {
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now(), token }) + '\n';
  let fd;
  try {
    fd = openSync(heldPath, 'wx', 0o600);
  } catch (err) {
    const retryable =
      err &&
      (err.code === 'EEXIST' ||
        (process.platform === 'win32' && isWindowsTransientIoError(err)));
    if (retryable) return { acquired: false, code: err.code };
    throw err;
  }

  try {
    writeSync(fd, payload);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // ignore close failure
    }
    try {
      renameSync(heldPath, donePath);
    } catch {
      // best-effort clear of empty held slot without delete APIs
    }
    throw err;
  }

  closeSync(fd);
  return { acquired: true, code: null };
}

function releaseHeldSync(heldPath, donePath, token) {
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    const info = inspectLockSlot(heldPath);
    if (info.status === 'missing') return;
    if (info.status === 'busy') {
      sleepMs(15 * (attempt + 1));
      continue;
    }
    if (info.status !== 'valid' || info.holder.token !== token) {
      return;
    }
    try {
      renameSync(heldPath, donePath);
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      if (isWindowsTransientIoError(err)) {
        sleepMs(15 * (attempt + 1));
        continue;
      }
      return;
    }
  }
}

async function releaseHeldAsync(heldPath, donePath, token) {
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    const info = inspectLockSlot(heldPath);
    if (info.status === 'missing') return;
    if (info.status === 'busy') {
      await sleepAsync(15 * (attempt + 1));
      continue;
    }
    if (info.status !== 'valid' || info.holder.token !== token) {
      return;
    }
    try {
      renameSync(heldPath, donePath);
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      if (isWindowsTransientIoError(err)) {
        await sleepAsync(15 * (attempt + 1));
        continue;
      }
      return;
    }
  }
}

function clearReclaimSlotSync(reclaimPath, donePath, reclaimToken) {
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    const info = inspectLockSlot(reclaimPath);
    if (info.status === 'missing') return;
    if (info.status === 'busy') {
      sleepMs(15 * (attempt + 1));
      continue;
    }
    if (info.status === 'valid' && info.holder.token && info.holder.token !== reclaimToken) {
      return;
    }
    try {
      renameSync(reclaimPath, donePath);
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      if (isWindowsTransientIoError(err)) {
        sleepMs(15 * (attempt + 1));
        continue;
      }
      return;
    }
  }
}

async function clearReclaimSlotAsync(reclaimPath, donePath, reclaimToken) {
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    const info = inspectLockSlot(reclaimPath);
    if (info.status === 'missing') return;
    if (info.status === 'busy') {
      await sleepAsync(15 * (attempt + 1));
      continue;
    }
    if (info.status === 'valid' && info.holder.token && info.holder.token !== reclaimToken) {
      return;
    }
    try {
      renameSync(reclaimPath, donePath);
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      if (isWindowsTransientIoError(err)) {
        await sleepAsync(15 * (attempt + 1));
        continue;
      }
      return;
    }
  }
}

function checkHeldStaleCandidate(heldPath, effectiveStaleMs, state) {
  const info = inspectLockSlot(heldPath);
  if (info.status === 'missing') {
    state.firstSeenIncompleteHeldAt = 0;
    return { action: 'retry_now', expectedToken: null };
  }
  if (info.status === 'busy') {
    return { action: 'wait', expectedToken: null };
  }
  if (info.status === 'valid') {
    state.firstSeenIncompleteHeldAt = 0;
    if (isHolderReclaimable(info.holder, effectiveStaleMs)) {
      return { action: 'reclaim', expectedToken: info.holder.token };
    }
    return { action: 'wait', expectedToken: null };
  }

  // Empty or corrupt `.held`: wait at least 300ms write grace period for in-flight openSync+writeSync
  const now = Date.now();
  if (!state.firstSeenIncompleteHeldAt) state.firstSeenIncompleteHeldAt = now;
  const st = safeStat(heldPath);
  const agedLocally = now - state.firstSeenIncompleteHeldAt >= EMPTY_LOCK_GRACE_MS;
  const agedOnDisk = Boolean(st && now - st.mtimeMs >= Math.max(EMPTY_LOCK_GRACE_MS, effectiveStaleMs));
  if (agedLocally || agedOnDisk) {
    return { action: 'reclaim', expectedToken: null };
  }
  return { action: 'wait', expectedToken: null };
}

function maybeClearStaleReclaimSlot(reclaimPath, donePath, effectiveStaleMs) {
  const recInfo = inspectLockSlot(reclaimPath);
  if (recInfo.status === 'missing' || recInfo.status === 'busy') return;
  let stale = false;
  if (recInfo.status === 'valid') {
    stale = isHolderReclaimable(recInfo.holder, effectiveStaleMs);
  } else {
    const st = safeStat(reclaimPath);
    if (st && Date.now() - st.mtimeMs >= Math.max(EMPTY_LOCK_GRACE_MS, effectiveStaleMs)) {
      stale = true;
    }
  }
  if (stale) {
    try {
      renameSync(reclaimPath, donePath);
    } catch {
      // Another worker already cleared reclaimPath
    }
  }
}

function tryReclaimStaleHeldSync(heldPath, donePath, reclaimPath, expectedToken, effectiveStaleMs) {
  const reclaimToken = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(reclaimPath, 'wx', 0o600);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      maybeClearStaleReclaimSlot(reclaimPath, donePath, effectiveStaleMs);
      return false;
    }
    if (process.platform === 'win32' && isWindowsTransientIoError(err)) {
      return false;
    }
    throw err;
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), token: reclaimToken }) + '\n');
  } finally {
    closeSync(fd);
  }

  try {
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      const recheck = inspectLockSlot(heldPath);
      if (recheck.status === 'missing') return true;
      if (recheck.status === 'busy') {
        sleepMs(15 * (attempt + 1));
        continue;
      }
      const sameStaleLock =
        expectedToken !== null
          ? recheck.status === 'valid' && recheck.holder.token === expectedToken
          : recheck.status === 'empty' || recheck.status === 'corrupt';
      if (!sameStaleLock) {
        return false;
      }
      try {
        renameSync(heldPath, donePath);
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') return true;
        if (isWindowsTransientIoError(err)) {
          sleepMs(15 * (attempt + 1));
          continue;
        }
        return false;
      }
    }
    return false;
  } finally {
    clearReclaimSlotSync(reclaimPath, donePath, reclaimToken);
  }
}

async function tryReclaimStaleHeldAsync(heldPath, donePath, reclaimPath, expectedToken, effectiveStaleMs) {
  const reclaimToken = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(reclaimPath, 'wx', 0o600);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      maybeClearStaleReclaimSlot(reclaimPath, donePath, effectiveStaleMs);
      return false;
    }
    if (process.platform === 'win32' && isWindowsTransientIoError(err)) {
      return false;
    }
    throw err;
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), token: reclaimToken }) + '\n');
  } finally {
    closeSync(fd);
  }

  try {
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      const recheck = inspectLockSlot(heldPath);
      if (recheck.status === 'missing') return true;
      if (recheck.status === 'busy') {
        await sleepAsync(15 * (attempt + 1));
        continue;
      }
      const sameStaleLock =
        expectedToken !== null
          ? recheck.status === 'valid' && recheck.holder.token === expectedToken
          : recheck.status === 'empty' || recheck.status === 'corrupt';
      if (!sameStaleLock) {
        return false;
      }
      try {
        renameSync(heldPath, donePath);
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') return true;
        if (isWindowsTransientIoError(err)) {
          await sleepAsync(15 * (attempt + 1));
          continue;
        }
        return false;
      }
    }
    return false;
  } finally {
    await clearReclaimSlotAsync(reclaimPath, donePath, reclaimToken);
  }
}

/**
 * Synchronous cross-process exclusive lock backed by kernel-atomic `openSync(..., 'wx')`
 * (`CREATE_NEW` on Windows / `O_CREAT|O_EXCL` on POSIX) and zero-delete release via
 * `renameSync(.held -> .done)`. Rejects same-process re-entrancy with `ELOCK_REENTRANT`.
 * For concurrent async callbacks in the same process, use `withLockAsync`.
 */
export function withLock(lockPath, fn, { staleMs = 30_000, waitMs = 6_000 } = {}) {
  const dir = dirname(lockPath);
  ensureDir(dir);

  const lockKey = canonicalFileKey(lockPath);
  if (activeLocks.has(lockKey)) {
    const err = new Error(
      `Reentrant or concurrent synchronous lock acquisition in same process: ${lockPath}. Use withLockAsync for async callers.`,
    );
    err.code = 'ELOCK_REENTRANT';
    throw err;
  }

  const effectiveStaleMs =
    Number.isFinite(Number(staleMs)) && Number(staleMs) >= 0 ? Number(staleMs) : 30_000;
  const effectiveWaitMs =
    Number.isFinite(Number(waitMs)) && Number(waitMs) >= 0 ? Number(waitMs) : 6_000;

  const heldPath = `${lockPath}.held`;
  const donePath = `${lockPath}.done`;
  const reclaimPath = `${lockPath}.reclaim`;

  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + effectiveWaitMs;
  const staleState = { firstSeenIncompleteHeldAt: 0 };

  let acquired = false;

  do {
    const attempt = tryAcquireHeld(heldPath, donePath, token);
    if (attempt.acquired) {
      acquired = true;
      break;
    }

    if (attempt.code === 'EEXIST') {
      const decision = checkHeldStaleCandidate(heldPath, effectiveStaleMs, staleState);
      if (decision.action === 'retry_now') {
        continue;
      }
      if (decision.action === 'reclaim') {
        tryReclaimStaleHeldSync(heldPath, donePath, reclaimPath, decision.expectedToken, effectiveStaleMs);
        continue;
      }
    }

    if (Date.now() >= deadline) break;
    sleepMs(15 + Math.floor(Math.random() * 25));
  } while (Date.now() < deadline);

  if (!acquired) {
    const err = new Error(`Lock acquisition timeout: ${lockPath}`);
    err.code = 'ELOCKED';
    throw err;
  }

  activeLocks.add(lockKey);

  let released = false;
  let resolveActivePromise = null;
  let activePromise = null;

  const release = () => {
    if (released) return;
    released = true;
    try {
      releaseHeldSync(heldPath, donePath, token);
    } finally {
      activeLocks.delete(lockKey);
      if (activePromise && activeLockPromises.get(lockKey) === activePromise) {
        activeLockPromises.delete(lockKey);
      }
      if (resolveActivePromise) resolveActivePromise();
    }
  };

  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      activePromise = new Promise((r) => {
        resolveActivePromise = r;
      });
      activeLockPromises.set(lockKey, activePromise);
      return result.finally(release);
    }
    release();
    return result;
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Non-blocking asynchronous cross-process exclusive lock.
 * Serializes concurrent callers in the same process via an in-process Promise queue
 * and polls cross-process lock slots with non-blocking timers (`setTimeout`), never
 * stalling the Node.js event loop.
 */
export async function withLockAsync(lockPath, fn, { staleMs = 30_000, waitMs = 6_000 } = {}) {
  const dir = dirname(lockPath);
  ensureDir(dir);

  const effectiveStaleMs =
    Number.isFinite(Number(staleMs)) && Number(staleMs) >= 0 ? Number(staleMs) : 30_000;
  const effectiveWaitMs =
    Number.isFinite(Number(waitMs)) && Number(waitMs) >= 0 ? Number(waitMs) : 6_000;

  const lockKey = canonicalFileKey(lockPath);
  const deadline = Date.now() + effectiveWaitMs;

  const prevQueue = asyncLockQueues.get(lockKey) || Promise.resolve();
  let releaseTurn;
  const myTurnDone = new Promise((resolvePromise) => {
    releaseTurn = resolvePromise;
  });
  const nextTail = prevQueue.then(() => myTurnDone);
  asyncLockQueues.set(lockKey, nextTail);
  nextTail.then(() => {
    if (asyncLockQueues.get(lockKey) === nextTail) {
      asyncLockQueues.delete(lockKey);
    }
  });

  const finishTurn = () => {
    releaseTurn();
  };

  const remainingForQueue = Math.max(0, deadline - Date.now());
  const gotQueueTurn = await waitWithTimeout(prevQueue, remainingForQueue);
  if (!gotQueueTurn) {
    finishTurn();
    const err = new Error(`Lock acquisition timeout: ${lockPath}`);
    err.code = 'ELOCKED';
    throw err;
  }

  try {
    // If a sync `withLock` in this process returned a Promise that is still settling, wait non-blockingly.
    const inflightSyncPromise = activeLockPromises.get(lockKey);
    if (inflightSyncPromise) {
      const rem = Math.max(0, deadline - Date.now());
      const done = await waitWithTimeout(inflightSyncPromise, rem);
      if (!done || activeLocks.has(lockKey)) {
        const err = new Error(`Lock acquisition timeout: ${lockPath}`);
        err.code = 'ELOCKED';
        throw err;
      }
    }

    const heldPath = `${lockPath}.held`;
    const donePath = `${lockPath}.done`;
    const reclaimPath = `${lockPath}.reclaim`;

    const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const staleState = { firstSeenIncompleteHeldAt: 0 };

    let acquired = false;

    do {
      if (!activeLocks.has(lockKey)) {
        const attempt = tryAcquireHeld(heldPath, donePath, token);
        if (attempt.acquired) {
          acquired = true;
          break;
        }

        if (attempt.code === 'EEXIST') {
          const decision = checkHeldStaleCandidate(heldPath, effectiveStaleMs, staleState);
          if (decision.action === 'retry_now') {
            continue;
          }
          if (decision.action === 'reclaim') {
            await tryReclaimStaleHeldAsync(
              heldPath,
              donePath,
              reclaimPath,
              decision.expectedToken,
              effectiveStaleMs,
            );
            continue;
          }
        }
      }

      if (Date.now() >= deadline) break;
      await sleepAsync(15 + Math.floor(Math.random() * 25));
    } while (Date.now() < deadline);

    if (!acquired) {
      const err = new Error(`Lock acquisition timeout: ${lockPath}`);
      err.code = 'ELOCKED';
      throw err;
    }

    activeLocks.add(lockKey);
    try {
      return await fn();
    } finally {
      try {
        await releaseHeldAsync(heldPath, donePath, token);
      } finally {
        activeLocks.delete(lockKey);
      }
    }
  } finally {
    finishTurn();
  }
}

function safeDecodePercent(input) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

export function fileUriToPath(uri) {
  if (typeof uri !== 'string') return '';
  const trimmed = uri.trim();
  if (!/^file:\/\//i.test(trimmed)) return uri;

  let rest = trimmed.slice(7);
  const cutIdx = rest.search(/[?#]/);
  if (cutIdx !== -1) rest = rest.slice(0, cutIdx);

  let host = '';
  if (!rest.startsWith('/')) {
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      host = rest;
      rest = '';
    } else {
      host = rest.slice(0, slashIdx);
      rest = rest.slice(slashIdx);
    }
    if (host.toLowerCase() === 'localhost') {
      host = '';
    }
  }

  const decoded = safeDecodePercent(rest);

  if (!host && /^\/[a-zA-Z]:(?:[\\/]|$)/.test(decoded)) {
    let winPath = decoded.slice(1);
    if (winPath.length === 2) winPath += '/';
    return process.platform === 'win32' ? winPath.replace(/\//g, '\\') : winPath;
  }

  if (host) {
    const decodedHost = safeDecodePercent(host);
    if (process.platform === 'win32') {
      return `\\\\${decodedHost}${decoded.replace(/\//g, '\\')}`;
    }
    return `//${decodedHost}${decoded}`;
  }

  return decoded;
}

export function slugify(text, maxLen = 40) {
  const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 40;
  let slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > limit) {
    slug = slug.slice(0, limit).replace(/-+$/g, '');
  }
  return slug || 'session';
}

export function truncateText(text, maxLen = 120) {
  if (text === null || text === undefined) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 120;
  if (normalized.length <= limit) return normalized;
  if (limit <= 1) return '…';
  let cut = normalized.slice(0, limit - 1);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

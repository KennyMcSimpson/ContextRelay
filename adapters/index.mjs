import { closeSync, openSync, readSync } from 'node:fs';
import { isNotSymlink, safeStat } from '../core/fs-utils.mjs';
import {
  antigravityAdapter,
  parseAnnotationPbtxtTitle,
  readAnnotationForTranscript,
} from './antigravity.mjs';

export { parseAnnotationPbtxtTitle, readAnnotationForTranscript };

export const ADAPTERS = [antigravityAdapter];

export const AGENT_IDS = ADAPTERS.map((adapter) => adapter.id);

const ADAPTER_MAP = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

const SNIFF_BYTES = 64 * 1024;
const AG_TYPES = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'SYSTEM_MESSAGE', 'CHECKPOINT']);

function normalizeAgentId(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return '';
  if (key === 'ag' || key === 'antigravity') return 'antigravity';
  return ADAPTER_MAP.has(key) ? key : '';
}

export function getAdapter(id) {
  const norm = normalizeAgentId(id);
  return norm ? ADAPTER_MAP.get(norm) || null : null;
}

export function discoverAllSources() {
  const out = [];
  for (const adapter of ADAPTERS) {
    const items = adapter.discoverSources();
    if (Array.isArray(items) && items.length > 0) {
      out.push(...items);
    }
  }
  out.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || String(a.sessionId).localeCompare(String(b.sessionId)));
  return out;
}

export function findSessionSource(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  for (const adapter of ADAPTERS) {
    if (typeof adapter.findTranscriptPath === 'function') {
      const hit = adapter.findTranscriptPath(sessionId);
      if (hit) return hit;
    } else {
      const hit = adapter.discoverSources().find((src) => src.sessionId === sessionId);
      if (hit) return hit;
    }
  }
  return null;
}

function sniffAdapterFromContent(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (!isNotSymlink(filePath)) return null;
  const st = safeStat(filePath);
  if (!st || !st.isFile() || st.size === 0) return null;

  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(Math.min(SNIFF_BYTES, st.size));
    let n = 0;
    try {
      n = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }

    const sample = buf.subarray(0, n).toString('utf-8').replace(/^\uFEFF/, '');
    const lines = sample.split('\n');

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && (obj.step_index !== undefined || AG_TYPES.has(obj.type))) {
          return antigravityAdapter;
        }
      } catch {
        // Line may be truncated by SNIFF_BYTES; fall through to structural check
      }
    }

    if (/"step_index"\s*:|"type"\s*:\s*"(?:USER_INPUT|PLANNER_RESPONSE|SYSTEM_MESSAGE|CHECKPOINT)"/.test(sample)) {
      return antigravityAdapter;
    }
  } catch {
    // ignore sniff error
  }
  return null;
}

export function detectAdapterForPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  for (const adapter of ADAPTERS) {
    if (adapter.matchesPath(filePath)) return adapter;
  }
  return sniffAdapterFromContent(filePath);
}

export function readSessionAnnotation(filePath, sessionId, options = {}) {
  return readAnnotationForTranscript(filePath, sessionId, options);
}

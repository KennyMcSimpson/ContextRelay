#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentApiClient } from '../core/agentapi.mjs';
import { readJsonFile } from '../core/fs-utils.mjs';
import { createRelayStore } from '../core/store.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONV_ID_RE = /^[0-9a-zA-Z_-]{8,128}$/;
const QUICK_ENRICH_TIMEOUT_MS = 1500;

function isUnsafeConversationId(value) {
  if (!value) return false;
  if (FORBIDDEN_KEYS.has(value)) return true;
  if (
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..')
  ) {
    return true;
  }
  return false;
}

async function main() {
  try {
    let raw = '';
    try {
      raw = readFileSync(0, 'utf-8');
    } catch {
      return;
    }

    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return;

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!payload || typeof payload !== 'object') return;

    const transcriptPath =
      typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()
        ? payload.transcriptPath.trim()
        : typeof payload.transcript_path === 'string' && payload.transcript_path.trim()
          ? payload.transcript_path.trim()
          : '';

    if (!transcriptPath) return;

    const conversationId =
      typeof payload.conversationId === 'string' && payload.conversationId.trim()
        ? payload.conversationId.trim()
        : typeof payload.conversation_id === 'string' && payload.conversation_id.trim()
          ? payload.conversation_id.trim()
          : typeof payload.sessionId === 'string' && payload.sessionId.trim()
            ? payload.sessionId.trim()
            : typeof payload.session_id === 'string' && payload.session_id.trim()
              ? payload.session_id.trim()
              : '';

    if (isUnsafeConversationId(conversationId)) return;

    const agentApi = createAgentApiClient();
    const store = createRelayStore({ agentApi });
    const syncRes = await store.syncSingle(transcriptPath, conversationId);

    const convId =
      typeof syncRes?.sessionId === 'string' && syncRes.sessionId.trim()
        ? syncRes.sessionId.trim()
        : conversationId;

    if (convId && !isUnsafeConversationId(convId) && CONV_ID_RE.test(convId)) {
      try {
        const index = readJsonFile(join(store.getDataDir(), 'index.json'), null);
        const sessions =
          index && typeof index.sessions === 'object' && index.sessions !== null
            ? index.sessions
            : null;
        const entry =
          sessions && Object.prototype.hasOwnProperty.call(sessions, convId)
            ? sessions[convId]
            : null;

        if (entry && !entry.projectId && agentApi.resolveAgentApiExecutable().available) {
          store.enrichProjects({
            limit: 1,
            targetSessionIds: [convId],
            timeoutMs: QUICK_ENRICH_TIMEOUT_MS,
          });
        }
      } catch {
        // Non-fatal lightweight project discovery failure must not block main sync
      }
    }
  } catch {
    // Silently swallow all exceptions; never emit stray output to stdout
  } finally {
    process.stdout.write('{}\n');
    process.exitCode = 0;
  }
}

main();

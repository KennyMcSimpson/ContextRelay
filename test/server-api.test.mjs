import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createApiController } from '../server/api.mjs';
import { startHttpServer } from '../server/http.mjs';

const originalBrainRoots = process.env.CONTEXT_RELAY_BRAIN_ROOTS;
const activeClosers = [];

after(async () => {
  while (activeClosers.length > 0) {
    const closeFn = activeClosers.pop();
    try {
      await closeFn();
    } catch {
      // ignore close errors during teardown
    }
  }
  if (originalBrainRoots === undefined) {
    delete process.env.CONTEXT_RELAY_BRAIN_ROOTS;
  } else {
    process.env.CONTEXT_RELAY_BRAIN_ROOTS = originalBrainRoots;
  }
});

function createTempDir(prefix = 'context-relay-http-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rawRequest({ port, method = 'GET', path: reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        agent: false,
        headers: {
          Connection: 'close',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON response
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function writeSyntheticConversation(brainDir, convId, steps, fullSteps = null) {
  const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf8',
  );
  if (fullSteps) {
    fs.writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      fullSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8',
    );
  }
}

async function createIsolatedServerFixture() {
  const sandbox = createTempDir();
  const brainDir = path.join(sandbox, 'brain');
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const shortConvId = 'conv-http-short-001';
  const fullUntruncatedText = `STEP_FULL_BEGIN\n${'UNTRUNCATED_DETAIL_LINE_9876543210\n'.repeat(40)}STEP_FULL_END`;

  // Two distinct turns so 1-based selectedTurnIndices: [1] can prove it picks Turn 1 and NOT Turn 2
  const shortSteps = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T12:00:00.000Z',
      content: '<USER_REQUEST>构建本地 HTTP 服务端接口与安全护栏 TURN_ONE_MARKER_AAA</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T12:00:05.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 14000,
      cache_read_tokens: 2000,
      output_tokens: 400,
      content: '已完成本地 loopback HTTP 服务端与 Host/Origin 校验逻辑 TURN_ONE_REPLY_AAA。',
      tool_calls: [
        { name: 'edit_file', arguments: { Path: 'E:/demo/app/server/http.mjs' } },
      ],
    },
    {
      step_index: 2,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T12:00:07.000Z',
      content: 'STEP_FULL_BEGIN...(truncated)',
      truncated_fields: ['content'],
    },
    {
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T12:02:00.000Z',
      content: '<USER_REQUEST>第二轮补充任务 TURN_TWO_MARKER_BBB</USER_REQUEST>',
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T12:02:05.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 19000,
      cache_read_tokens: 3000,
      output_tokens: 300,
      content: '已完成第二轮内容 TURN_TWO_REPLY_BBB。',
    },
  ];
  const shortFullSteps = shortSteps.map((s) =>
    s.step_index === 2
      ? { ...s, content: fullUntruncatedText, truncated_fields: undefined }
      : s,
  );
  writeSyntheticConversation(brainDir, shortConvId, shortSteps, shortFullSteps);

  // Oversized (>10KB) conversation to verify automatic file-mode handoff & redaction on POST /api/launch
  const largeConvId = 'conv-http-large-002';
  const bigTechnicalDecision =
    'Architecture invariant section: preserve exact module contract and error boundaries. '.repeat(200);
  assert.ok(Buffer.byteLength(bigTechnicalDecision, 'utf8') > 11 * 1024);

  writeSyntheticConversation(brainDir, largeConvId, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T12:10:00.000Z',
      content: '<USER_REQUEST>输出完整的架构决策记录并准备跨会话接力</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T12:10:10.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 45000,
      output_tokens: 3200,
      content: bigTechnicalDecision,
      tool_calls: [
        { name: 'write_file', arguments: { Path: 'E:/demo/app/docs/arch.md' } },
      ],
    },
  ]);

  process.env.CONTEXT_RELAY_BRAIN_ROOTS = brainDir;

  const launchCalls = [];
  let launchCounter = 0;
  const mockAgentApi = {
    resolveAgentApiExecutable: () => ({ available: true, file: 'mock-agentapi' }),
    getConversationMetadata: (convId) => ({
      ok: true,
      projectId: 'proj-http-demo',
      workspaceUris: ['file:///e%3A/demo/app'],
      primaryPath: 'E:/demo/app',
      gitRoot: 'E:/demo/app',
      branchName: 'main',
      conversationId: convId,
    }),
    startNewConversation: (opts) => {
      launchCounter += 1;
      launchCalls.push(opts);
      return {
        ok: true,
        conversationId: `conv-relaunched-00${launchCounter}`,
      };
    },
  };

  const api = createApiController({ dataDir, agentApi: mockAgentApi });
  const srv = await startHttpServer({ port: 0, host: '127.0.0.1', dataDir, api });
  activeClosers.push(async () => {
    if (typeof srv.server?.closeAllConnections === 'function') {
      srv.server.closeAllConnections();
    }
    await srv.close();
  });

  return {
    port: srv.port,
    dataDir,
    shortConvId,
    largeConvId,
    launchCalls,
  };
}

describe('server HTTP + API integration & security guards', () => {
  test('refuses to bind to non-loopback host (0.0.0.0)', async () => {
    await assert.rejects(
      () => startHttpServer({ port: 0, host: '0.0.0.0', dataDir: createTempDir() }),
      /non-loopback/i,
    );
  });

  test('serves static UI assets (with CSP), full API lifecycle, 1-based selectedTurnIndices, file-mode extraInstruction redaction, and lineage.originalPeakTokens', async () => {
    const { port, shortConvId, largeConvId, launchCalls } = await createIsolatedServerFixture();
    assert.ok(port > 0, 'server must bind to an ephemeral port');

    const sameOriginJsonHeaders = {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
    };
    const customHeaderJsonHeaders = {
      'Content-Type': 'application/json',
      'X-Context-Relay': '1',
    };

    // 1. Static UI assets & CSP header on GET /
    const htmlRes = await rawRequest({ port, path: '/' });
    assert.equal(htmlRes.status, 200);
    assert.ok(String(htmlRes.headers['content-type']).includes('text/html'));
    const cspHeader = String(htmlRes.headers['content-security-policy'] || '');
    assert.ok(cspHeader.includes("default-src 'self'"), `GET / must return CSP header, got: ${cspHeader}`);
    assert.ok(cspHeader.includes("frame-ancestors 'none'"), `CSP must forbid framing, got: ${cspHeader}`);
    assert.ok(htmlRes.text.length > 0);

    const cssRes = await rawRequest({ port, path: '/styles.css' });
    assert.equal(cssRes.status, 200);
    assert.ok(String(cssRes.headers['content-type']).includes('text/css'));
    assert.ok(cssRes.text.length > 0);

    const jsRes = await rawRequest({ port, path: '/app.js' });
    assert.equal(jsRes.status, 200);
    assert.ok(String(jsRes.headers['content-type']).includes('javascript'));
    assert.ok(jsRes.text.length > 0);

    // 2. GET /api/state
    const stateRes = await rawRequest({ port, path: '/api/state' });
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.json?.ok, true);
    assert.equal(stateRes.json?.agentApiAvailable, true);

    // 3. GET /api/sessions
    const sessionsRes = await rawRequest({ port, path: '/api/sessions?hideSubagents=false' });
    assert.equal(sessionsRes.status, 200);
    const sessionsList = sessionsRes.json?.sessions ?? [];
    assert.ok(sessionsList.some((s) => s.sessionId === shortConvId));
    assert.ok(sessionsList.some((s) => s.sessionId === largeConvId));

    // 4. GET /api/session (valid + 404 negative control)
    const detailRes = await rawRequest({
      port,
      path: `/api/session?id=${encodeURIComponent(shortConvId)}`,
    });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.json?.session?.turns?.length, 2);

    const missingSessionRes = await rawRequest({
      port,
      path: '/api/session?id=nonexistent-session-xyz',
    });
    assert.equal(missingSessionRes.status, 404);
    assert.equal(missingSessionRes.json?.ok, false);

    // 5. GET /api/step-full
    const stepFullRes = await rawRequest({
      port,
      path: `/api/step-full?id=${encodeURIComponent(shortConvId)}&stepIndex=2`,
    });
    assert.equal(stepFullRes.status, 200);
    assert.ok(
      String(stepFullRes.json?.content ?? stepFullRes.json?.step?.content ?? '').includes('STEP_FULL_END'),
      `GET /api/step-full must return untruncated transcript_full.jsonl content: ${stepFullRes.text}`,
    );

    // 6. POST /api/preview with 1-based selectedTurnIndices: [1] must select Turn 1 and exclude Turn 2
    const previewRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/preview',
      headers: sameOriginJsonHeaders,
      body: {
        id: shortConvId,
        selectedTurnIndices: [1],
        redact: true,
        includeGitAnchor: false,
        extraInstruction: '继续完善测试覆盖率',
      },
    });
    assert.equal(previewRes.status, 200);
    const previewMd = String(previewRes.json?.bundle?.markdown ?? '');
    assert.ok(previewMd.includes('继续完善测试覆盖率'));
    assert.ok(previewMd.includes('TURN_ONE_MARKER_AAA'), 'selectedTurnIndices: [1] must select 1-based Turn 1');
    assert.ok(!previewMd.includes('TURN_TWO_MARKER_BBB'), 'selectedTurnIndices: [1] must NOT select Turn 2');

    // 7. POST /api/export (verified using X-Context-Relay: 1 header without Origin)
    const exportRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/export',
      headers: customHeaderJsonHeaders,
      body: {
        id: shortConvId,
        selectedTurnIds: ['turn-1'],
        redact: true,
        includeGitAnchor: false,
      },
    });
    assert.equal(exportRes.status, 200);
    const exportedFilename = exportRes.json?.filename;
    assert.ok(exportedFilename && exportedFilename.endsWith('.md'));

    // 8. GET /api/archive
    const archiveRes = await rawRequest({
      port,
      path: `/api/archive?filename=${encodeURIComponent(exportedFilename)}`,
    });
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.json?.ok, true);
    assert.ok(String(archiveRes.json?.content ?? '').includes('HTTP'));

    // 9. POST /api/launch (short inline + >10KB auto file mode with secret redaction in extraInstruction)
    const launchShortRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/launch',
      headers: sameOriginJsonHeaders,
      body: {
        id: shortConvId,
        selectedTurnIndices: [1],
        redact: true,
        includeGitAnchor: false,
        extraInstruction: '短包接力继续开发',
      },
    });
    assert.equal(launchShortRes.status, 200);
    assert.equal(launchShortRes.json?.conversationId, 'conv-relaunched-001');
    assert.equal(launchShortRes.json?.launchMode, 'inline');
    assert.equal(launchCalls.length, 1);
    assert.ok(launchCalls[0].prompt.includes('TURN_ONE_MARKER_AAA'));
    assert.ok(!launchCalls[0].prompt.includes('TURN_TWO_MARKER_BBB'));

    const extraSecretKey = 'real_secret_value_77665544';
    const extraSecretGhp = 'ghp' + '_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    const launchLargeRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/launch',
      headers: sameOriginJsonHeaders,
      body: {
        id: largeConvId,
        selectedTurnIds: ['turn-1'],
        redact: true,
        includeGitAnchor: false,
        extraInstruction: `超长交接包检查 API_KEY=${extraSecretKey} 与 ${extraSecretGhp}`,
      },
    });
    assert.equal(launchLargeRes.status, 200);
    assert.equal(launchLargeRes.json?.conversationId, 'conv-relaunched-002');
    assert.equal(launchLargeRes.json?.launchMode, 'file');
    assert.equal(launchCalls.length, 2);

    const sentPrompt = launchCalls[1]?.prompt ?? '';
    assert.ok(
      Buffer.byteLength(sentPrompt, 'utf8') < 2048,
      `file-mode launch prompt must be < 2KB, got ${Buffer.byteLength(sentPrompt, 'utf8')} bytes`,
    );
    const savedHandoffPath = launchLargeRes.json?.handoffFilePath ?? '';
    assert.ok(savedHandoffPath && fs.existsSync(savedHandoffPath));
    assert.ok(sentPrompt.includes(savedHandoffPath), 'file-mode prompt must include handoffFilePath');
    assert.ok(!sentPrompt.includes(extraSecretKey), 'file-mode launch prompt must not leak API_KEY from extraInstruction');
    assert.ok(!sentPrompt.includes(extraSecretGhp), 'file-mode launch prompt must not leak ghp_ from extraInstruction');
    assert.ok(sentPrompt.includes('[REDACTED:'), 'file-mode launch prompt must contain [REDACTED:...] placeholder');

    // 10. GET /api/lineage verifies both launches recorded & originalPeakTokens > 0
    const lineageRes = await rawRequest({ port, path: '/api/lineage' });
    assert.equal(lineageRes.status, 200);
    const lineageItems = lineageRes.json?.lineage ?? [];
    assert.ok(lineageItems.length >= 2);
    assert.ok(
      typeof lineageItems[0].originalPeakTokens === 'number' && lineageItems[0].originalPeakTokens > 0,
      `lineage[0].originalPeakTokens must be > 0, got: ${JSON.stringify(lineageItems[0])}`,
    );
    assert.ok(lineageItems.some((item) => item.targetSessionId === 'conv-relaunched-001'));
    assert.ok(lineageItems.some((item) => item.targetSessionId === 'conv-relaunched-002'));
  });

  test('enforces Host port/hostname 403, full CSRF matrix (403/415), malformed JSON 400, archive traversal rejection, and __proto__ workspace 400', async () => {
    const { port, dataDir, shortConvId } = await createIsolatedServerFixture();

    // Prime index.json & projects.json
    const initRes = await rawRequest({ port, path: '/api/state' });
    assert.equal(initRes.status, 200);
    const validWsRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/workspace',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: { projectId: 'proj-legit-001', workspacePath: 'E:/demo/legit' },
    });
    assert.equal(validWsRes.status, 200);

    // Guard A: DNS rebinding protection - spoofed Host, wrong port, omitted port on non-80
    for (const badHost of ['evil.example.com', '127.0.0.1:9999', '127.0.0.1']) {
      const res = await rawRequest({
        port,
        path: '/api/state',
        headers: { Host: badHost },
      });
      assert.equal(res.status, 403, `Host: ${badHost} must return 403, got ${res.status}`);
    }

    // Guard B: Strong CSRF matrix on POST /api/export
    // B1. Missing both Origin and X-Context-Relay -> 403
    const noOriginNoCustom = await rawRequest({
      port,
      method: 'POST',
      path: '/api/export',
      headers: { 'Content-Type': 'application/json' },
      body: { id: shortConvId, selectedTurnIds: ['turn-1'] },
    });
    assert.equal(noOriginNoCustom.status, 403, `POST without Origin or X-Context-Relay must return 403, got ${noOriginNoCustom.status}`);

    // B2. Cross-origin Origin -> 403
    const badOriginRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/export',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
      },
      body: { id: shortConvId, selectedTurnIds: ['turn-1'] },
    });
    assert.equal(badOriginRes.status, 403, `cross-origin POST must return 403, got ${badOriginRes.status}`);

    // B3. Empty Origin: "" -> 403
    const emptyOriginRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/export',
      headers: {
        'Content-Type': 'application/json',
        Origin: '',
      },
      body: { id: shortConvId, selectedTurnIds: ['turn-1'] },
    });
    assert.equal(emptyOriginRes.status, 403, `empty Origin POST must return 403, got ${emptyOriginRes.status}`);

    // B4. Origin: null -> 403
    const nullOriginRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/export',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'null',
      },
      body: { id: shortConvId, selectedTurnIds: ['turn-1'] },
    });
    assert.equal(nullOriginRes.status, 403, `Origin: null POST must return 403, got ${nullOriginRes.status}`);

    // B5. Content-Type: text/plain (even with X-Context-Relay: 1) -> 415
    const textPlainRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/export',
      headers: {
        'Content-Type': 'text/plain',
        'X-Context-Relay': '1',
      },
      body: JSON.stringify({ id: shortConvId, selectedTurnIds: ['turn-1'] }),
    });
    assert.equal(textPlainRes.status, 415, `Content-Type: text/plain POST must return 415, got ${textPlainRes.status}`);

    // Guard C: Invalid JSON body to POST /api/preview -> 400
    const badJsonRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/preview',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: '{"broken_json": [1, 2,',
    });
    assert.equal(badJsonRes.status, 400, `malformed JSON body must return 400, got ${badJsonRes.status}`);

    // Guard D: Archive path traversal (raw, backslash, URL-encoded) rejected
    for (const badParam of ['../index.json', '..\\index.json', '..%2Findex.json']) {
      const traversalRes = await rawRequest({
        port,
        path: `/api/archive?filename=${badParam}`,
      });
      assert.notEqual(traversalRes.status, 200, `traversal ${badParam} must not return 200`);
      assert.equal(traversalRes.json?.ok, false);
      assert.ok(!traversalRes.text.includes(shortConvId), `traversal ${badParam} must not leak index.json`);
    }

    // Guard E: POST /api/workspace with projectId: "__proto__" returns 400 and does not corrupt projects.json
    const protoWsRes = await rawRequest({
      port,
      method: 'POST',
      path: '/api/workspace',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: { projectId: '__proto__', workspacePath: 'E:/evil/proto' },
    });
    assert.equal(protoWsRes.status, 400, `POST /api/workspace with __proto__ must return 400, got ${protoWsRes.status}`);
    assert.equal(protoWsRes.json?.ok, false);

    const projectsJsonPath = path.join(dataDir, 'projects.json');
    const projectsData = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(projectsData.projects, '__proto__'), false);
    assert.ok(projectsData.projects['proj-legit-001'], 'legitimate project record must remain intact');
  });
});

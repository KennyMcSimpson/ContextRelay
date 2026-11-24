import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  fileUriToPath,
  slugify,
  atomicWriteFile,
  withLock,
  withLockAsync,
  canonicalFileKey,
} from '../core/fs-utils.mjs';
import { createRelayStore } from '../core/store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FS_UTILS_URL = pathToFileURL(path.resolve(__dirname, '..', 'core', 'fs-utils.mjs')).href;

const originalBrainRoots = process.env.CONTEXT_RELAY_BRAIN_ROOTS;

after(() => {
  if (originalBrainRoots === undefined) {
    delete process.env.CONTEXT_RELAY_BRAIN_ROOTS;
  } else {
    process.env.CONTEXT_RELAY_BRAIN_ROOTS = originalBrainRoots;
  }
});

function createTempDir(prefix = 'context-relay-store-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSyntheticConversation(brainDir, convId, steps, fullSteps = null) {
  const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptPath,
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
  return transcriptPath;
}

function runWorkerProcess(workerPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('fs-utils: fileUriToPath, slugify, canonicalFileKey, atomicWriteFile, withLock & withLockAsync', () => {
  test('fileUriToPath decodes Windows encoded Chinese URI and POSIX URI accurately', () => {
    const winUri = 'file:///e%3A/' + 'Eco' + 'system/projects/%E6%8F%92%E4%BB%B6';
    const winPath = fileUriToPath(winUri);
    assert.ok(/^[eE]:[\\/]/.test(winPath), `expected Windows drive path, got: ${winPath}`);
    assert.ok(winPath.includes('插件'), `expected decoded Chinese segment "插件", got: ${winPath}`);
    assert.ok(!winPath.includes('%3A') && !winPath.includes('%E6'));

    const posixPath = fileUriToPath('file:///Users/dev/app');
    assert.equal(posixPath.replace(/\\/g, '/'), '/Users/dev/app');
  });

  test('slugify sanitizes punctuation/separators and canonicalFileKey normalizes paths', () => {
    const slug = slugify('Fix Auth / Login: 中文测试 2026!@#');
    assert.equal(typeof slug, 'string');
    assert.ok(slug.length > 0);
    assert.ok(!/[\\/:*?"<>|]/.test(slug), `slug must not contain unsafe path chars: ${slug}`);

    const k1 = canonicalFileKey('E:/Demo/Sub/App.mjs');
    const k2 = canonicalFileKey('e:\\Demo\\Sub\\App.mjs');
    if (process.platform === 'win32') {
      assert.equal(k1, k2, 'canonicalFileKey should treat slash/case variants identically on Windows');
    } else {
      assert.equal(typeof k1, 'string');
      assert.ok(k1.length > 0);
    }
  });

  test('atomicWriteFile writes UTF-8 without BOM and replaces content cleanly', () => {
    const dir = createTempDir('context-relay-atomic-');
    const target = path.join(dir, 'state.json');

    atomicWriteFile(target, JSON.stringify({ hello: '世界', v: 1 }), 'utf8');
    const raw1 = fs.readFileSync(target);
    assert.ok(!(raw1[0] === 0xef && raw1[1] === 0xbb && raw1[2] === 0xbf), 'must be UTF-8 without BOM');
    assert.deepEqual(JSON.parse(raw1.toString('utf8')), { hello: '世界', v: 1 });

    atomicWriteFile(target, JSON.stringify({ hello: '更新', v: 2 }), 'utf8');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { hello: '更新', v: 2 });
  });

  test('real multi-process lock stress test: 6 worker processes x 20 RMW updates = exact 120 with zero lost updates and no .held/.reclaim residue', async () => {
    const dir = createTempDir('context-relay-mp-lock-');
    const lockPath = path.join(dir, 'shared.lock');
    const counterPath = path.join(dir, 'counter.json');
    const workerPath = path.join(dir, 'lock-worker.mjs');

    fs.writeFileSync(counterPath, JSON.stringify({ count: 0 }), 'utf8');
    fs.writeFileSync(
      workerPath,
      [
        "import fs from 'node:fs';",
        'const [fsUtilsUrl, lockPath, counterPath, iterStr] = process.argv.slice(2);',
        'const { withLock, atomicWriteFile } = await import(fsUtilsUrl);',
        'const iterations = Number(iterStr);',
        'for (let i = 0; i < iterations; i += 1) {',
        '  withLock(',
        '    lockPath,',
        '    () => {',
        "      const data = JSON.parse(fs.readFileSync(counterPath, 'utf8'));",
        '      data.count += 1;',
        '      atomicWriteFile(counterPath, JSON.stringify(data));',
        '    },',
        '    { waitMs: 30000, staleMs: 30000 },',
        '  );',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const workerCount = 6;
    const iterationsPerWorker = 20;
    const expectedTotal = workerCount * iterationsPerWorker;

    const results = await Promise.all(
      Array.from({ length: workerCount }, () =>
        runWorkerProcess(workerPath, [FS_UTILS_URL, lockPath, counterPath, String(iterationsPerWorker)]),
      ),
    );

    for (let i = 0; i < results.length; i += 1) {
      assert.equal(
        results[i].code,
        0,
        `worker #${i} exited with code ${results[i].code}, stderr: ${results[i].stderr}`,
      );
    }

    const finalData = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
    const lostUpdates = expectedTotal - finalData.count;
    assert.equal(finalData.count, expectedTotal, `expected exact ${expectedTotal} updates, got ${finalData.count}`);
    assert.equal(lostUpdates, 0);
    assert.equal(fs.existsSync(`${lockPath}.held`), false, '.held slot must not remain after lock release');
    assert.equal(fs.existsSync(`${lockPath}.reclaim`), false, '.reclaim slot must not remain after lock release');
  });

  test('withLock recovers stale dead-PID zombie lock (.held) and rejects same-process re-entrancy with ELOCK_REENTRANT', () => {
    const dir = createTempDir('context-relay-lock-reclaim-');
    const lockPath = path.join(dir, 'reclaim.lock');

    // Simulate zombie/stale lock by writing a dead PID to <lockPath>.held with old mtime
    const heldPath = `${lockPath}.held`;
    const staleTimestamp = Date.now() - 10 * 60 * 1000;
    fs.writeFileSync(
      heldPath,
      JSON.stringify({ pid: 999999, ts: staleTimestamp, token: 'dead-holder-token' }),
      'utf8',
    );
    const oldDate = new Date(staleTimestamp);
    fs.utimesSync(heldPath, oldDate, oldDate);

    let recovered = false;
    const returnVal = withLock(lockPath, () => {
      recovered = true;
      return 'lock-recovered-ok';
    });
    assert.equal(recovered, true, 'withLock must reclaim dead-PID stale lock and run callback');
    assert.equal(returnVal, 'lock-recovered-ok');
    assert.equal(fs.existsSync(heldPath), false);
    assert.equal(fs.existsSync(`${lockPath}.reclaim`), false);

    // Same-process nested synchronous withLock must throw ELOCK_REENTRANT
    const reentrantLock = path.join(dir, 'reentrant.lock');
    assert.throws(
      () => {
        withLock(reentrantLock, () => {
          withLock(reentrantLock, () => 'should-never-run');
        });
      },
      (err) => err && err.code === 'ELOCK_REENTRANT',
      'nested synchronous withLock on same lockPath must throw ELOCK_REENTRANT',
    );
    assert.equal(fs.existsSync(`${reentrantLock}.held`), false, 'outer lock must release cleanly on error');
  });

  test('withLockAsync serializes 4 concurrent same-process callers (maxInFlight === 1) without freezing the event loop', async () => {
    const dir = createTempDir('context-relay-async-lock-');
    const lockPath = path.join(dir, 'async.lock');

    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    let timerTicks = 0;

    const timer = setInterval(() => {
      timerTicks += 1;
    }, 5);

    try {
      const results = await Promise.all(
        [0, 1, 2, 3].map((idx) =>
          withLockAsync(lockPath, async () => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            order.push(`enter-${idx}`);
            await new Promise((r) => setTimeout(r, 25));
            order.push(`exit-${idx}`);
            inFlight -= 1;
            return idx * 10;
          }),
        ),
      );

      assert.deepEqual(results, [0, 10, 20, 30]);
      assert.equal(maxInFlight, 1, `withLockAsync must enforce max concurrency === 1, got ${maxInFlight}`);
      assert.ok(timerTicks >= 3, `event loop timer must keep firing during withLockAsync, got ${timerTicks} ticks`);
      assert.equal(order.length, 8);
      assert.equal(fs.existsSync(`${lockPath}.held`), false);
    } finally {
      clearInterval(timer);
    }
  });
});

describe('store: syncAll, listSessions, enrichProjects, prototype safety, archives, lineage, and long-session search', () => {
  test('isolates via CONTEXT_RELAY_BRAIN_ROOTS, runs incremental sync, multi-term search, enrichment with cooldown, prototype/archive guards, and lineage persistence', () => {
    const sandbox = createTempDir('context-relay-store-suite-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const conv1Path = writeSyntheticConversation(brainDir, 'conv-alpha-001', [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T09:00:00.000Z',
        content: '<USER_REQUEST>优化神经网络 decoder 推理延迟并运行 benchmark</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T09:00:05.000Z',
        model: 'gemini-2.5-pro',
        input_tokens: 15000,
        cache_read_tokens: 2000,
        output_tokens: 300,
        content: '已经修改 src/decoder.mjs 减少张量拷贝，benchmark 延迟下降 28%。',
        tool_calls: [
          { name: 'edit_file', arguments: { Path: 'E:/demo/proj-alpha/src/decoder.mjs' } },
        ],
      },
    ]);

    writeSyntheticConversation(brainDir, 'conv-beta-002', [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T09:30:00.000Z',
        content: '<USER_REQUEST>给神经网络网关 router 增加 telemetry 指标</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T09:30:08.000Z',
        model: 'claude-sonnet-4',
        input_tokens: 9000,
        cache_read_tokens: 1000,
        output_tokens: 240,
        content: '已更新 src/router.mjs 上报延迟直方图。',
        tool_calls: [
          { name: 'edit_file', arguments: { Path: 'E:/demo/proj-alpha/src/router.mjs' } },
        ],
      },
    ]);

    // Subagent session: uses real SYSTEM_MESSAGE sender directive
    writeSyntheticConversation(brainDir, 'conv-subagent-003', [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T09:40:00.000Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T09:40:00Z sender=conv-alpha-001 priority=MESSAGE_PRIORITY_HIGH content=后台核查神经网络配置\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T09:40:04.000Z',
        model: 'gemini-2.5-pro',
        input_tokens: 3200,
        output_tokens: 120,
        content: '子代理核查完成。',
        tool_calls: [
          { name: 'send_message', arguments: { Recipient: 'conv-alpha-001', Message: 'ok' } },
        ],
      },
    ]);

    // Isolate strictly to synthetic brainDir
    process.env.CONTEXT_RELAY_BRAIN_ROOTS = brainDir;

    const metaCalls = new Map();
    const mockAgentApi = {
      resolveAgentApiExecutable: () => ({ available: true, file: 'mock-agentapi' }),
      getConversationMetadata: (convId) => {
        metaCalls.set(convId, (metaCalls.get(convId) || 0) + 1);
        if (convId === 'conv-alpha-001' || convId === 'conv-beta-002') {
          return {
            ok: true,
            projectId: 'proj-neural-alpha',
            workspaceUris: ['file:///e%3A/demo/proj-alpha'],
            primaryPath: 'E:/demo/proj-alpha',
            gitRoot: 'E:/demo/proj-alpha',
            branchName: 'main',
          };
        }
        return { ok: false, error: 'transient metadata error' };
      },
    };

    const store = createRelayStore({ dataDir, agentApi: mockAgentApi });

    // 1. Initial full sync
    const sync1 = store.syncAll();
    assert.equal(sync1.totalSources, 3);
    assert.equal(sync1.updated, 3);
    assert.equal(sync1.skipped, 0);

    // 2. Second sync with no changes skips all 3
    const sync2 = store.syncAll();
    assert.equal(sync2.skipped, 3);
    assert.equal(sync2.updated, 0);

    // 3. Modify 1 transcript file => incremental sync updates only 1 and skips 2
    const extraStep = {
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T09:50:00.000Z',
      content: '<USER_REQUEST>补充验证增量同步关键字 incrementalToken99</USER_REQUEST>',
    };
    fs.appendFileSync(conv1Path, JSON.stringify(extraStep) + '\n', 'utf8');
    const bumpedTime = new Date(Date.now() + 5000);
    fs.utimesSync(conv1Path, bumpedTime, bumpedTime);

    const sync3 = store.syncAll();
    assert.equal(sync3.updated, 1);
    assert.equal(sync3.skipped, 2);

    // 4. listSessions: hideSubagents, multi-term AND search (CN + EN), model filter
    const allRes = store.listSessions({ hideSubagents: false });
    assert.equal(allRes.sessions.length, 3);

    const mainOnlyRes = store.listSessions({ hideSubagents: true });
    assert.equal(mainOnlyRes.sessions.length, 2);
    assert.ok(!mainOnlyRes.sessions.some((s) => s.sessionId === 'conv-subagent-003'));

    // Multi-word AND search: Chinese + English
    const andHit = store.listSessions({ q: '神经网络 decoder', hideSubagents: false });
    assert.equal(andHit.sessions.length, 1);
    assert.equal(andHit.sessions[0].sessionId, 'conv-alpha-001');

    // Incremental update text is searchable
    const incHit = store.listSessions({ q: 'incrementalToken99', hideSubagents: false });
    assert.equal(incHit.sessions.length, 1);
    assert.equal(incHit.sessions[0].sessionId, 'conv-alpha-001');

    // Negative control: one matching word + one non-existent word must return 0 (proving AND, not OR)
    const andMiss = store.listSessions({ q: '神经网络 nonexistent_xyz_term', hideSubagents: false });
    assert.equal(andMiss.sessions.length, 0);

    // Model filter
    const claudeOnly = store.listSessions({ model: 'claude-sonnet-4', hideSubagents: false });
    assert.equal(claudeOnly.sessions.length, 1);
    assert.equal(claudeOnly.sessions[0].sessionId, 'conv-beta-002');

    // 5. enrichProjects: deduplicates projects.json & enforces failure cooldown
    const enrich1 = store.enrichProjects();
    assert.equal(enrich1.checked, 3);
    assert.equal(enrich1.enriched, 2);
    assert.equal(enrich1.totalProjects, 1);

    const byProject = store.listSessions({ projectId: 'proj-neural-alpha', hideSubagents: false });
    assert.equal(byProject.sessions.length, 2);
    assert.equal(byProject.sessions[0].workspacePath, 'E:/demo/proj-alpha');

    const projectsJsonPath = path.join(dataDir, 'projects.json');
    assert.ok(fs.existsSync(projectsJsonPath), 'projects.json must be persisted in dataDir');
    const projectsData = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
    assert.deepEqual(Object.keys(projectsData.projects), ['proj-neural-alpha']);
    assert.equal(projectsData.projects['proj-neural-alpha'].primaryPath, 'E:/demo/proj-alpha');

    // Failure cooldown check: conv-subagent-003 failed once; immediate retry must be skipped during cooldown
    assert.equal(metaCalls.get('conv-subagent-003'), 1);
    const enrich2 = store.enrichProjects();
    assert.equal(enrich2.checked, 0);
    assert.equal(
      metaCalls.get('conv-subagent-003'),
      1,
      'enrichProjects must honor failure cooldown and not re-query failed conversation immediately',
    );

    // 6. Prototype pollution negative controls on registerWorkspaceProject
    const protoRes = store.registerWorkspaceProject({
      projectId: '__proto__',
      primaryPath: 'E:/evil/proto',
    });
    assert.equal(protoRes?.ok, false, '__proto__ projectId must be rejected with { ok: false }');

    const ctorRes = store.registerWorkspaceProject({
      projectId: 'constructor',
      primaryPath: 'E:/evil/ctor',
    });
    assert.equal(ctorRes?.ok, false, 'constructor projectId must be rejected with { ok: false }');

    const projectsAfterPoison = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(projectsAfterPoison.projects, '__proto__'),
      false,
      'projects.json must not contain __proto__ own key',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(projectsAfterPoison.projects, 'constructor'),
      false,
      'projects.json must not contain constructor own key',
    );
    assert.equal(({}).primaryPath, undefined, 'Object.prototype must not be polluted');

    // 7. saveHandoffFile / listArchives / readArchive + path traversal & Windows filename edge negative controls
    const saved = store.saveHandoffFile({
      sourceSessionId: 'conv-alpha-001',
      title: 'Decoder Latency Handoff',
      markdown: '# Handoff\n\nPreserve decoder optimization details.\n',
    });
    assert.ok(saved.filename.endsWith('.md'));
    assert.ok(fs.existsSync(saved.filePath));

    const archives = store.listArchives();
    assert.ok(archives.some((a) => a.filename === saved.filename));

    const readOk = store.readArchive(saved.filename);
    assert.equal(readOk.ok, true);
    assert.ok(readOk.content.includes('Preserve decoder optimization details.'));

    // Plant sentinel file outside archives dir to ensure traversal cannot read it
    fs.writeFileSync(path.join(dataDir, 'secret.md'), 'TOP_SECRET_OUTSIDE_ARCHIVE', 'utf8');
    const forbiddenArchiveNames = [
      '../index.json',
      '..\\secret.md',
      '../secret.md',
      'sub/../../index.json',
      '/etc/passwd',
      'con .md',
      'nul .md',
      'valid.md:ads.md',
    ];
    for (const badName of forbiddenArchiveNames) {
      const badRes = store.readArchive(badName);
      assert.equal(badRes.ok, false, `forbidden archive filename must be rejected with ok: false: ${badName}`);
      assert.ok(
        !(badRes.content ?? '').includes('TOP_SECRET_OUTSIDE_ARCHIVE'),
        `rejected filename must never leak outer file content: ${badName}`,
      );
    }

    // 8. recordLineage / listLineage persistence & reverse chronological order
    store.recordLineage({
      sourceSessionId: 'conv-alpha-001',
      targetSessionId: 'conv-new-101',
      mode: 'inline',
      createdAt: '2026-11-24T10:00:00.000Z',
    });
    store.recordLineage({
      sourceSessionId: 'conv-beta-002',
      targetSessionId: 'conv-new-102',
      mode: 'file',
      handoffFilePath: saved.filePath,
      createdAt: '2026-11-24T10:05:00.000Z',
    });

    // Re-instantiate store from same dataDir to verify on-disk persistence
    const reopenedStore = createRelayStore({ dataDir, agentApi: mockAgentApi });
    const lineageItems = reopenedStore.listLineage();
    assert.equal(lineageItems.length, 2);
    assert.equal(lineageItems[0].targetSessionId, 'conv-new-102');
    assert.equal(lineageItems[1].targetSessionId, 'conv-new-101');
  });

  test('indexes and searches middle turns in long 12-turn conversations (turn 6 needle hit)', () => {
    const sandbox = createTempDir('context-relay-long-search-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const steps = [];
    let stepIndex = 0;
    for (let turnNum = 1; turnNum <= 12; turnNum += 1) {
      const uniqueNeedle =
        turnNum === 6
          ? '这里埋入中段第6轮唯一检索词 midTurnNeedleGamma6677 用于验证全轮次索引'
          : `常规第 ${turnNum} 轮迭代讨论与常规背景信息`;
      steps.push({
        step_index: stepIndex++,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: `2026-11-24T11:${String(turnNum).padStart(2, '0')}:00.000Z`,
        content: `<USER_REQUEST>${uniqueNeedle}</USER_REQUEST>`,
      });
      steps.push({
        step_index: stepIndex++,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: `2026-11-24T11:${String(turnNum).padStart(2, '0')}:10.000Z`,
        model: 'gemini-2.5-pro',
        input_tokens: 5000 + turnNum * 1500,
        output_tokens: 150,
        content:
          turnNum === 6
            ? '已确认中段第6轮核心结论 midTurnNeedleGamma6677 并记录在案。'
            : `第 ${turnNum} 轮常规答复完成。`,
      });
    }

    writeSyntheticConversation(brainDir, 'conv-long-12turns', steps);
    process.env.CONTEXT_RELAY_BRAIN_ROOTS = brainDir;

    const store = createRelayStore({ dataDir });
    const syncRes = store.syncAll();
    assert.equal(syncRes.updated, 1);

    const hit = store.listSessions({ q: 'midTurnNeedleGamma6677', hideSubagents: false });
    assert.equal(hit.sessions.length, 1, 'middle turn (turn 6 of 12) keyword must be searchable');
    assert.equal(hit.sessions[0].sessionId, 'conv-long-12turns');

    const miss = store.listSessions({ q: 'midTurnNeedleGamma6677 nonexistentTerm999', hideSubagents: false });
    assert.equal(miss.sessions.length, 0);
  });
});

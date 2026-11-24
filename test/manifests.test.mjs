import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  collectGitAnchor,
  collectGitAnchorAsync,
} from '../core/git-anchor.mjs';
import {
  extractBinaryFromShim,
  resolveAgentApiExecutable,
  parseMetadataPayload,
  createAgentApiClient,
} from '../core/agentapi.mjs';
import { formatForkTitle } from '../bin/context-relay.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const ALLOWED_PLUGIN_FIELDS = new Set([
  'name',
  'displayName',
  'description',
  'version',
  'logo',
  'suggestedPrompts',
  'author',
  'homepage',
  'repository',
  'disabled',
]);

function createTempDir(prefix = 'context-relay-manifests-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeIsolatedCliEnv(sandbox, brainDir, dataDir, extra = {}) {
  return {
    ...process.env,
    CONTEXT_RELAY_BRAIN_ROOTS: brainDir,
    CONTEXT_RELAY_DATA_DIR: dataDir,
    ANTIGRAVITY_AGENTAPI_EXE: '',
    ANTIGRAVITY_EXECUTABLE: '',
    ANTIGRAVITY_CONVERSATION_ID: '',
    LOCALAPPDATA: sandbox,
    USERPROFILE: sandbox,
    HOME: sandbox,
    ...extra,
  };
}

function walkFiles(
  rootDir,
  {
    skipDirs = new Set(['.git', 'node_modules', '.local-data']),
    skipFiles = new Set(['.local-config.json']),
  } = {},
) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          stack.push(fullPath);
        }
      } else if (!skipFiles.has(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function assertNoSymlinksRecursive(rootDir) {
  const stack = [rootDir];
  let checkedCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const lst = fs.lstatSync(current);
    assert.equal(lst.isSymbolicLink(), false, `symlink forbidden at: ${current}`);
    checkedCount += 1;
    if (lst.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        stack.push(path.join(current, name));
      }
    }
  }
  return checkedCount;
}

describe('manifests (v0.2.1 zero-UI native /fork plugin): plugin.json, hooks.json, sidecar.json, SKILL.md, benchmark SVG', () => {
  test('plugin.json has version 0.2.1, only Antigravity whitelisted top-level fields, <=3 /fork suggestedPrompts, and existing logo', () => {
    const pluginPath = path.join(REPO_ROOT, 'plugin.json');
    assert.ok(fs.existsSync(pluginPath), 'plugin.json must exist');

    const manifest = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
    assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));

    for (const key of Object.keys(manifest)) {
      assert.ok(
        ALLOWED_PLUGIN_FIELDS.has(key),
        `plugin.json contains disallowed top-level field: ${key}`,
      );
    }

    assert.equal(manifest.version, '0.2.1', 'plugin.json version must be 0.2.1');
    assert.equal(typeof manifest.name, 'string');
    assert.ok(manifest.name.trim().length > 0);
    assert.equal(typeof manifest.displayName, 'string');
    assert.ok(manifest.displayName.trim().length > 0);
    assert.equal(typeof manifest.description, 'string');
    assert.ok(manifest.description.trim().length > 0);

    assert.ok(Array.isArray(manifest.suggestedPrompts), 'suggestedPrompts must be an array');
    assert.ok(
      manifest.suggestedPrompts.length >= 1 && manifest.suggestedPrompts.length <= 3,
      `suggestedPrompts length must be 1..3, got ${manifest.suggestedPrompts.length}`,
    );
    for (const prompt of manifest.suggestedPrompts) {
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt.trim().length > 0);
    }
    assert.ok(
      manifest.suggestedPrompts.some((p) => p.includes('/fork')),
      'suggestedPrompts should showcase the primary /fork command',
    );

    assert.equal(typeof manifest.logo, 'string');
    assert.ok(manifest.logo.trim().length > 0);
    assert.ok(!path.isAbsolute(manifest.logo), 'plugin.json logo must be a relative path');
    const logoPath = path.resolve(REPO_ROOT, manifest.logo);
    assert.ok(fs.existsSync(logoPath), `logo file referenced by plugin.json must exist: ${logoPath}`);
    assert.ok(fs.statSync(logoPath).size > 0, 'logo file must be non-empty');
  });

  test('hooks.json configures both PreInvocation (hooks/nudge.mjs) and Stop (hooks/sync-turn.mjs) under root named-map structure', () => {
    const hooksPath = path.join(REPO_ROOT, 'hooks.json');
    assert.ok(fs.existsSync(hooksPath), 'hooks.json must exist');

    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(
      hooks && typeof hooks === 'object' && !Array.isArray(hooks),
      'hooks.json root must be a named object map, not an array',
    );
    const groupNames = Object.keys(hooks);
    assert.ok(groupNames.length > 0, 'hooks.json must declare at least one named hook group');

    let referencedNudge = false;
    let referencedSyncTurn = false;
    for (const groupName of groupNames) {
      const group = hooks[groupName];
      assert.ok(
        group && typeof group === 'object' && !Array.isArray(group),
        `hook group "${groupName}" must be an event-name map`,
      );
      for (const [eventName, handlers] of Object.entries(group)) {
        assert.ok(Array.isArray(handlers) && handlers.length > 0, `event "${eventName}" must map to non-empty handler array`);
        for (const handler of handlers) {
          assert.equal(typeof handler.command, 'string');
          if (eventName === 'PreInvocation' && handler.command.includes('hooks/nudge.mjs')) {
            referencedNudge = true;
          }
          if (eventName === 'Stop' && handler.command.includes('hooks/sync-turn.mjs')) {
            referencedSyncTurn = true;
          }
        }
      }
    }

    assert.equal(referencedNudge, true, 'hooks.json must wire PreInvocation to hooks/nudge.mjs');
    assert.equal(referencedSyncTurn, true, 'hooks.json must wire Stop to hooks/sync-turn.mjs');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'hooks', 'nudge.mjs')), 'hooks/nudge.mjs must exist');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'hooks', 'sync-turn.mjs')), 'hooks/sync-turn.mjs must exist');
  });

  test('sidecars/relay/sidecar.json is headless one-shot warmup (has_web_ui: false, restart_policy: never, no ui_config)', () => {
    const sidecarPath = path.join(REPO_ROOT, 'sidecars', 'relay', 'sidecar.json');
    assert.ok(fs.existsSync(sidecarPath), 'sidecars/relay/sidecar.json must exist');

    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(sidecar.has_web_ui, false, 'sidecar.json must set has_web_ui: false');
    assert.equal(sidecar.restart_policy, 'never', 'sidecar.json must set restart_policy: never');
    assert.equal(
      Object.prototype.hasOwnProperty.call(sidecar, 'ui_config'),
      false,
      'headless sidecar.json must not contain ui_config',
    );
  });

  test('skills/fork/SKILL.md is sole active slash command, while skills/relay and skills/context-relay both set disable-slash-command: true', () => {
    const forkSkillPath = path.join(REPO_ROOT, 'skills', 'fork', 'SKILL.md');
    assert.ok(fs.existsSync(forkSkillPath), 'skills/fork/SKILL.md must exist');

    const forkContent = fs.readFileSync(forkSkillPath, 'utf8');
    const forkFm = forkContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(forkFm, 'skills/fork/SKILL.md must begin with valid YAML frontmatter');
    assert.match(forkFm[1], /^name:\s*fork\s*$/m, 'skills/fork/SKILL.md must declare name: fork');
    assert.match(forkFm[1], /^description:\s*\S+/m, 'skills/fork/SKILL.md must include non-empty description');
    assert.doesNotMatch(
      forkFm[1],
      /^disable-slash-command:\s*true\s*$/m,
      'primary skills/fork/SKILL.md must NOT disable its slash command',
    );

    const relaySkillPath = path.join(REPO_ROOT, 'skills', 'relay', 'SKILL.md');
    assert.ok(fs.existsSync(relaySkillPath), 'skills/relay/SKILL.md must exist');

    const relayContent = fs.readFileSync(relaySkillPath, 'utf8');
    const relayFm = relayContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(relayFm, 'skills/relay/SKILL.md must begin with valid YAML frontmatter');
    assert.match(relayFm[1], /^name:\s*relay\s*$/m, 'skills/relay/SKILL.md must declare name: relay');
    assert.match(
      relayFm[1],
      /^disable-slash-command:\s*true\s*$/m,
      'alias skills/relay/SKILL.md must set disable-slash-command: true',
    );

    const legacySkillPath = path.join(REPO_ROOT, 'skills', 'context-relay', 'SKILL.md');
    assert.ok(fs.existsSync(legacySkillPath), 'skills/context-relay/SKILL.md must exist');

    const legacyContent = fs.readFileSync(legacySkillPath, 'utf8');
    const legacyFm = legacyContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(legacyFm, 'skills/context-relay/SKILL.md must begin with valid YAML frontmatter');
    assert.match(
      legacyFm[1],
      /^disable-slash-command:\s*true\s*$/m,
      'legacy skills/context-relay/SKILL.md must set disable-slash-command: true',
    );
  });

  test('assets/savings-benchmark.svg exists and is a well-formed SVG document', () => {
    const svgPath = path.join(REPO_ROOT, 'assets', 'savings-benchmark.svg');
    assert.ok(fs.existsSync(svgPath), 'assets/savings-benchmark.svg must exist');
    const raw = fs.readFileSync(svgPath, 'utf8').trim();
    assert.ok(raw.startsWith('<svg'), 'savings-benchmark.svg must start with <svg');
    assert.ok(raw.endsWith('</svg>'), 'savings-benchmark.svg must end with </svg>');
  });
});

describe('hygiene: repository contains no hardcoded personal directories', () => {
  test('no source, config, or doc file hardcodes personal user or workspace paths', () => {
    const forbiddenPatterns = [
      /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/i,
      /\/Users\/(?!dev\b|example\b|user\b)[A-Za-z0-9._-]+/i,
      /\/home\/(?!dev\b|example\b|user\b)[A-Za-z0-9._-]+/i,
    ];
    const textExtensions = new Set([
      '.mjs',
      '.js',
      '.cjs',
      '.json',
      '.md',
      '.html',
      '.css',
      '.svg',
      '.txt',
      '.yml',
      '.yaml',
    ]);

    const files = walkFiles(REPO_ROOT);
    assert.ok(files.length > 0, 'repository should contain files to scan');

    const violations = [];
    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      if (!textExtensions.has(ext)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      for (const re of forbiddenPatterns) {
        if (re.test(content)) {
          violations.push({
            file: path.relative(REPO_ROOT, filePath),
            pattern: re.source,
          });
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found hardcoded personal paths in repository: ${JSON.stringify(violations, null, 2)}`,
    );
  });
});

describe('hooks/nudge.mjs end-to-end 0-token watermark tests', () => {
  test('returns {} for disabled/empty/malformed/__proto__/low-watermark/subagent, emits 0-token Tier 1 & Tier 2 (/fork & /compact) once each, and silences repeats', () => {
    const nudgePath = path.join(REPO_ROOT, 'hooks', 'nudge.mjs');
    const sandbox = createTempDir('context-relay-nudge-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const lowConvId = 'conv-nudge-low-001';
    const highConvId = 'conv-nudge-high-002';
    const subagentConvId = 'conv-nudge-subagent-003';
    const indexPath = path.join(dataDir, 'index.json');

    const writeIndex = (highPeak, highNoise) => {
      fs.writeFileSync(
        indexPath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: '2026-11-24T15:00:00.000Z',
            sessions: {
              [lowConvId]: {
                sessionId: lowConvId,
                peakContextTokens: 50_000,
                noiseTokens: 2_000,
                turnCount: 3,
                isSubagent: false,
              },
              [highConvId]: {
                sessionId: highConvId,
                peakContextTokens: highPeak,
                noiseTokens: highNoise,
                turnCount: 5,
                isSubagent: false,
              },
              [subagentConvId]: {
                sessionId: subagentConvId,
                peakContextTokens: 220_000,
                noiseTokens: 55_000,
                turnCount: 10,
                isSubagent: true,
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
    };

    writeIndex(152_000, 35_000);

    const runNudge = (input, extraEnv = {}) =>
      spawnSync(process.execPath, [nudgePath], {
        cwd: REPO_ROOT,
        input,
        encoding: 'utf8',
        env: makeIsolatedCliEnv(sandbox, brainDir, dataDir, extraEnv),
        windowsHide: true,
      });

    // 1. Disabled via CONTEXT_RELAY_NUDGE=0 (even on high watermark session)
    const disabledRes = runNudge(JSON.stringify({ conversationId: highConvId }), {
      CONTEXT_RELAY_NUDGE: '0',
    });
    assert.equal(disabledRes.status, 0);
    assert.equal(disabledRes.stdout, '{}\n');

    // 2. Empty stdin, malformed JSON, __proto__, low watermark (50k), and high-watermark subagent (220k, isSubagent: true)
    for (const payload of [
      '',
      '{malformed-json',
      JSON.stringify({ conversationId: '__proto__' }),
      JSON.stringify({ conversationId: lowConvId }),
      JSON.stringify({ conversationId: subagentConvId }),
    ]) {
      const res = runNudge(payload);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '{}\n', `expected silent {} for payload: ${payload}`);
    }

    // 3. Tier 1 first trigger (152k / 35k noise) -> 0-token systemMessage === '' + /fork & /compact user_markdown
    const tier1First = runNudge(JSON.stringify({ conversationId: highConvId }));
    assert.equal(tier1First.status, 0);
    const tier1Json = JSON.parse(tier1First.stdout);
    assert.ok(Array.isArray(tier1Json.injectSteps) && tier1Json.injectSteps.length === 1);
    assert.equal(
      tier1Json.injectSteps[0]?.systemMessage?.systemMessage,
      '',
      'PreInvocation nudge must inject empty systemMessage (0 LLM tokens)',
    );
    const tier1Md = tier1Json.injectSteps[0]?.systemMessage?.metadata?.user_markdown;
    assert.equal(typeof tier1Md, 'string');
    assert.ok(
      tier1Md.length > 0 &&
        tier1Md.includes('152k') &&
        tier1Md.includes('35k') &&
        tier1Md.includes('/fork') &&
        tier1Md.includes('/compact'),
      `expected Tier 1 nudge to include 152k, 35k, /fork, and /compact, got: ${tier1Md}`,
    );

    // 4. Same Tier 1 second invocation must stay silent (anti-spam deduplication)
    const tier1Repeat = runNudge(JSON.stringify({ conversationId: highConvId }));
    assert.equal(tier1Repeat.status, 0);
    assert.equal(tier1Repeat.stdout, '{}\n', 'repeated Tier 1 nudge must stay silent');

    // 5. Escalate watermark to 215k -> Tier 2 trigger once, then silent on repeat
    writeIndex(215_000, 42_000);

    const tier2First = runNudge(JSON.stringify({ conversationId: highConvId }));
    assert.equal(tier2First.status, 0);
    const tier2Json = JSON.parse(tier2First.stdout);
    assert.ok(Array.isArray(tier2Json.injectSteps) && tier2Json.injectSteps.length === 1);
    assert.equal(tier2Json.injectSteps[0]?.systemMessage?.systemMessage, '');
    const tier2Md = tier2Json.injectSteps[0]?.systemMessage?.metadata?.user_markdown;
    assert.equal(typeof tier2Md, 'string');
    assert.ok(
      tier2Md.length > 0 &&
        tier2Md.includes('215k') &&
        tier2Md.includes('高水位预警') &&
        tier2Md.includes('/fork') &&
        tier2Md.includes('/compact'),
      `expected Tier 2 nudge to include 215k, 高水位预警, /fork, and /compact, got: ${tier2Md}`,
    );

    const tier2Repeat = runNudge(JSON.stringify({ conversationId: highConvId }));
    assert.equal(tier2Repeat.status, 0);
    assert.equal(tier2Repeat.stdout, '{}\n', 'repeated Tier 2 nudge must stay silent');
  });
});

describe('hooks/sync-turn.mjs end-to-end tests', () => {
  test('always exits 0 with strict "{}\\n" stdout for empty stdin, malformed JSON, __proto__ conversationId, and valid synthetic transcript', () => {
    const hookPath = path.join(REPO_ROOT, 'hooks', 'sync-turn.mjs');
    const sandbox = createTempDir('context-relay-hook-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    const convId = 'conv-hook-sync-001';
    const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-24T13:00:00.000Z',
          content: '<USER_REQUEST>验证 Stop hook 增量同步落盘</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-24T13:00:04.000Z',
          model: 'gemini-2.5-pro',
          input_tokens: 2000,
          output_tokens: 100,
          content: '同步测试响应。',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const hookEnv = makeIsolatedCliEnv(sandbox, brainDir, dataDir);

    const runHook = (input) =>
      spawnSync(process.execPath, [hookPath], {
        cwd: REPO_ROOT,
        input,
        encoding: 'utf8',
        env: hookEnv,
        windowsHide: true,
      });

    const emptyRes = runHook('');
    assert.equal(emptyRes.status, 0);
    assert.equal(emptyRes.stdout, '{}\n');

    const badJsonRes = runHook('{invalid json');
    assert.equal(badJsonRes.status, 0);
    assert.equal(badJsonRes.stdout, '{}\n');

    const protoRes = runHook(JSON.stringify({ conversationId: '__proto__', transcriptPath }));
    assert.equal(protoRes.status, 0);
    assert.equal(protoRes.stdout, '{}\n');

    const okRes = runHook(JSON.stringify({ conversationId: convId, transcriptPath }));
    assert.equal(okRes.status, 0);
    assert.equal(okRes.stdout, '{}\n');

    const indexPath = path.join(dataDir, 'index.json');
    assert.ok(fs.existsSync(indexPath), 'valid hook invocation must persist dataDir/index.json');
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.ok(idx.sessions[convId], `index.json must contain synced session ${convId}`);
    assert.equal(Object.prototype.hasOwnProperty.call(idx.sessions, '__proto__'), false);
  });
});

describe('sidecars/relay/main.mjs headless warmup smoke test', () => {
  test('completes isolated headless warmup and exits 0 promptly without hanging', () => {
    const warmupPath = path.join(REPO_ROOT, 'sidecars', 'relay', 'main.mjs');
    assert.ok(fs.existsSync(warmupPath), 'sidecars/relay/main.mjs must exist');

    const sandbox = createTempDir('context-relay-warmup-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    const convId = 'conv-warmup-smoke-001';
    const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-24T15:10:00.000Z',
          content: '<USER_REQUEST>无头预热冒烟测试</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-24T15:10:03.000Z',
          model: 'gemini-2.5-pro',
          input_tokens: 4000,
          output_tokens: 150,
          content: '预热索引记录生成成功。',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const t0 = performance.now();
    const res = spawnSync(process.execPath, [warmupPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 8000,
      env: makeIsolatedCliEnv(sandbox, brainDir, dataDir),
      windowsHide: true,
    });
    const elapsedMs = performance.now() - t0;

    assert.equal(res.signal, null, 'headless warmup must exit naturally, not time out or be killed');
    assert.equal(res.status, 0, `headless warmup exited with ${res.status}, stderr: ${res.stderr}`);
    assert.ok(elapsedMs < 8000, `headless warmup took too long: ${elapsedMs.toFixed(1)}ms`);
    assert.ok(res.stdout.includes('headless warmup done'), `expected warmup receipt, got: ${res.stdout}`);

    const indexPath = path.join(dataDir, 'index.json');
    assert.ok(fs.existsSync(indexPath), 'headless warmup must persist index.json in isolated dataDir');
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.ok(idx.sessions[convId], 'headless warmup must index synthetic conversation');
  });
});

describe('core/git-anchor.mjs unit tests', () => {
  test('collectGitAnchor and collectGitAnchorAsync handle real temp git repo (unborn HEAD, Chinese filename, dirty files) and gracefully return isGitRepo: false for non-git dir', async () => {
    const sandbox = createTempDir('context-relay-git-anchor-');
    const repoDir = path.join(sandbox, 'repo');
    const nonGitDir = path.join(sandbox, 'plain-dir');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(nonGitDir, { recursive: true });

    execFileSync('git', ['init'], {
      cwd: repoDir,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    fs.writeFileSync(path.join(repoDir, '中文说明.txt'), '中文内容测试\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'staged.txt'), 'initial staged content\n', 'utf8');
    execFileSync('git', ['add', 'staged.txt'], {
      cwd: repoDir,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.writeFileSync(path.join(repoDir, 'staged.txt'), 'modified after staging\n', 'utf8');

    const syncAnchor = collectGitAnchor(repoDir, { includeDiffSnippet: true });
    assert.equal(syncAnchor.isGitRepo, true);
    assert.equal(syncAnchor.headSha, '', 'unborn HEAD must gracefully yield empty headSha');
    assert.ok(syncAnchor.branch.length > 0, 'unborn HEAD must still resolve symbolic branch name');
    assert.ok(syncAnchor.dirtyCount >= 1, `expected dirtyCount >= 1, got ${syncAnchor.dirtyCount}`);
    assert.ok(syncAnchor.untrackedCount >= 1, `expected untrackedCount >= 1, got ${syncAnchor.untrackedCount}`);
    assert.ok(
      syncAnchor.statusShort.includes('中文说明.txt'),
      `core.quotepath=false must keep CJK filename unescaped, got: ${syncAnchor.statusShort}`,
    );

    const asyncAnchor = await collectGitAnchorAsync(repoDir, { includeDiffSnippet: true });
    assert.equal(asyncAnchor.isGitRepo, true);
    assert.equal(asyncAnchor.branch, syncAnchor.branch);
    assert.equal(asyncAnchor.dirtyCount, syncAnchor.dirtyCount);
    assert.equal(asyncAnchor.untrackedCount, syncAnchor.untrackedCount);
    assert.ok(asyncAnchor.statusShort.includes('中文说明.txt'));

    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = sandbox;
    try {
      const nonGitSync = collectGitAnchor(nonGitDir);
      assert.equal(nonGitSync.isGitRepo, false);
      assert.equal(nonGitSync.dirtyCount, 0);

      const nonGitAsync = await collectGitAnchorAsync(nonGitDir);
      assert.equal(nonGitAsync.isGitRepo, false);
      assert.equal(nonGitAsync.dirtyCount, 0);
    } finally {
      if (prevCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
      }
    }
  });
});

describe('core/agentapi.mjs unit tests (incl. extractBinaryFromShim)', () => {
  test('extractBinaryFromShim parses valid Windows/POSIX shims and rejects unsafe scripts & shell metacharacters', () => {
    // Windows valid agentapi.bat shim with quoted .exe
    const validWinShim = [
      '@echo off',
      'REM Antigravity shim wrapper',
      'call "C:\\Program Files\\Antigravity\\resources\\bin\\language_server_windows_x64.exe" agentapi %*',
    ].join('\r\n');
    assert.equal(
      extractBinaryFromShim(validWinShim, 'win32'),
      'C:\\Program Files\\Antigravity\\resources\\bin\\language_server_windows_x64.exe',
    );

    // Windows negative controls: .bat / .cmd and shell metacharacters
    const badWinShims = [
      '@echo off\r\ncall "C:\\tools\\nested.bat" agentapi %*',
      '@echo off\r\n"C:\\tools\\wrapper.cmd" agentapi %*',
      '@echo off\r\n"C:\\bin\\evil&calc.exe" agentapi %*',
      '@echo off\r\n"C:\\bin\\evil|pipe.exe" agentapi %*',
      '@echo off\r\n"C:\\bin\\%TEMP%\\server.exe" agentapi %*',
      '@echo off\r\n"C:\\bin\\bad;cmd.exe" agentapi %*',
    ];
    for (const bad of badWinShims) {
      assert.equal(extractBinaryFromShim(bad, 'win32'), '', `unsafe Windows shim must be rejected: ${bad}`);
    }

    // macOS / Linux valid POSIX shim
    const validMacShim = [
      '#!/bin/sh',
      '# generated by Antigravity',
      'exec "/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm64" agentapi "$@"',
    ].join('\n');
    assert.equal(
      extractBinaryFromShim(validMacShim, 'darwin'),
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm64',
    );

    const validLinuxShim = '#!/usr/bin/env bash\nexec "/opt/antigravity/bin/language_server_linux_x64" agentapi "$@"\n';
    assert.equal(
      extractBinaryFromShim(validLinuxShim, 'linux'),
      '/opt/antigravity/bin/language_server_linux_x64',
    );

    // POSIX negative controls: $ variable/command substitution & shell metacharacters
    const badPosixShims = [
      '#!/bin/sh\nexec "/opt/$EVIL/language_server" agentapi "$@"',
      '#!/bin/sh\nexec "$(whoami)/language_server" agentapi "$@"',
      '#!/bin/sh\nexec "/opt/`id`/language_server" agentapi "$@"',
      '#!/bin/sh\nexec "/opt/bin/server;rm" agentapi "$@"',
      '#!/bin/sh\nexec "/opt/bin/wrapper.sh.bat" agentapi "$@"',
    ];
    for (const bad of badPosixShims) {
      assert.equal(extractBinaryFromShim(bad, 'linux'), '', `unsafe POSIX shim must be rejected: ${bad}`);
      assert.equal(extractBinaryFromShim(bad, 'darwin'), '', `unsafe macOS shim must be rejected: ${bad}`);
    }
  });

  test('rejects .bat/.cmd scripts, invalid convIds, NUL args, truncates long titles <= 256, and parses camelCase & snake_case metadata', () => {
    const batRes = resolveAgentApiExecutable({
      env: { ANTIGRAVITY_AGENTAPI_EXE: 'C:\\tools\\wrapper.bat' },
      existsSync: (p) => String(p).endsWith('.bat'),
    });
    assert.equal(batRes.available, false, '.bat wrapper must be rejected');

    const cmdRes = resolveAgentApiExecutable({
      env: { ANTIGRAVITY_AGENTAPI_EXE: 'C:\\tools\\wrapper.cmd' },
      existsSync: (p) => String(p).endsWith('.cmd'),
    });
    assert.equal(cmdRes.available, false, '.cmd wrapper must be rejected');

    let capturedArgs = null;
    const client = createAgentApiClient({
      file: '/mock/antigravity.exe',
      existsSync: () => true,
      execFileSync: (_file, args) => {
        capturedArgs = args;
        return JSON.stringify({ conversationId: 'conv-valid-12345678' });
      },
    });

    for (const badId of ['../escape', 'short', 'validid\0evil', 'bad id space']) {
      const metaRes = client.getConversationMetadata(badId);
      assert.equal(metaRes.ok, false, `invalid convId must be rejected: ${JSON.stringify(badId)}`);
    }

    assert.equal(client.startNewConversation({ prompt: 'hello\0world' }).ok, false);
    assert.equal(client.startNewConversation({ prompt: 'ok', title: 'bad\0title' }).ok, false);
    assert.equal(client.startNewConversation({ prompt: 'ok', projectId: 'proj\0bad' }).ok, false);

    const hugeTitle = `Header\r\nLine2\n${'X'.repeat(400)}`;
    const startRes = client.startNewConversation({
      prompt: 'continue task',
      title: hugeTitle,
    });
    assert.equal(startRes.ok, true);
    assert.equal(startRes.conversationId, 'conv-valid-12345678');
    const titleFlag = capturedArgs.find((arg) => arg.startsWith('--title='));
    assert.ok(titleFlag, 'expected --title=... flag in agentapi args');
    const cleanTitle = titleFlag.slice('--title='.length);
    assert.ok(cleanTitle.length > 0 && cleanTitle.length <= 256, `sanitized title must be <= 256 chars, got ${cleanTitle.length}`);
    assert.ok(!/[\r\n]/.test(cleanTitle), 'sanitized title must not contain CR/LF');

    const camelMeta = parseMetadataPayload({
      response: {
        conversationMetadata: {
          metadata: {
            projectId: 'proj-camel-01',
            workspaces: [
              {
                workspaceFolderAbsoluteUri: 'file:///e%3A/demo/camel-app',
                gitRootAbsoluteUri: 'file:///e%3A/demo/camel-app',
                branchName: 'feat/camel',
              },
            ],
            parentConversationId: 'parent-camel-99',
            nestingDepth: 2,
          },
        },
      },
    });
    assert.equal(camelMeta.projectId, 'proj-camel-01');
    assert.ok(camelMeta.primaryPath.toLowerCase().includes('camel-app'));
    assert.equal(camelMeta.branchName, 'feat/camel');
    assert.equal(camelMeta.parentConversationId, 'parent-camel-99');
    assert.equal(camelMeta.nestingDepth, 2);

    const snakeMeta = parseMetadataPayload({
      response: {
        conversation_metadata: {
          metadata: {
            project_id: 'proj-snake-02',
            workspaces: [
              {
                workspace_folder_absolute_uri: 'file:///Users/dev/snake-app',
                git_root_absolute_uri: 'file:///Users/dev/snake-app',
                branch_name: 'fix/snake',
              },
            ],
            parent_conversation_id: 'parent-snake-88',
            nesting_depth: 1,
          },
        },
      },
    });
    assert.equal(snakeMeta.projectId, 'proj-snake-02');
    assert.equal(snakeMeta.primaryPath.replace(/\\/g, '/'), '/Users/dev/snake-app');
    assert.equal(snakeMeta.branchName, 'fix/snake');
    assert.equal(snakeMeta.parentConversationId, 'parent-snake-88');
    assert.equal(snakeMeta.nestingDepth, 1);
  });
});

describe('CLI relay subcommand end-to-end tests: bin/context-relay.mjs relay', () => {
  const cliPath = path.join(REPO_ROOT, 'bin', 'context-relay.mjs');

  test('relay --plan / --to (exact, ambiguous, not_found) / --go --export-only (redacted) / error & missing-value guards', () => {
    const sandbox = createTempDir('context-relay-cli-relay-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    const convId = 'conv-relay-cli-001';
    const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const secretApiKey = 'real_secret_value_55443322';
    const secretGhp = 'ghp' + '_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-24T15:20:00.000Z',
          content: '<USER_REQUEST>重构支付网关并准备跨项目接力</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-24T15:20:06.000Z',
          model: 'gemini-2.5-pro',
          input_tokens: 68_000,
          cache_read_tokens: 12_000,
          output_tokens: 420,
          content: `已完成支付网关核心重构，调试密钥 API_KEY=${secretApiKey} 与 ${secretGhp} 必须脱敏。`,
          tool_calls: [
            { name: 'edit_file', arguments: { Path: 'E:/demo/alpha-service/src/pay.mjs' } },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'SYSTEM',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-11-24T15:20:08.000Z',
          content: 'Edited pay.mjs successfully.',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    // Pre-populate known projects.json so --to can verify exact, ambiguous, and not_found
    fs.writeFileSync(
      path.join(dataDir, 'projects.json'),
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-11-24T15:20:10.000Z',
          projects: {
            'proj-alpha': {
              projectId: 'proj-alpha',
              displayName: 'alpha-service',
              primaryPath: 'E:/demo/alpha-service',
              workspaceUris: ['file:///e%3A/demo/alpha-service'],
              lastSeenAt: '2026-11-24T15:20:10.000Z',
            },
            'proj-beta-web': {
              projectId: 'proj-beta-web',
              displayName: 'beta-web',
              primaryPath: 'E:/demo/beta-web',
              workspaceUris: ['file:///e%3A/demo/beta-web'],
              lastSeenAt: '2026-11-24T15:19:00.000Z',
            },
            'proj-beta-api': {
              projectId: 'proj-beta-api',
              displayName: 'beta-api',
              primaryPath: 'E:/demo/beta-api',
              workspaceUris: ['file:///e%3A/demo/beta-api'],
              lastSeenAt: '2026-11-24T15:18:00.000Z',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const cliEnv = makeIsolatedCliEnv(sandbox, brainDir, dataDir);
    const runRelay = (args) =>
      spawnSync(process.execPath, [cliPath, 'relay', ...args, '--data-dir', dataDir], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: cliEnv,
        windowsHide: true,
      });

    // 1. relay --plan --json
    const planRes = runRelay(['--session', convId, '--plan', '--no-git', '--json']);
    assert.equal(planRes.status, 0, `relay --plan failed: ${planRes.stderr || planRes.stdout}`);
    const planJson = JSON.parse(planRes.stdout);
    assert.equal(planJson.ok, true);
    assert.equal(planJson.mode, 'plan');
    assert.equal(planJson.plan.originalPeakTokens, 80_000);
    assert.ok(planJson.plan.handoffEstimatedTokens > 0);
    assert.ok(planJson.plan.savedPercent > 0 && planJson.plan.savedPercent <= 99);
    assert.equal(planJson.projects.length, 3);
    assert.ok(Array.isArray(planJson.otherProjects));

    // 2. relay --plan --to <keyword> --json: exact / ambiguous / not_found
    const exactRes = runRelay(['--session', convId, '--plan', '--to', 'alpha-service', '--no-git', '--json']);
    assert.equal(exactRes.status, 0);
    const exactJson = JSON.parse(exactRes.stdout);
    assert.equal(exactJson.targetMatch.status, 'exact');
    assert.equal(exactJson.targetMatch.matched.projectId, 'proj-alpha');

    const ambRes = runRelay(['--session', convId, '--plan', '--to', 'beta', '--no-git', '--json']);
    assert.equal(ambRes.status, 0);
    const ambJson = JSON.parse(ambRes.stdout);
    assert.equal(ambJson.targetMatch.status, 'ambiguous');
    assert.equal(ambJson.targetMatch.candidates.length, 2);

    const missRes = runRelay(['--session', convId, '--plan', '--to', 'nonexistent_xyz', '--no-git', '--json']);
    assert.equal(missRes.status, 0);
    const missJson = JSON.parse(missRes.stdout);
    assert.equal(missJson.targetMatch.status, 'not_found');
    assert.equal(missJson.targetMatch.matched, null);

    // 3. relay --go --export-only --json writes redacted handoffs/*.md
    const exportGoRes = runRelay([
      '--session',
      convId,
      '--go',
      '--export-only',
      '--no-git',
      '--note',
      '接力后先跑全量回归',
      '--json',
    ]);
    assert.equal(exportGoRes.status, 0, `relay --go --export-only failed: ${exportGoRes.stderr || exportGoRes.stdout}`);
    const exportGoJson = JSON.parse(exportGoRes.stdout);
    assert.equal(exportGoJson.ok, true);
    assert.equal(exportGoJson.mode, 'export-only');
    assert.ok(exportGoJson.filePath && fs.existsSync(exportGoJson.filePath), 'handoff markdown must be written to disk');
    assert.ok(
      exportGoJson.filePath.replace(/\\/g, '/').includes('/handoffs/') && exportGoJson.filePath.endsWith('.md'),
      `handoff file must be under handoffs/*.md, got: ${exportGoJson.filePath}`,
    );
    assert.ok(exportGoJson.redactionCount >= 2);
    const handoffText = fs.readFileSync(exportGoJson.filePath, 'utf8');
    assert.ok(!handoffText.includes(secretApiKey), 'exported relay handoff must redact API_KEY');
    assert.ok(!handoffText.includes(secretGhp), 'exported relay handoff must redact ghp_ token');
    assert.ok(handoffText.includes('[REDACTED:'), 'exported relay handoff must contain [REDACTED:...] markers');
    assert.ok(handoffText.includes('接力后先跑全量回归'));

    // 4. relay --go --to nonexistent_xyz --json exits non-zero
    const badTargetGoRes = runRelay(['--session', convId, '--go', '--to', 'nonexistent_xyz', '--no-git', '--json']);
    assert.notEqual(badTargetGoRes.status, 0, 'relay --go with unmatched --to must exit non-zero');
    const badTargetGoJson = JSON.parse(badTargetGoRes.stdout);
    assert.equal(badTargetGoJson.ok, false);
    assert.equal(badTargetGoJson.targetMatch.status, 'not_found');

    // 5. Missing values for --to / --until / --note must fail with non-zero exit
    for (const missingFlag of ['--to', '--until', '--note']) {
      const res = spawnSync(process.execPath, [cliPath, 'relay', '--plan', missingFlag], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: cliEnv,
        windowsHide: true,
      });
      assert.notEqual(res.status, 0, `relay ${missingFlag} without value must exit non-zero`);
    }
  });
});

describe('formatForkTitle & CLI stats --svg / --demo tests', () => {
  const cliPath = path.join(REPO_ROOT, 'bin', 'context-relay.mjs');

  test('formatForkTitle increments (fork) / (fork #N), strips [Relay], and preserves suffix on long truncation', () => {
    assert.equal(formatForkTitle('Auth middleware refactor'), 'Auth middleware refactor (fork)');
    assert.equal(formatForkTitle('Auth middleware refactor (fork)'), 'Auth middleware refactor (fork #2)');
    assert.equal(formatForkTitle('Auth middleware refactor (fork #2)'), 'Auth middleware refactor (fork #3)');
    assert.equal(formatForkTitle('[Relay] foo'), 'foo (fork)');
    assert.equal(formatForkTitle('[Relay] [Relay] bar (fork)'), 'bar (fork #2)');
    assert.equal(formatForkTitle(''), 'Untitled (fork)');

    const longBase = 'A'.repeat(240);
    const longFork = formatForkTitle(longBase);
    assert.ok(longFork.length <= 180, `long fork title must be <= 180 chars, got ${longFork.length}`);
    assert.ok(longFork.endsWith(' (fork)'), `long fork title must preserve " (fork)" suffix: ${longFork}`);

    const longNumbered = formatForkTitle(`${'B'.repeat(240)} (fork #2)`);
    assert.ok(longNumbered.length <= 180, `long numbered title must be <= 180 chars, got ${longNumbered.length}`);
    assert.ok(longNumbered.endsWith(' (fork #3)'), `long numbered title must preserve " (fork #3)" suffix: ${longNumbered}`);
  });

  test('stats --svg escapes XML & scrubs secrets, stats --demo --svg writes valid SVG, and missing --svg value exits non-zero', () => {
    const sandbox = createTempDir('context-relay-stats-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const secretGhp = 'ghp' + '_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    fs.writeFileSync(
      path.join(dataDir, 'lineage.json'),
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-11-24T16:10:00.000Z',
          records: [
            {
              id: 'lin-xml-1',
              createdAt: '2026-11-24T16:10:00.000Z',
              sourceTitle: 'Fix <script>&"tag"',
              targetTitle: 'Fix <script>&"tag" (fork)',
              targetSessionId: 'conv-stat-001',
              originalPeakTokens: 180_000,
              handoffEstimatedTokens: 6_000,
              redactionCount: 1,
            },
            {
              id: 'lin-secret-2',
              createdAt: '2026-11-24T16:05:00.000Z',
              sourceTitle: `${secretGhp} auth fix`,
              targetTitle: `${secretGhp} auth fix (fork)`,
              targetSessionId: 'conv-stat-002',
              originalPeakTokens: 120_000,
              handoffEstimatedTokens: 6_000,
              redactionCount: 2,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const cliEnv = makeIsolatedCliEnv(sandbox, brainDir, dataDir);

    // 1. stats --svg <tmp> with real isolated lineage (XML escaping + secret redaction)
    const realSvgPath = path.join(sandbox, 'out', 'real-stats.svg');
    const realRes = spawnSync(
      process.execPath,
      [cliPath, 'stats', '--svg', realSvgPath, '--data-dir', dataDir, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8', env: cliEnv, windowsHide: true },
    );
    assert.equal(realRes.status, 0, `stats --svg failed: ${realRes.stderr || realRes.stdout}`);
    const realJson = JSON.parse(realRes.stdout);
    assert.equal(realJson.ok, true);
    assert.equal(realJson.demo, false);
    assert.equal(realJson.relayCount, 2);
    assert.equal(realJson.totalSavedTokens, 288_000);
    assert.equal(realJson.svgPath, path.resolve(realSvgPath));
    assert.ok(fs.existsSync(realSvgPath), 'stats --svg must create target SVG file');

    const realSvg = fs.readFileSync(realSvgPath, 'utf8').trim();
    assert.ok(realSvg.includes('<svg') && realSvg.endsWith('</svg>'), 'real stats output must be valid SVG markup');
    assert.ok(!realSvg.includes('<script>'), 'SVG output must XML-escape raw <script> tags');
    assert.ok(realSvg.includes('&lt;script&gt;') && realSvg.includes('&amp;'), 'SVG output must emit &lt;script&gt; and &amp;');
    assert.ok(!realSvg.includes(secretGhp), 'SVG output must scrub plaintext ghp_ token from titles');
    assert.ok(realSvg.includes('[REDACTED:GITHUB_TOKEN]'), 'SVG output must visibly show [REDACTED:GITHUB_TOKEN] marker');

    // 2. stats --demo --svg <tmp>
    const demoSvgPath = path.join(sandbox, 'out', 'demo-stats.svg');
    const demoRes = spawnSync(
      process.execPath,
      [cliPath, 'stats', '--demo', '--svg', demoSvgPath, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8', env: cliEnv, windowsHide: true },
    );
    assert.equal(demoRes.status, 0, `stats --demo --svg failed: ${demoRes.stderr || demoRes.stdout}`);
    const demoJson = JSON.parse(demoRes.stdout);
    assert.equal(demoJson.ok, true);
    assert.equal(demoJson.demo, true);
    assert.equal(demoJson.relayCount, 3);
    assert.ok(fs.existsSync(demoSvgPath), 'stats --demo --svg must write SVG file');
    const demoSvg = fs.readFileSync(demoSvgPath, 'utf8').trim();
    assert.ok(demoSvg.includes('<svg') && demoSvg.endsWith('</svg>') && demoSvg.includes('DEMO'));

    // 3. stats --svg missing value must exit non-zero
    const missingSvgVal = spawnSync(process.execPath, [cliPath, 'stats', '--svg'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: cliEnv,
      windowsHide: true,
    });
    assert.notEqual(missingSvgVal.status, 0, 'stats --svg without value must exit non-zero');
  });
});

describe('CLI installer & boundary tests: bin/context-relay.mjs', () => {
  const cliPath = path.join(REPO_ROOT, 'bin', 'context-relay.mjs');

  test('supports --dry-run without writing plugin files, then real install writes files + .local-config.json with zero symlinks', () => {
    assert.ok(fs.existsSync(cliPath), 'bin/context-relay.mjs must exist');

    const dryTarget = path.join(createTempDir('context-relay-dryrun-'), 'context-relay-plugin');
    const dryDataDir = path.join(createTempDir('context-relay-drydata-'), 'data');
    const dryOut = execFileSync(
      process.execPath,
      [cliPath, 'install', 'antigravity', '--dry-run', '--target', dryTarget, '--data-dir', dryDataDir],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(typeof dryOut, 'string');
    assert.equal(
      fs.existsSync(path.join(dryTarget, 'plugin.json')),
      false,
      '--dry-run must not copy plugin.json into target directory',
    );
    assert.equal(
      fs.existsSync(path.join(dryTarget, '.local-config.json')),
      false,
      '--dry-run must not write .local-config.json into target directory',
    );

    const realTarget = path.join(createTempDir('context-relay-install-'), 'context-relay-plugin');
    const realDataDir = path.join(createTempDir('context-relay-realdata-'), 'data');
    const installOut = execFileSync(
      process.execPath,
      [cliPath, 'install', 'antigravity', '--target', realTarget, '--data-dir', realDataDir],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(typeof installOut, 'string');

    assert.ok(fs.existsSync(path.join(realTarget, 'plugin.json')), 'installed target must contain plugin.json');
    assert.ok(fs.existsSync(path.join(realTarget, 'hooks.json')), 'installed target must contain hooks.json');
    assert.ok(
      fs.existsSync(path.join(realTarget, 'sidecars', 'relay', 'sidecar.json')),
      'installed target must contain sidecars/relay/sidecar.json',
    );
    assert.ok(
      fs.existsSync(path.join(realTarget, 'hooks', 'nudge.mjs')),
      'installed target must contain hooks/nudge.mjs',
    );
    assert.ok(
      fs.existsSync(path.join(realTarget, 'skills', 'fork', 'SKILL.md')),
      'installed target must contain skills/fork/SKILL.md',
    );
    assert.ok(
      fs.existsSync(path.join(realTarget, 'skills', 'relay', 'SKILL.md')),
      'installed target must contain skills/relay/SKILL.md',
    );
    assert.ok(
      fs.existsSync(path.join(realTarget, 'assets', 'savings-benchmark.svg')),
      'installed target must contain assets/savings-benchmark.svg',
    );

    const localConfigPath = path.join(realTarget, '.local-config.json');
    assert.ok(fs.existsSync(localConfigPath), 'real install with --data-dir must write .local-config.json');
    const localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
    assert.ok(localConfig && typeof localConfig === 'object', '.local-config.json must be valid JSON object');
    assert.equal(localConfig.dataDir, path.resolve(realDataDir));

    const checkedEntries = assertNoSymlinksRecursive(realTarget);
    assert.ok(checkedEntries >= 5, `expected multiple copied files checked for symlinks, got ${checkedEntries}`);
  });

  test('CLI boundary rejections (missing --port, ancestor install target, unrelated non-empty target) and search/inspect/export smoke tests', () => {
    const missingPortRes = spawnSync(process.execPath, [cliPath, 'serve', '--port'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(missingPortRes.status, 0, 'serve --port without value must exit non-zero');

    const ancestorRes = spawnSync(
      process.execPath,
      [cliPath, 'install', 'antigravity', '--dry-run', '--target', path.dirname(REPO_ROOT)],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.notEqual(ancestorRes.status, 0, 'installing into ancestor directory of repo must exit non-zero');

    const unrelatedDir = createTempDir('context-relay-unrelated-');
    fs.writeFileSync(path.join(unrelatedDir, 'other-project.txt'), 'do not clobber\n', 'utf8');
    const unrelatedRes = spawnSync(
      process.execPath,
      [cliPath, 'install', 'antigravity', '--dry-run', '--target', unrelatedDir],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.notEqual(
      unrelatedRes.status,
      0,
      'installing into unrelated non-empty directory without --force must exit non-zero',
    );

    const sandbox = createTempDir('context-relay-cli-smoke-');
    const brainDir = path.join(sandbox, 'brain');
    const dataDir = path.join(sandbox, 'data');
    const convId = 'conv-cli-smoke-001';
    const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-24T14:00:00.000Z',
          content: '<USER_REQUEST>CLI 冒烟验证 uniqueCliToken8844</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-24T14:00:05.000Z',
          model: 'gemini-2.5-pro',
          input_tokens: 6000,
          output_tokens: 200,
          content: 'CLI 冒烟回复完成，附测试密钥 API_KEY=real_secret_value_123456。',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const cliEnv = makeIsolatedCliEnv(sandbox, brainDir, dataDir);

    const searchRes = spawnSync(
      process.execPath,
      [cliPath, 'search', 'uniqueCliToken8844', '--json', '--data-dir', dataDir],
      { cwd: REPO_ROOT, encoding: 'utf8', env: cliEnv, windowsHide: true },
    );
    assert.equal(searchRes.status, 0, `CLI search failed: ${searchRes.stderr}`);
    const searchJson = JSON.parse(searchRes.stdout);
    assert.equal(searchJson.ok, true);
    assert.equal(searchJson.sessions.length, 1);
    assert.equal(searchJson.sessions[0].sessionId, convId);

    const inspectRes = spawnSync(
      process.execPath,
      [cliPath, 'inspect', convId, '--json', '--data-dir', dataDir],
      { cwd: REPO_ROOT, encoding: 'utf8', env: cliEnv, windowsHide: true },
    );
    assert.equal(inspectRes.status, 0, `CLI inspect failed: ${inspectRes.stderr}`);
    const inspectJson = JSON.parse(inspectRes.stdout);
    assert.equal(inspectJson.ok, true);
    assert.equal(inspectJson.sessionId, convId);
    assert.equal(inspectJson.turns.length, 1);

    const outMd = path.join(sandbox, 'smoke-export.md');
    const exportRes = spawnSync(
      process.execPath,
      [cliPath, 'export', convId, '--preset', 'smart-clean', '--no-git', '--out', outMd, '--json', '--data-dir', dataDir],
      { cwd: REPO_ROOT, encoding: 'utf8', env: cliEnv, windowsHide: true },
    );
    assert.equal(exportRes.status, 0, `CLI export failed: ${exportRes.stderr}`);
    const exportJson = JSON.parse(exportRes.stdout);
    assert.equal(exportJson.ok, true);
    assert.ok(fs.existsSync(outMd), 'CLI export --out must write handoff markdown');
    const exportedText = fs.readFileSync(outMd, 'utf8');
    assert.ok(exportedText.includes('uniqueCliToken8844'));
    assert.ok(!exportedText.includes('real_secret_value_123456'), 'CLI export must redact secrets by default');
  });
});

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { redactSensitive } from '../core/redact.mjs';
import {
  INLINE_LIMIT_BYTES,
  buildHandoffBundle,
  buildLaunchPrompt,
} from '../core/handoff-builder.mjs';

const SYNTHETIC_GHP = 'ghp' + '_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

function makeSyntheticSession(extraAssistantText = '') {
  const secretLine = `API_KEY=real_secret_value_123456 and token ${SYNTHETIC_GHP}`;
  return {
    sessionId: 'conv-handoff-test-001',
    title: 'Fix authentication middleware and add audit logging',
    firstModel: 'gemini-2.5-pro',
    lastModel: 'gemini-2.5-pro',
    modelsUsed: ['gemini-2.5-pro'],
    workspacePath: 'E:/demo/project-alpha',
    peakContextTokens: 48000,
    filesTouched: {
      modified: ['E:/demo/project-alpha/src/auth.mjs', 'E:/demo/project-alpha/test/auth.test.mjs'],
      read: ['E:/demo/project-alpha/src/config.mjs'],
    },
    turns: [
      {
        id: 'turn-1',
        index: 1,
        sourceType: 'USER_INPUT',
        createdAt: '2026-11-24T10:00:00.000Z',
        model: 'gemini-2.5-pro',
        userText: 'Investigate auth middleware and fix token refresh logic',
        assistantText: `Fixed expiry boundary check in src/auth.mjs. Note temporary debug vars ${secretLine}.${extraAssistantText}`,
        deltaContextTokens: 12000,
        estimatedTurnTokens: 320,
        filesModified: ['E:/demo/project-alpha/src/auth.mjs'],
        filesRead: ['E:/demo/project-alpha/src/config.mjs'],
        items: [
          {
            id: 'step-1-c0',
            turnId: 'turn-1',
            turnIndex: 1,
            toolName: 'edit_file',
            category: 'write',
            actionSummary: 'edit_file E:/demo/project-alpha/src/auth.mjs',
            plannerStepIndex: 1,
            resultStepIndex: 2,
            resultBytes: 120,
            resultPreview: 'Edited src/auth.mjs successfully',
            isWrite: true,
            isError: false,
            isNoisy: false,
            defaultInclude: true,
          },
        ],
      },
      {
        id: 'turn-2',
        index: 2,
        sourceType: 'USER_INPUT',
        createdAt: '2026-11-24T10:01:00.000Z',
        model: 'gemini-2.5-pro',
        userText: 'Run full compiler scan and inspect logs',
        assistantText: `Scan log is very long: ${'INFO verbose trace line 0123456789\n'.repeat(180)}`,
        deltaContextTokens: 25000,
        estimatedTurnTokens: 2200,
        filesModified: [],
        filesRead: [],
        items: [
          {
            id: 'step-4-c0',
            turnId: 'turn-2',
            turnIndex: 2,
            toolName: 'run_command',
            category: 'command',
            actionSummary: 'run_command: node scripts/scan.mjs',
            plannerStepIndex: 4,
            resultStepIndex: 5,
            resultBytes: 9000,
            resultPreview: 'INFO verbose trace...',
            isWrite: false,
            isError: false,
            isNoisy: true,
            defaultInclude: false,
          },
        ],
      },
      {
        id: 'turn-3',
        index: 3,
        sourceType: 'USER_INPUT',
        createdAt: '2026-11-24T10:02:00.000Z',
        model: 'gemini-2.5-pro',
        userText: 'Add unit tests and confirm remaining next steps',
        assistantText: 'Added test/auth.test.mjs; remaining work is wiring audit logging into Express routes.',
        deltaContextTokens: 11000,
        estimatedTurnTokens: 180,
        filesModified: ['E:/demo/project-alpha/test/auth.test.mjs'],
        filesRead: [],
        items: [
          {
            id: 'step-7-c0',
            turnId: 'turn-3',
            turnIndex: 3,
            toolName: 'write_file',
            category: 'write',
            actionSummary: 'write_file E:/demo/project-alpha/test/auth.test.mjs',
            plannerStepIndex: 7,
            resultStepIndex: 8,
            resultBytes: 96,
            resultPreview: 'Created test/auth.test.mjs',
            isWrite: true,
            isError: false,
            isNoisy: false,
            defaultInclude: true,
          },
        ],
      },
    ],
  };
}

describe('redactSensitive: positive controls (secrets must be redacted)', () => {
  const cases = [
    {
      name: 'PEM private key block',
      secret: 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC9xK4mN7pQ2rT8',
      input: [
        'Loaded key:',
        ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC9xK4mN7pQ2rT8',
        'vW1yZ5cF3hJ6kL0nP9q8r7s6t5u4v3w2x1y0z9a8b7c6d5e4f3a2b1c0d9e8f7a6',
        ['-----END', 'PRIVATE KEY-----'].join(' '),
        'done.',
      ].join('\n'),
    },
    {
      name: 'Google AIza API key',
      secret: 'AIza' + 'SyB9xK4mN7pQ2rT8vW1yZ5cF3hJ6kL0nP9q',
      input: `GOOGLE_KEY = "${'AIza' + 'SyB9xK4mN7pQ2rT8vW1yZ5cF3hJ6kL0nP9q'}"`,
    },
    {
      name: 'OpenAI sk- key',
      secret: 'sk-proj' + '-9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d',
      input: `using key ${'sk-proj' + '-9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d'} in request`,
    },
    {
      name: 'Anthropic sk-ant- key',
      secret: 'sk-ant' + '-api03-8k9m0n1p2q3r4s5t6u7v8w9x0y1z2a3b4c5d6e7f8g9h',
      input: `client = new Anthropic("${'sk-ant' + '-api03-8k9m0n1p2q3r4s5t6u7v8w9x0y1z2a3b4c5d6e7f8g9h'}")`,
    },
    {
      name: 'GitHub classic ghp_ token',
      secret: SYNTHETIC_GHP,
      input: `git remote url https://${SYNTHETIC_GHP}@github.com/org/repo.git`,
    },
    {
      name: 'GitHub fine-grained github_pat_ token',
      secret: 'github_pat' + '_11ABCDEFG0123456789012_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVw',
      input: `token: ${'github_pat' + '_11ABCDEFG0123456789012_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVw'}`,
    },
    {
      name: 'AWS access key ID AKIA...',
      secret: 'AKIA' + 'Q9X8M7N6P5R4S3T2',
      input: `aws_access_key_id = ${'AKIA' + 'Q9X8M7N6P5R4S3T2'}`,
    },
    {
      name: 'Slack bot token xoxb-...',
      secret: 'xoxb' + '-918273645512-827364551291-kLmNoPqRsTuVwXyZ01234567',
      input: `slack auth ${'xoxb' + '-918273645512-827364551291-kLmNoPqRsTuVwXyZ01234567'}`,
    },
    {
      name: 'Authorization: Bearer header',
      secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ.sIgNaTuRe9876543210abcdef',
      input: `Authorization: Bearer ${'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ.sIgNaTuRe9876543210abcdef'}`,
    },
    {
      name: 'x-codeium-csrf-token header',
      secret: 'f8a9b7c6-d5e4-4321-89ab-cdef01234567',
      input: 'x-codeium-csrf-token: f8a9b7c6-d5e4-4321-89ab-cdef01234567',
    },
    {
      name: 'API_KEY assignment with real secret value',
      secret: 'real_secret_value_123456',
      input: 'API_KEY=real_secret_value_123456',
    },
    // High-frequency red-team regression positive controls
    {
      name: 'JSON lowercase api_key',
      secret: 'real_secret_value_123456',
      input: '{"api_key": "real_secret_value_123456"}',
    },
    {
      name: 'YAML lowercase db_password',
      secret: 'SuperSecretPassword123!',
      input: 'db_password: SuperSecretPassword123!',
    },
    {
      name: 'JS camelCase apiKey assignment',
      secret: 'real_secret_value_123456',
      input: 'const apiKey = "real_secret_value_123456";',
    },
    {
      name: 'AWS_SECRET_ACCESS_KEY env assignment',
      secret: 'wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCYz9876543210',
      input: `AWS_SECRET_ACCESS_KEY=${'wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCYz9876543210'}`,
    },
    {
      name: 'DATABASE_URL postgres credential',
      secret: 'SuperSecret12345',
      input: 'DATABASE_URL=postgres://admin:SuperSecret12345@db.internal:5432/prod',
    },
    {
      name: 'Authorization: Basic header',
      secret: 'dXNlcjpwYXNzMTIzNDU2',
      input: 'Authorization: Basic dXNlcjpwYXNzMTIzNDU2',
    },
    {
      name: 'Standalone JWT token',
      secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiJ1c2VyLTk4NzY1NCIsInJvbGUiOiJhZG1pbiJ9.kLmNoPqRsTuVwXyZ0123456789abcdef',
      input: `token = ${'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiJ1c2VyLTk4NzY1NCIsInJvbGUiOiJhZG1pbiJ9.kLmNoPqRsTuVwXyZ0123456789abcdef'}`,
    },
    {
      name: 'HuggingFace hf_ token',
      secret: 'hf' + '_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456',
      input: `export HF_HUB_TOKEN=${'hf' + '_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456'}`,
    },
    {
      name: 'npm_ access token',
      secret: 'npm' + '_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
      input: `//registry.npmjs.org/:_authToken=${'npm' + '_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'}`,
    },
  ];

  for (const tc of cases) {
    test(`redacts ${tc.name} accurately`, () => {
      const res = redactSensitive(tc.input);
      assert.ok(res && typeof res.text === 'string', 'redactSensitive must return { text, count }');
      assert.equal(res.count, 1, `expected exactly 1 redaction for ${tc.name}, got ${res.count} -> ${res.text}`);
      assert.ok(!res.text.includes(tc.secret), `secret must not remain in output for ${tc.name}`);
      assert.ok(res.text.includes('[REDACTED:'), `expected [REDACTED:...] marker for ${tc.name}`);
      assert.notEqual(res.text, tc.input);
    });
  }

  test('redacts all 20 secret classes in a combined payload with exact aggregate count', () => {
    const combined = cases.map((c) => c.input).join('\n---\n');
    const res = redactSensitive(combined);
    assert.equal(res.count, cases.length, `expected aggregate count ${cases.length}, got ${res.count}`);
    for (const c of cases) {
      assert.ok(!res.text.includes(c.secret), `combined output still leaks ${c.name}`);
    }
  });
});

describe('redactSensitive: negative controls (avoid false positives)', () => {
  test('does not redact normal code identifiers, placeholders, env refs, REDACTED, or URLs', () => {
    const benignSamples = [
      'const apiKeyHeader = "x-request-id";',
      'function verifyAuthToken(userSession, tokenStore) { return tokenStore.has(userSession.id); }',
      'API_KEY=YOUR_API_KEY_HERE',
      'TOKEN=EXAMPLE_TOKEN_12345',
      'const key = process.env.API_KEY;',
      'const apiKey = config.auth.apiKey;',
      'Status: REDACTED by previous pipeline',
      'Visit https://example.com/docs/auth?tab=bearer for details',
    ];

    for (const sample of benignSamples) {
      const res = redactSensitive(sample);
      assert.equal(res.count, 0, `unexpected false-positive redaction on: ${sample} -> ${res.text}`);
      assert.equal(res.text, sample, `benign sample should remain unmodified: ${sample}`);
    }
  });
});

describe('handoff-builder: buildHandoffBundle & buildLaunchPrompt', () => {
  test('buildHandoffBundle respects redact true/false, includes gitAnchor & extraInstruction, computes savedPercent & recommendFileMode', () => {
    const session = makeSyntheticSession();
    const gitAnchor = {
      isGitRepo: true,
      repoRoot: 'E:/demo/project-alpha',
      branch: 'feat/auth-fix',
      headSha: 'a1b2c3d',
      headSubject: 'fix: enforce strict token expiry',
      dirtyCount: 1,
      untrackedCount: 1,
      statusShort: ' M src/auth.mjs\n?? test/auth.test.mjs',
      diffStat: ' src/auth.mjs | 12 ++++++------',
    };
    const extraInstruction = 'Continue wiring audit logging into Express middleware and run all tests.';

    const redactedBundle = buildHandoffBundle(session, {
      selectedTurnIds: ['turn-1', 'turn-3'],
      redact: true,
      gitAnchor,
      extraInstruction,
    });

    assert.equal(typeof redactedBundle.markdown, 'string');
    assert.ok(redactedBundle.markdown.length > 0);
    assert.ok(!redactedBundle.markdown.includes('real_secret_value_123456'), 'redact: true must scrub API_KEY');
    assert.ok(!redactedBundle.markdown.includes(SYNTHETIC_GHP), 'redact: true must scrub ghp_ token');
    assert.equal(redactedBundle.redactionCount, 2);
    assert.ok(redactedBundle.markdown.includes('feat/auth-fix'), 'bundle must include gitAnchor branch');
    assert.ok(redactedBundle.markdown.includes('a1b2c3d'), 'bundle must include gitAnchor headSha');
    assert.ok(redactedBundle.markdown.includes(extraInstruction), 'bundle must include extraInstruction');
    assert.ok(redactedBundle.markdown.includes('Pruned turn 2'), 'bundle must note pruned turn gap');
    assert.equal(redactedBundle.selectedTurnsCount, 2);
    assert.equal(redactedBundle.totalTurnsCount, 3);
    assert.equal(typeof redactedBundle.savedPercent, 'number');
    assert.ok(redactedBundle.savedPercent > 0 && redactedBundle.savedPercent <= 99);
    assert.equal(redactedBundle.recommendFileMode, false, 'short bundle should have recommendFileMode === false');

    // Negative control: redact: false keeps raw secret intact and counts 0 redactions
    const rawBundle = buildHandoffBundle(session, {
      selectedTurnIds: ['turn-1', 'turn-3'],
      redact: false,
      gitAnchor,
      extraInstruction,
    });
    assert.ok(rawBundle.markdown.includes('real_secret_value_123456'), 'redact: false must preserve raw text');
    assert.ok(rawBundle.markdown.includes(SYNTHETIC_GHP));
    assert.equal(rawBundle.redactionCount, 0);

    // Large bundle > INLINE_LIMIT_BYTES recommends file mode
    assert.equal(INLINE_LIMIT_BYTES, 10 * 1024);
    const largeSession = makeSyntheticSession(
      '\n' + 'Detailed architecture rationale and verification notes 0123456789abcdef. '.repeat(220),
    );
    const largeBundle = buildHandoffBundle(largeSession, {
      selectedTurnIds: ['turn-1', 'turn-3'],
      redact: true,
    });
    assert.ok(largeBundle.bytes > INLINE_LIMIT_BYTES, `large bundle must exceed ${INLINE_LIMIT_BYTES} bytes`);
    assert.equal(largeBundle.recommendFileMode, true, 'bundle exceeding INLINE_LIMIT_BYTES must set recommendFileMode: true');
  });

  test('buildHandoffBundle emits lossless verbatim traceback index with fullFilePath when tool steps are pruned', () => {
    const fullLogPath = 'E:/demo/brain/conv-handoff-test-001/.system_generated/logs/transcript_full.jsonl';
    const session = {
      ...makeSyntheticSession(),
      fullFilePath: fullLogPath,
    };

    // Prune noisy turn-2 item (step-4-c0, resultBytes: 9000, resultStepIndex: 5)
    const prunedBundle = buildHandoffBundle(session, {
      selectedTurnIds: ['turn-1', 'turn-3'],
      redact: true,
    });
    assert.ok(prunedBundle.totalItemsCount > prunedBundle.selectedItemsCount);
    assert.ok(
      prunedBundle.markdown.includes('Lossless Verbatim Traceback Index'),
      'pruned handoff bundle must include "Lossless Verbatim Traceback Index" section',
    );
    assert.ok(
      prunedBundle.markdown.includes(fullLogPath),
      `traceback index must cite original fullFilePath (${fullLogPath})`,
    );
    assert.ok(
      prunedBundle.markdown.includes('step#5'),
      'traceback index should list pruned noisy step#5 for exact on-demand lookup',
    );

    // Negative control: when every item is kept (no pruned tool steps), omit redundant traceback section
    const allItemsIds = session.turns.flatMap((t) => t.items.map((item) => item.id));
    const fullBundle = buildHandoffBundle(session, {
      selectedTurnIds: ['turn-1', 'turn-2', 'turn-3'],
      selectedItemIds: allItemsIds,
      redact: true,
    });
    assert.equal(fullBundle.selectedItemsCount, fullBundle.totalItemsCount);
    assert.equal(
      fullBundle.markdown.includes('Lossless Verbatim Traceback Index'),
      false,
      'traceback section should not appear when zero tool steps were folded',
    );
  });

  test('buildLaunchPrompt selects inline mode for <= 10KB, redacts extraInstruction in file mode (>10KB), and enforces hard file mode above 28KB', () => {
    const shortMarkdown = '# Context Relay Handoff\n\n## Goal\nContinue fixing auth middleware.\n';
    const shortBytes = Buffer.byteLength(shortMarkdown, 'utf8');
    assert.ok(shortBytes <= INLINE_LIMIT_BYTES);

    const inlineRes = buildLaunchPrompt({
      bundle: { markdown: shortMarkdown, bytes: shortBytes },
      extraInstruction: 'Run existing tests first to verify the baseline',
    });
    assert.equal(inlineRes.mode, 'inline');
    assert.equal(inlineRes.prompt, shortMarkdown);

    // File mode (>10KB) with sensitive secrets inside extraInstruction must scrub all secrets
    const longMarkdown = '# Context Relay Handoff\n\n' + 'Long historical decision block 0123456789abcdef.\n'.repeat(300);
    const longBytes = Buffer.byteLength(longMarkdown, 'utf8');
    assert.ok(longBytes > INLINE_LIMIT_BYTES, 'long markdown must exceed INLINE_LIMIT_BYTES');

    const handoffFilePath = 'E:/demo/handoffs/2026-11-24-auth-relay.md';
    const secretApiKey = 'real_secret_value_99887766';
    const secretGhp = SYNTHETIC_GHP;
    const fileRes = buildLaunchPrompt({
      bundle: { markdown: longMarkdown, bytes: longBytes },
      handoffFilePath,
      targetWorkspace: 'E:/demo/project-alpha',
      extraInstruction: `Verify API_KEY=${secretApiKey} and ${secretGhp} during deployment before resuming`,
    });
    assert.equal(fileRes.mode, 'file');
    const bootstrapBytes = Buffer.byteLength(fileRes.prompt, 'utf8');
    assert.ok(
      bootstrapBytes < 2048,
      `file-mode bootstrap prompt must be < 2KB, got ${bootstrapBytes} bytes`,
    );
    assert.ok(
      fileRes.prompt.includes(handoffFilePath),
      `file-mode bootstrap prompt must include handoffFilePath (${handoffFilePath})`,
    );
    assert.ok(
      !fileRes.prompt.includes(secretApiKey),
      'file-mode launch prompt must redact API_KEY inside extraInstruction',
    );
    assert.ok(
      !fileRes.prompt.includes(secretGhp),
      'file-mode launch prompt must redact ghp_ token inside extraInstruction',
    );
    assert.ok(fileRes.prompt.includes('[REDACTED:'), 'file-mode launch prompt must emit [REDACTED:...] markers');

    // Hard > 28KB ceiling: must force file mode even without handoffFilePath or forceFileMode
    const hugeMarkdown = '# Huge Context\n' + 'Payload block 0123456789abcdef0123456789abcdef.\n'.repeat(700);
    const hugeBytes = Buffer.byteLength(hugeMarkdown, 'utf8');
    assert.ok(hugeBytes > 28 * 1024, `expected > 28KB payload, got ${hugeBytes}`);
    const forcedFileRes = buildLaunchPrompt({
      bundle: { markdown: hugeMarkdown, bytes: hugeBytes },
      forceFileMode: false,
    });
    assert.equal(
      forcedFileRes.mode,
      'file',
      'bundle exceeding 28KB hard ceiling must always force file mode',
    );
    assert.ok(Buffer.byteLength(forcedFileRes.prompt, 'utf8') < 2048);
  });
});

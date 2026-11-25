import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  readJsonlSteps,
  readFullStepByIndex,
} from '../core/jsonl-reader.mjs';
import {
  estimateTokens,
  unwrapToolArg,
  parseSessionTranscript,
  applySurgeryPreset,
} from '../core/turn-parser.mjs';

function createTempDir(prefix = 'context-relay-turn-parser-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(filePath, records, { trailingNewline = true, rawTail = '' } = {}) {
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  const content = body + (trailingNewline ? '\n' : '') + rawTail;
  fs.writeFileSync(filePath, content, 'utf8');
}

function buildSyntheticFixture(dir) {
  const noisyOutput = `FULL_SCAN_START\n${'WARNING: noisy compiler log line 0123456789abcdef\n'.repeat(160)}FULL_SCAN_END`;
  assert.ok(Buffer.byteLength(noisyOutput, 'utf8') > 5120, 'fixture noisy output must exceed 5KB');

  const fullStep5Content = `FULL_UNTRUNCATED_DIFF_HEADER\n${'+ added verified auth check line\n'.repeat(80)}FULL_UNTRUNCATED_DIFF_FOOTER`;

  const doubleQuotedAuthPath = JSON.stringify(JSON.stringify('E:\\repo\\src\\auth.mjs'));
  const singleJsonQuotedAuthPath = JSON.stringify('E:\\repo\\src\\auth.mjs');

  const steps = [
    // Turn 1: user request with metadata/settings wrappers + read + write + truncated full step
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T10:00:00.000Z',
      content: [
        '<ADDITIONAL_METADATA>workspace=e:/demo/app;os=windows</ADDITIONAL_METADATA>',
        '<USER_SETTINGS_CHANGE>changed model to gemini-2.5-pro</USER_SETTINGS_CHANGE>',
        '<USER_REQUEST>Fix login endpoint auth bug and add unit tests</USER_REQUEST>',
      ].join('\n'),
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:00:05.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 12000,
      cache_read_tokens: 4000,
      output_tokens: 350,
      content: 'Reading src/auth.mjs first to locate the auth failure.',
      tool_calls: [
        {
          name: 'read_file',
          arguments: { Path: doubleQuotedAuthPath },
        },
      ],
    },
    {
      step_index: 2,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T10:00:08.000Z',
      content: 'export function verifyToken(exp, now) { if (exp < now) return true; }',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:00:15.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 19500,
      cache_read_tokens: 6000,
      output_tokens: 480,
      content: 'Found the token expiry logic bug; updating src/auth.mjs and adding a test file.',
      tool_calls: [
        {
          name: 'edit_file',
          arguments: {
            Path: singleJsonQuotedAuthPath,
            Target: 'if (exp < now) return true;',
            Replacement: 'if (exp <= now) return false;',
          },
        },
        {
          name: 'write_file',
          arguments: {
            Path: 'E:/repo/test/auth.test.mjs',
            Content: 'import assert from "node:assert/strict";',
          },
        },
      ],
    },
    {
      step_index: 4,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T10:00:17.000Z',
      content: 'Edited file E:\\repo\\src\\auth.mjs successfully.',
    },
    {
      step_index: 5,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T10:00:18.000Z',
      content: 'FULL_UNTRUNCATED_DIFF_HEADER...(truncated)',
      truncated_fields: ['content'],
    },

    // Turn 2: pure >5KB noisy scan + ERROR step, no file edits
    {
      step_index: 6,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T10:01:00.000Z',
      content: '<USER_REQUEST>Run a full repo scan to inspect compiler noise logs</USER_REQUEST>',
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:01:04.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 28000,
      cache_read_tokens: 8000,
      output_tokens: 120,
      content: 'Running the repository scan and checking lint errors.',
      tool_calls: [
        {
          name: 'run_command',
          arguments: { CommandLine: 'node scripts/scan-noise.mjs' },
        },
        {
          name: 'run_command',
          arguments: { CommandLine: 'node scripts/check-lint.mjs' },
        },
      ],
    },
    {
      step_index: 8,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T10:01:09.000Z',
      content: noisyOutput,
    },
    {
      step_index: 9,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'ERROR',
      created_at: '2026-11-24T10:01:12.000Z',
      content: 'Command exited with code 1: lint error',
    },

    // Turn 3: clean verification check
    {
      step_index: 10,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T10:02:00.000Z',
      content: '<USER_REQUEST>Confirm the exported API of the auth module</USER_REQUEST>',
    },
    {
      step_index: 11,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:02:05.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 30000,
      cache_read_tokens: 5000,
      output_tokens: 210,
      content: 'Confirmed the auth module exports only verifyToken and refreshSession.',
    },

    // Turn 4: additional doc update
    {
      step_index: 12,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T10:03:00.000Z',
      content: '<USER_REQUEST>Update changelog documentation</USER_REQUEST>',
    },
    {
      step_index: 13,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:03:05.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 32000,
      cache_read_tokens: 5000,
      output_tokens: 180,
      content: 'Updated CHANGELOG.md.',
      tool_calls: [
        {
          name: 'write_file',
          arguments: { Path: 'E:/repo/CHANGELOG.md', Content: 'Fixed token expiry check.' },
        },
      ],
    },
    {
      step_index: 14,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T10:03:07.000Z',
      content: 'Created CHANGELOG.md',
    },

    // Turn 5: final summary + trailing PENDING step that must be skipped
    {
      step_index: 15,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T10:04:00.000Z',
      content: '<USER_REQUEST>Summarize final conclusions and verification results</USER_REQUEST>',
    },
    {
      step_index: 16,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T10:04:05.000Z',
      model: 'gemini-2.5-pro',
      input_tokens: 34000,
      cache_read_tokens: 6000,
      output_tokens: 260,
      content: 'Auth logic is fixed and all unit tests pass; ready to merge.',
    },
    {
      step_index: 17,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'PENDING',
      created_at: '2026-11-24T10:04:10.000Z',
      model: 'gemini-2.5-pro',
      content: 'streaming unfinished partial token...',
    },
  ];

  const fullSteps = steps.map((step) =>
    step.step_index === 5
      ? { ...step, content: fullStep5Content, truncated_fields: undefined }
      : step,
  );

  const transcriptPath = path.join(dir, 'transcript.jsonl');
  const fullPath = path.join(dir, 'transcript_full.jsonl');
  writeJsonl(transcriptPath, steps);
  writeJsonl(fullPath, fullSteps);

  return { transcriptPath, fullPath, steps, fullStep5Content };
}

describe('jsonl-reader: readJsonlSteps & readFullStepByIndex', () => {
  test('reads complete JSONL cleanly with truncatedTail === false', () => {
    const dir = createTempDir();
    const { transcriptPath, steps } = buildSyntheticFixture(dir);

    const res = readJsonlSteps(transcriptPath);
    assert.ok(res);
    assert.equal(res.truncatedTail, false);
    assert.equal(res.steps.length, steps.length);
    assert.equal(res.steps[0].step_index, 0);
    assert.deepEqual(res.steps[5].truncated_fields, ['content']);
  });

  test('tolerates torn JSON tail without trailing newline and marks truncatedTail: true', () => {
    const dir = createTempDir();
    const tornPath = path.join(dir, 'transcript.jsonl');
    const validRecords = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>hello</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'world', input_tokens: 100 },
    ];
    writeJsonl(tornPath, validRecords, {
      trailingNewline: true,
      rawTail: '{"step_index":2,"type":"PLANNER_RESPONSE","content":"half-written-no-eol',
    });

    const res = readJsonlSteps(tornPath);
    assert.ok(res);
    assert.equal(res.truncatedTail, true);
    assert.equal(res.steps.length, 2);
    assert.equal(res.steps[0].step_index, 0);
    assert.equal(res.steps[1].content, 'world');
  });

  test('readFullStepByIndex fetches exact untruncated record from sibling transcript_full.jsonl', () => {
    const dir = createTempDir();
    const { transcriptPath, fullStep5Content } = buildSyntheticFixture(dir);

    const fullStep = readFullStepByIndex(transcriptPath, 5);
    assert.ok(fullStep, 'expected full step 5 to be returned');
    assert.equal(fullStep.step_index, 5);
    assert.equal(fullStep.content, fullStep5Content);
    assert.ok(fullStep.content.includes('FULL_UNTRUNCATED_DIFF_FOOTER'));

    // Negative control: nonexistent step_index returns null without throwing
    assert.equal(readFullStepByIndex(transcriptPath, 9999), null);
  });

  test('readFullStepByIndex falls back to transcript.jsonl when transcript_full.jsonl lags behind', () => {
    const dir = createTempDir('context-relay-full-lag-');
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const fullPath = path.join(dir, 'transcript_full.jsonl');

    // transcript_full.jsonl only has step 0, while transcript.jsonl has steps 0, 1, 2
    writeJsonl(fullPath, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>step 0 full</USER_REQUEST>' },
    ]);
    writeJsonl(transcriptPath, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>step 0 compact</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'step 1' },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'FALLBACK_STEP_2_CONTENT_OK' },
    ]);

    const step0 = readFullStepByIndex(transcriptPath, 0);
    assert.ok(step0 && step0.content.includes('step 0 full'), 'step 0 should still prefer transcript_full.jsonl');

    const step2 = readFullStepByIndex(transcriptPath, 2);
    assert.ok(step2, 'step 2 missing from lagging transcript_full.jsonl must fall back to transcript.jsonl');
    assert.equal(step2.step_index, 2);
    assert.equal(step2.content, 'FALLBACK_STEP_2_CONTENT_OK');
  });
});

describe('turn-parser: unwrapToolArg & estimateTokens', () => {
  test('unwrapToolArg unwraps single & double JSON-quoted paths while preserving plain strings', () => {
    const plainWinPath = 'E:\\repo\\src\\auth.mjs';
    const onceQuoted = JSON.stringify(plainWinPath);
    const twiceQuoted = JSON.stringify(onceQuoted);

    assert.equal(unwrapToolArg(onceQuoted), plainWinPath);
    assert.equal(unwrapToolArg(twiceQuoted), plainWinPath);
    assert.equal(unwrapToolArg('"/usr/local/bin/node"'), '/usr/local/bin/node');
    assert.equal(unwrapToolArg('E:/repo/test/auth.test.mjs'), 'E:/repo/test/auth.test.mjs');
    assert.equal(unwrapToolArg('plain-arg'), 'plain-arg');
    assert.equal(unwrapToolArg(''), '');
    assert.equal(unwrapToolArg(null), '');
    assert.equal(unwrapToolArg(undefined), '');
  });

  test('estimateTokens handles empty, English, and Chinese text monotonically', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    const shortEn = estimateTokens('hello world');
    const longEn = estimateTokens('hello world '.repeat(50));
    const zh = estimateTokens('这是一段用于测试中文字符估算的上下文内容');
    assert.ok(shortEn > 0);
    assert.ok(longEn > shortEn);
    assert.ok(zh > 0);
  });
});

describe('turn-parser: parseSessionTranscript, regression edge cases & subagent detection', () => {
  test('parses turns, skips PENDING, strips user wrappers, tracks filesTouched, peakContextTokens, deltaContextTokens, isNoisy, and defaultInclude', () => {
    const dir = createTempDir();
    const { transcriptPath } = buildSyntheticFixture(dir);
    const { steps } = readJsonlSteps(transcriptPath);

    const parsed = parseSessionTranscript(steps, { sessionId: 'conv-parser-001' });
    assert.equal(parsed.turns.length, 5);

    const turn1 = parsed.turns[0];
    assert.equal(turn1.id, 'turn-1');
    assert.equal(turn1.index, 1);
    assert.equal(turn1.userText, 'Fix login endpoint auth bug and add unit tests');
    assert.ok(!turn1.userText.includes('<ADDITIONAL_METADATA>'));
    assert.ok(!turn1.userText.includes('<USER_SETTINGS_CHANGE>'));

    const turn5 = parsed.turns[4];
    assert.equal(turn5.stepRange.end, 16);
    assert.ok(!turn5.assistantText.includes('streaming unfinished partial token'));

    assert.equal(parsed.peakContextTokens, 40000);
    assert.equal(turn1.deltaContextTokens, 25500);
    assert.equal(parsed.turns[1].deltaContextTokens, 10500);
    assert.equal(turn5.deltaContextTokens, 3000);

    assert.ok(parsed.filesTouched.modified.includes('E:\\repo\\src\\auth.mjs'));
    assert.ok(parsed.filesTouched.modified.includes('E:/repo/test/auth.test.mjs'));
    assert.ok(parsed.filesTouched.modified.includes('E:/repo/CHANGELOG.md'));
    assert.ok(parsed.filesTouched.read.includes('E:\\repo\\src\\auth.mjs'));
    for (const f of [...parsed.filesTouched.modified, ...parsed.filesTouched.read]) {
      assert.ok(!f.startsWith('"') && !f.endsWith('"'), `path must be unwrapped: ${f}`);
    }

    assert.equal(turn1.items.length, 3);
    const [readItem, editItem, writeItem] = turn1.items;
    assert.equal(readItem.isNoisy, false);
    assert.equal(readItem.defaultInclude, true);
    assert.equal(editItem.isWrite, true);
    assert.equal(editItem.defaultInclude, true);
    assert.equal(writeItem.isWrite, true);
    assert.equal(writeItem.truncated, true);
    assert.equal(writeItem.defaultInclude, true);

    const turn2 = parsed.turns[1];
    assert.equal(turn2.items.length, 2);
    const [noisyItem, errorItem] = turn2.items;
    assert.ok(noisyItem.resultBytes > 5120);
    assert.equal(noisyItem.isNoisy, true);
    assert.equal(noisyItem.defaultInclude, false);
    assert.equal(errorItem.isError, true);
    assert.equal(errorItem.isNoisy, true);
    assert.equal(errorItem.defaultInclude, false);
    assert.equal(turn2.errorCount, 1);
    assert.ok(turn2.noiseBytes > 5120);

    assert.equal(parsed.isSubagent, false);
  });

  test('skips in-progress GENERIC (PENDING) steps without off-by-one tool result misalignment', () => {
    const steps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T12:00:00.000Z',
        content: '<USER_REQUEST>Read a file then run a command</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T12:00:02.000Z',
        model: 'gemini-2.5-pro',
        input_tokens: 1000,
        output_tokens: 100,
        content: 'Executing two tool calls.',
        tool_calls: [
          { name: 'read_file', arguments: { Path: 'E:/repo/a.mjs' } },
          { name: 'run_command', arguments: { CommandLine: 'echo ok' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'PENDING',
        created_at: '2026-11-24T12:00:03.000Z',
        content: 'STILL_RUNNING_INTERMEDIATE_STATE',
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-24T12:00:04.000Z',
        content: 'RESULT_FOR_READ_FILE_A',
      },
      {
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-24T12:00:05.000Z',
        content: 'RESULT_FOR_RUN_COMMAND_ECHO',
      },
    ];

    const parsed = parseSessionTranscript(steps, { sessionId: 'conv-generic-pending' });
    assert.equal(parsed.turns.length, 1);
    const items = parsed.turns[0].items;
    assert.equal(items.length, 2);
    assert.equal(items[0].toolName, 'read_file');
    assert.equal(items[0].resultStepIndex, 3);
    assert.equal(items[0].resultPreview, 'RESULT_FOR_READ_FILE_A');
    assert.equal(items[1].toolName, 'run_command');
    assert.equal(items[1].resultStepIndex, 4);
    assert.equal(items[1].resultPreview, 'RESULT_FOR_RUN_COMMAND_ECHO');
  });

  test('does not flag post-write re-read or distinct line-range reads as duplicate noise (but flags unmodified identical re-read)', () => {
    const steps = [
      // Turn 1: read a.js L1-50, then read a.js L51-100 (distinct ranges => neither duplicate)
      {
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T12:10:00.000Z',
        content: '<USER_REQUEST>Read a.js in two line ranges</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T12:10:02.000Z',
        model: 'gemini-2.5-pro',
        tool_calls: [
          { name: 'read_file', arguments: { Path: 'E:/repo/a.js', StartLine: 1, EndLine: 50 } },
          { name: 'read_file', arguments: { Path: 'E:/repo/a.js', StartLine: 51, EndLine: 100 } },
        ],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'lines 1..50' },
      { step_index: 3, type: 'GENERIC', status: 'DONE', content: 'lines 51..100' },

      // Turn 2: edit a.js, then re-read L1-50 and L51-100 (post-write => not duplicate), then re-read L51-100 again without write (duplicate!)
      {
        step_index: 4,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T12:11:00.000Z',
        content: '<USER_REQUEST>Edit a.js and verify updated content</USER_REQUEST>',
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T12:11:02.000Z',
        model: 'gemini-2.5-pro',
        tool_calls: [
          { name: 'edit_file', arguments: { Path: 'E:/repo/a.js', Target: 'old', Replacement: 'new' } },
          { name: 'read_file', arguments: { Path: 'E:/repo/a.js', StartLine: 51, EndLine: 100 } },
          { name: 'read_file', arguments: { Path: 'E:/repo/a.js', StartLine: 51, EndLine: 100 } },
        ],
      },
      { step_index: 6, type: 'GENERIC', status: 'DONE', content: 'edited ok' },
      { step_index: 7, type: 'GENERIC', status: 'DONE', content: 'updated lines 51..100' },
      { step_index: 8, type: 'GENERIC', status: 'DONE', content: 'same updated lines 51..100' },
    ];

    const parsed = parseSessionTranscript(steps, { sessionId: 'conv-reread-ranges' });
    assert.equal(parsed.turns.length, 2);

    const [t1ReadA, t1ReadB] = parsed.turns[0].items;
    assert.equal(t1ReadA.isDuplicateRead, false);
    assert.equal(t1ReadA.defaultInclude, true);
    assert.equal(t1ReadB.isDuplicateRead, false, 'distinct line range on same file must not be marked duplicate');
    assert.equal(t1ReadB.defaultInclude, true);

    const [t2Edit, t2PostWriteRead, t2RedundantRead] = parsed.turns[1].items;
    assert.equal(t2Edit.isWrite, true);
    assert.equal(t2PostWriteRead.isDuplicateRead, false, 'read after edit_file must invalidate prior read cache');
    assert.equal(t2PostWriteRead.defaultInclude, true);

    // Negative control: immediate unmodified duplicate of identical range IS flagged
    assert.equal(t2RedundantRead.isDuplicateRead, true);
    assert.equal(t2RedundantRead.isNoisy, true);
    assert.equal(t2RedundantRead.defaultInclude, false);
  });

  test('handles pathological 5000x [Message] + 100KB single-line SYSTEM_MESSAGE in linear time (< 50ms)', () => {
    const pathological = `${'[Message] '.repeat(5000)}${'x'.repeat(100 * 1024)}`;
    const steps = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T12:20:00.000Z',
        content: pathological,
      },
    ];

    const t0 = performance.now();
    const parsed = parseSessionTranscript(steps, { sessionId: 'conv-redos-check' });
    const elapsedMs = performance.now() - t0;

    assert.ok(parsed && Array.isArray(parsed.turns));
    assert.ok(
      elapsedMs < 50,
      `SYSTEM_MESSAGE parsing must be linear and finish < 50ms, took ${elapsedMs.toFixed(2)}ms`,
    );
  });

  test('detects subagent sessions from SYSTEM_MESSAGE sender directive', () => {
    const subagentSteps = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T11:00:00.000Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T11:00:00Z sender=parent-conv-123 priority=MESSAGE_PRIORITY_HIGH content=Execute parallel unit test authoring task\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T11:00:05.000Z',
        model: 'gemini-2.5-pro',
        input_tokens: 4500,
        output_tokens: 200,
        content: 'Writing unit tests.',
        tool_calls: [
          {
            name: 'send_message',
            arguments: { Recipient: 'parent-conv-123', Message: 'done' },
          },
        ],
      },
    ];

    const parsed = parseSessionTranscript(subagentSteps, { sessionId: 'subagent-001' });
    assert.equal(parsed.isSubagent, true);
    assert.equal(parsed.parentSessionId, 'parent-conv-123');
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].sourceType, 'SYSTEM_MESSAGE');
    assert.ok(parsed.turns[0].userText.includes('Execute parallel unit test authoring task'));
  });
});

describe('turn-parser: applySurgeryPreset', () => {
  test('produces exact selections for smart-clean, backbone, truncate-at, all, and none', () => {
    const dir = createTempDir();
    const { transcriptPath } = buildSyntheticFixture(dir);
    const { steps } = readJsonlSteps(transcriptPath);
    const parsed = parseSessionTranscript(steps, { sessionId: 'conv-preset-001' });

    const allTurnIds = parsed.turns.map((t) => t.id);
    const allItemIds = parsed.turns.flatMap((t) => t.items.map((item) => item.id));
    const turn2ItemIds = parsed.turns[1].items.map((item) => item.id);
    const writeItemIds = parsed.turns.flatMap((t) =>
      t.items.filter((item) => item.isWrite).map((item) => item.id),
    );

    const smart = applySurgeryPreset(parsed, 'smart-clean');
    assert.deepEqual(smart.selectedTurnIds, allTurnIds);
    for (const badId of turn2ItemIds) {
      assert.ok(!smart.selectedItemIds.includes(badId), `smart-clean must drop noisy/error item ${badId}`);
    }
    for (const writeId of writeItemIds) {
      assert.ok(smart.selectedItemIds.includes(writeId), `smart-clean must keep write item ${writeId}`);
    }

    const backbone = applySurgeryPreset(parsed, 'backbone');
    assert.deepEqual(backbone.selectedTurnIds, ['turn-1', 'turn-3', 'turn-4', 'turn-5']);
    assert.ok(!backbone.selectedTurnIds.includes('turn-2'), 'backbone must drop noisy middle turn-2');
    assert.deepEqual(backbone.selectedItemIds, writeItemIds);

    const trunc2 = applySurgeryPreset(parsed, 'truncate-at', { maxTurnIndex: 2 });
    assert.deepEqual(trunc2.selectedTurnIds, ['turn-1', 'turn-2']);
    for (const badId of turn2ItemIds) {
      assert.ok(!trunc2.selectedItemIds.includes(badId), 'truncate-at still keeps defaultInclude items only');
    }

    const trunc1 = applySurgeryPreset(parsed, 'truncate-at', { maxTurnIndex: 1 });
    assert.deepEqual(trunc1.selectedTurnIds, ['turn-1']);
    assert.equal(trunc1.selectedItemIds.length, 3);

    const all = applySurgeryPreset(parsed, 'all');
    assert.deepEqual(all.selectedTurnIds, allTurnIds);
    assert.deepEqual(all.selectedItemIds, allItemIds);

    const none = applySurgeryPreset(parsed, 'none');
    assert.deepEqual(none, { selectedTurnIds: [], selectedItemIds: [] });
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CopilotParser } from '../src/parsers/copilot.ts';

test('CopilotParser parses nested events.jsonl sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devday-copilot-nested-'));
  const sessionStateDir = join(root, 'session-state');
  const sessionId = 'nested-session-id';
  const sessionDir = join(sessionStateDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const workspaceYaml = [
    `id: ${sessionId}`,
    'cwd: /tmp/copilot-project',
    'git_root: /tmp/copilot-project',
    'summary: Ship Copilot parser',
    'created_at: 2026-02-17T10:00:00.000',
    'updated_at: 2026-02-17T10:30:00.000',
  ].join('\n');
  writeFileSync(join(sessionDir, 'workspace.yaml'), workspaceYaml + '\n', 'utf-8');

  const lines = [
    JSON.stringify({
      type: 'session.start',
      timestamp: '2026-02-17T10:00:00.000',
      data: {
        sessionId,
        context: {
          cwd: '/tmp/copilot-project',
          gitRoot: '/tmp/copilot-project',
          branch: 'main',
        },
      },
    }),
    JSON.stringify({
      type: 'session.model_change',
      timestamp: '2026-02-17T10:00:01.000',
      data: {
        newModel: 'gpt-4o',
      },
    }),
    JSON.stringify({
      type: 'user.message',
      timestamp: '2026-02-17T10:00:02.000',
      data: {
        content: 'Please update src/index.ts.',
        transformedContent: '<agent_instructions>ignore this</agent_instructions>',
      },
    }),
    JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-02-17T10:00:03.000',
      data: {
        content: 'I will patch the file now.',
      },
    }),
    JSON.stringify({
      type: 'tool.execution_start',
      timestamp: '2026-02-17T10:00:04.000',
      data: {
        toolName: 'edit',
        arguments: {
          path: '/tmp/copilot-project/src/index.ts',
        },
      },
    }),
    JSON.stringify({
      type: 'assistant.turn_end',
      timestamp: '2026-02-17T10:00:05.000',
      data: {
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          cached_input_tokens: 10,
        },
      },
    }),
  ];
  writeFileSync(join(sessionDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');

  const parser = new CopilotParser(sessionStateDir);
  const sessions = await parser.getSessions('2026-02-17');

  assert.equal(sessions.length, 1);
  const [session] = sessions;

  assert.equal(session.id, sessionId);
  assert.equal(session.tool, 'copilot');
  assert.equal(session.projectPath, '/tmp/copilot-project');
  assert.equal(session.projectName, 'copilot-project');
  assert.equal(session.title, 'Ship Copilot parser');
  assert.equal(session.messageCount, 2);
  assert.equal(session.userMessageCount, 1);
  assert.equal(session.assistantMessageCount, 1);
  assert.deepEqual(session.models, ['gpt-4o']);
  assert.equal(session.tokens.input, 120);
  assert.equal(session.tokens.output, 45);
  assert.equal(session.tokens.cacheRead, 10);
  assert.equal(session.tokens.total, 175);
  assert.ok(session.costUsd > 0);
  assert.ok(session.conversationDigest.includes('Please update src/index.ts.'));
  assert.ok(session.conversationDigest.includes('I will patch the file now.'));
  assert.ok(session.toolCallSummaries.includes('edit /tmp/copilot-project/src/index.ts'));
  assert.ok(session.filesTouched.includes('/tmp/copilot-project/src/index.ts'));
});

test('CopilotParser parses flat .jsonl sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devday-copilot-flat-'));
  const sessionStateDir = join(root, 'session-state');
  mkdirSync(sessionStateDir, { recursive: true });

  const sessionId = 'flat-session-id';
  const lines = [
    JSON.stringify({
      type: 'session.start',
      timestamp: '2026-02-17T11:00:00.000',
      data: {
        sessionId,
      },
    }),
    JSON.stringify({
      type: 'session.model_change',
      timestamp: '2026-02-17T11:00:01.000',
      data: {
        newModel: 'claude-sonnet-4-20250514',
      },
    }),
    JSON.stringify({
      type: 'user.message',
      timestamp: '2026-02-17T11:00:02.000',
      data: {
        content: 'Summarize this repository.',
      },
    }),
    JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-02-17T11:00:03.000',
      data: {
        content: '',
        toolRequests: [
          {
            name: 'view',
            arguments: { path: '/tmp/flat-project/README.md' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant.turn_end',
      timestamp: '2026-02-17T11:00:04.000',
      data: {
        tokenUsage: {
          prompt_tokens: 30,
          completion_tokens: 20,
        },
      },
    }),
  ];
  writeFileSync(join(sessionStateDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');

  const parser = new CopilotParser(sessionStateDir);
  const sessions = await parser.getSessions('2026-02-17');

  assert.equal(sessions.length, 1);
  const [session] = sessions;

  assert.equal(session.id, sessionId);
  assert.equal(session.tool, 'copilot');
  assert.equal(session.projectPath, null);
  assert.equal(session.projectName, null);
  assert.equal(session.title, 'Summarize this repository.');
  assert.equal(session.messageCount, 2);
  assert.equal(session.userMessageCount, 1);
  assert.equal(session.assistantMessageCount, 1);
  assert.deepEqual(session.models, ['claude-sonnet-4-20250514']);
  assert.equal(session.tokens.input, 30);
  assert.equal(session.tokens.output, 20);
  assert.equal(session.tokens.total, 50);
  assert.ok(session.conversationDigest.includes('Summarize this repository.'));
  assert.ok(session.toolCallSummaries.includes('view /tmp/flat-project/README.md'));
  assert.ok(session.filesTouched.includes('/tmp/flat-project/README.md'));
});

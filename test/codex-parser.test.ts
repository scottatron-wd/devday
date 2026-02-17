import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexParser } from '../src/parsers/codex.ts';

test('CodexParser parses a session jsonl file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devday-codex-'));
  const sessionsDir = join(root, 'sessions', '2026', '02', '17');
  mkdirSync(sessionsDir, { recursive: true });

  const sessionPath = join(sessionsDir, 'rollout-test-session.jsonl');
  const lines = [
    JSON.stringify({
      timestamp: '2026-02-17T20:00:00.000',
      type: 'session_meta',
      payload: {
        id: 'test-session-id',
        cwd: '/tmp/my-project',
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-17T20:00:01.000',
      type: 'turn_context',
      payload: {
        model: 'gpt-5.2-codex',
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-17T20:00:02.000',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Implement codex parser support.' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-17T20:00:03.000',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'view',
        arguments: JSON.stringify({ path: '/tmp/my-project/src/index.ts' }),
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-17T20:00:04.000',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            cached_input_tokens: 20,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-17T20:00:05.000',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Parser support added.' }],
      },
    }),
  ];
  writeFileSync(sessionPath, lines.join('\n') + '\n', 'utf-8');

  const parser = new CodexParser(join(root, 'sessions'));
  const sessions = await parser.getSessions('2026-02-17');

  assert.equal(sessions.length, 1);
  const [session] = sessions;

  assert.equal(session.id, 'test-session-id');
  assert.equal(session.tool, 'codex');
  assert.equal(session.projectPath, '/tmp/my-project');
  assert.equal(session.projectName, 'my-project');
  assert.equal(session.messageCount, 2);
  assert.equal(session.userMessageCount, 1);
  assert.equal(session.assistantMessageCount, 1);
  assert.deepEqual(session.models, ['gpt-5.2-codex']);
  assert.equal(session.tokens.input, 100);
  assert.equal(session.tokens.output, 50);
  assert.equal(session.tokens.reasoning, 10);
  assert.equal(session.tokens.cacheRead, 20);
  assert.equal(session.tokens.total, 180);
  assert.ok(session.conversationDigest.includes('Implement codex parser support.'));
  assert.ok(session.conversationDigest.includes('Parser support added.'));
  assert.ok(session.toolCallSummaries.includes('view /tmp/my-project/src/index.ts'));
  assert.ok(session.filesTouched.includes('/tmp/my-project/src/index.ts'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DayRecap } from '../src/types.ts';
import {
  buildObsidianInboxEntry,
  buildWorklogMarkdown,
  resolveVaultPath,
} from '../src/worklog.ts';

function sampleRecap(): DayRecap {
  return {
    date: '2026-02-17',
    projects: [
      {
        projectPath: '/tmp/project-alpha',
        projectName: 'project-alpha',
        sessions: [
          {
            id: 'session-1',
            tool: 'codex',
            projectPath: '/tmp/project-alpha',
            projectName: 'project-alpha',
            title: 'Add worklog mode',
            startedAt: new Date('2026-02-17T01:00:00.000Z'),
            endedAt: new Date('2026-02-17T01:20:00.000Z'),
            durationMs: 20 * 60 * 1000,
            messageCount: 8,
            userMessageCount: 3,
            assistantMessageCount: 5,
            summary: null,
            topics: [],
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 15,
            },
            costUsd: 0.25,
            models: ['gpt-5.3-codex'],
            filesTouched: [
              '/tmp/project-alpha/src/index.ts',
              '/tmp/project-alpha/README.md',
            ],
            conversationDigest: [
              '[User]: Please add worklog mode and write an obsidian note.',
              '[Assistant]: I will implement that now.',
              '[User]: also include session IDs in frontmatter.',
            ].join('\n\n'),
            toolCallSummaries: [
              'apply_patch src/index.ts',
              'npm test',
            ],
          },
        ],
        git: {
          projectPath: '/tmp/project-alpha',
          projectName: 'project-alpha',
          commits: [
            {
              hash: 'abcdef1234567890',
              shortHash: 'abcdef1',
              message: 'feat: add worklog mode',
              author: 'Dev',
              timestamp: new Date('2026-02-17T01:22:00.000Z'),
              filesChanged: 1,
              insertions: 10,
              deletions: 1,
              files: ['src/index.ts'],
            },
          ],
          totalFilesChanged: 1,
          totalInsertions: 10,
          totalDeletions: 1,
        },
        totalSessions: 1,
        totalMessages: 8,
        totalTokens: 15,
        totalCostUsd: 0.25,
        totalDurationMs: 20 * 60 * 1000,
        toolsUsed: ['codex'],
        modelsUsed: ['gpt-5.3-codex'],
        filesTouched: ['/tmp/project-alpha/src/index.ts'],
        aiSummary: null,
      },
    ],
    totalSessions: 1,
    totalMessages: 8,
    totalTokens: 15,
    totalCostUsd: 0.25,
    totalDurationMs: 20 * 60 * 1000,
    toolsUsed: ['codex'],
    standupMessage: null,
  };
}

test('buildWorklogMarkdown renders detailed sections without cost tables', () => {
  const markdown = buildWorklogMarkdown(sampleRecap());

  assert.ok(markdown.includes('## Local Context'));
  assert.ok(markdown.includes('## Work Completed'));
  assert.ok(markdown.includes('Session ID: `session-1`'));
  assert.ok(markdown.includes('Files touched: src/index.ts, README.md'));
  assert.ok(markdown.includes('Git commits:'));
  assert.ok(markdown.includes('## Follow-up'));
  assert.ok(!markdown.includes('Cost'));
  assert.ok(!markdown.includes('Tokens'));
});

test('buildObsidianInboxEntry includes session IDs in frontmatter', () => {
  const recap = sampleRecap();
  const markdown = buildWorklogMarkdown(recap);
  const entry = buildObsidianInboxEntry(recap, markdown, {
    vaultPath: '/vault',
    cwd: '/tmp/project-alpha',
    title: 'Alpha Worklog',
    source: 'devday --worklog --write-obsidian-inbox',
    now: new Date('2026-02-17T01:02:03.000Z'),
  });

  assert.equal(entry.filePath, '/vault/inbox/2026-02-17-120203-alpha-worklog.md');
  assert.ok(entry.content.includes('session_id: "session-1"'));
  assert.ok(entry.content.includes('session_ids:\n  - "session-1"'));
  assert.ok(entry.content.includes('created_at: "2026-02-17T12:02:03+11:00"'));
});

test('resolveVaultPath expands home shorthand', () => {
  const resolved = resolveVaultPath('~/obsidian-notebook');
  assert.ok(resolved.endsWith('/obsidian-notebook'));
});

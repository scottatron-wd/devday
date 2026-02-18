import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DayRecap, DevDayConfig } from '../src/types.ts';
import {
  buildObsidianInboxEntries,
  buildSessionSummaries,
  buildWorklogMarkdown,
  loadSessionSummaryInstructions,
  resolveVaultPath,
} from '../src/worklog.ts';

function sampleConfig(): DevDayConfig {
  return {
    anthropicApiKey: null,
    openaiApiKey: null,
    preferredSummarizer: 'none',
    paths: {
      opencodeStorage: null,
      claudeCodeHome: null,
      cursorStateDb: null,
      codexSessions: null,
      copilotSessionState: null,
    },
    enabledTools: ['codex'],
    gitAuthorFilter: null,
  };
}

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
              '[Assistant]: I implemented the worklog mode and tests.',
              '[User]: also include session IDs in frontmatter.',
            ].join('\n\n'),
            toolCallSummaries: [
              'apply_patch src/index.ts',
              'npm test',
            ],
          },
          {
            id: 'session-2',
            tool: 'copilot',
            projectPath: '/tmp/project-alpha',
            projectName: 'project-alpha',
            title: 'Refine docs',
            startedAt: new Date('2026-02-17T03:00:00.000Z'),
            endedAt: new Date('2026-02-17T03:10:00.000Z'),
            durationMs: 10 * 60 * 1000,
            messageCount: 4,
            userMessageCount: 2,
            assistantMessageCount: 2,
            summary: null,
            topics: [],
            tokens: {
              input: 5,
              output: 2,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 7,
            },
            costUsd: 0.1,
            models: ['gpt-4o'],
            filesTouched: ['/tmp/project-alpha/README.md'],
            conversationDigest: [
              '[User]: Improve README usage examples.',
              '[Assistant]: Added clearer examples and command docs.',
            ].join('\n\n'),
            toolCallSummaries: ['edit README.md'],
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
              filesChanged: 2,
              insertions: 12,
              deletions: 1,
              files: ['src/index.ts', 'README.md'],
            },
          ],
          totalFilesChanged: 2,
          totalInsertions: 12,
          totalDeletions: 1,
        },
        totalSessions: 2,
        totalMessages: 12,
        totalTokens: 22,
        totalCostUsd: 0.35,
        totalDurationMs: 30 * 60 * 1000,
        toolsUsed: ['codex', 'copilot'],
        modelsUsed: ['gpt-5.3-codex', 'gpt-4o'],
        filesTouched: ['/tmp/project-alpha/src/index.ts', '/tmp/project-alpha/README.md'],
        aiSummary: null,
      },
    ],
    totalSessions: 2,
    totalMessages: 12,
    totalTokens: 22,
    totalCostUsd: 0.35,
    totalDurationMs: 30 * 60 * 1000,
    toolsUsed: ['codex', 'copilot'],
    standupMessage: null,
  };
}

test('loadSessionSummaryInstructions reads markdown file at runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'devday-instructions-'));
  const promptPath = join(root, 'instructions.md');
  writeFileSync(promptPath, '# Summary Prompt\n- Keep concise\n', 'utf-8');

  const loaded = loadSessionSummaryInstructions(promptPath);
  assert.equal(loaded.path, promptPath);
  assert.ok(loaded.text.includes('Keep concise'));
});

test('buildSessionSummaries uses fallback summaries without API keys', async () => {
  const result = await buildSessionSummaries(sampleRecap(), sampleConfig(), {
    summarizeWithLlm: true,
  });

  assert.equal(result.summaries.size, 2);
  const first = result.summaries.get('session-1') ?? '';
  assert.ok(first.includes('I worked on Add worklog mode'));
});

test('buildWorklogMarkdown renders descriptive summary lines', async () => {
  const recap = sampleRecap();
  const summaries = await buildSessionSummaries(recap, sampleConfig(), {
    summarizeWithLlm: false,
  });

  const markdown = buildWorklogMarkdown(recap, summaries.summaries);
  assert.ok(markdown.includes('## Work Completed'));
  assert.ok(markdown.includes('Summary:'));
  assert.ok(markdown.includes('Session ID: `session-1`'));
  assert.ok(markdown.includes('Files touched: src/index.ts, README.md'));
  assert.ok(!markdown.includes('Cost'));
  assert.ok(!markdown.includes('Tokens'));
});

test('buildObsidianInboxEntries creates one entry per session with session_id', async () => {
  const recap = sampleRecap();
  const summaries = await buildSessionSummaries(recap, sampleConfig(), {
    summarizeWithLlm: false,
  });

  const entries = buildObsidianInboxEntries(recap, {
    vaultPath: '/vault',
    cwd: '/tmp/project-alpha',
    source: 'devday --worklog --write-obsidian-inbox',
    now: new Date('2026-02-17T01:02:03.000Z'),
    sessionSummaries: summaries.summaries,
  });

  assert.equal(entries.length, 2);
  assert.ok(entries[0].filePath.startsWith('/vault/inbox/2026-02-17-120000-'));
  assert.ok(entries[1].filePath.startsWith('/vault/inbox/2026-02-17-140000-'));
  assert.ok(entries[0].content.includes('session_id: "session-1"'));
  assert.ok(entries[1].content.includes('session_id: "session-2"'));
});

test('resolveVaultPath expands home shorthand', () => {
  const resolved = resolveVaultPath('~/obsidian-notebook');
  assert.ok(resolved.endsWith('/obsidian-notebook'));
});

test('resolveVaultPath keeps explicit absolute paths', () => {
  const custom = resolveVaultPath('/tmp/custom-vault');
  assert.equal(custom, '/tmp/custom-vault');
});

test('buildSessionSummaries respects custom instruction file path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devday-instructions-runtime-'));
  mkdirSync(root, { recursive: true });
  const promptPath = join(root, 'custom.md');
  writeFileSync(promptPath, '# Custom prompt\n- Always first person\n', 'utf-8');

  const result = await buildSessionSummaries(sampleRecap(), sampleConfig(), {
    summarizeWithLlm: false,
    instructionsPath: promptPath,
  });

  assert.equal(result.instructionsPath, promptPath);
});

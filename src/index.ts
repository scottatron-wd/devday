import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { format, isValid, parseISO, subDays } from 'date-fns';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { OpenCodeParser } from './parsers/opencode.js';
import { ClaudeCodeParser } from './parsers/claude-code.js';
import { CursorParser } from './parsers/cursor.js';
import { CodexParser } from './parsers/codex.js';
import { CopilotParser } from './parsers/copilot.js';
import { getGitActivity } from './git.js';
import { buildDayRecap } from './merge.js';
import { summarizeRecap } from './summarize.js';
import { renderRecap } from './render.js';
import {
  buildWorklogMarkdown,
  buildSessionSummaries,
  resolveVaultPath,
  writeObsidianInboxEntries,
} from './worklog.js';
import type { Session, GitActivity, Parser } from './types.js';

let verbose = false;

function debug(msg: string): void {
  if (verbose) console.error(chalk.dim(`  [debug] ${msg}`));
}

/**
 * Resolve date string: supports YYYY-MM-DD, "today", "yesterday"
 */
function resolveDate(input: string | undefined): string {
  if (!input) return format(new Date(), 'yyyy-MM-dd');
  const lower = input.toLowerCase();
  if (lower === 'today') return format(new Date(), 'yyyy-MM-dd');
  if (lower === 'yesterday') return format(subDays(new Date(), 1), 'yyyy-MM-dd');
  return input;
}

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = parseISO(value);
  return isValid(parsed) && format(parsed, 'yyyy-MM-dd') === value;
}

const program = new Command();

program
  .name('devday')
  .description('End-of-day recap for AI-assisted coding sessions')
  .version('0.1.0')
  .option('-d, --date <date>', 'date: YYYY-MM-DD, "today", or "yesterday" (default: today)')
  .option('-s, --standup', 'output a short standup-ready summary')
  .option('-j, --json', 'output raw JSON')
  .option('-v, --verbose', 'show debug output')
  .option('--worklog', 'output detailed markdown worklog (no cost/token tables)')
  .option('--write-obsidian-inbox', 'write worklog markdown into Obsidian inbox')
  .option('--obsidian-vault <path>', 'Obsidian vault path (default: ~/obsidian-notebook)')
  .option('--worklog-title <title>', 'custom title for generated worklog note')
  .option('--session-summary-instructions <path>', 'markdown prompt file for session summaries (used in --worklog)')
  .option('--worklog-digest-max-chars <n>', 'max digest chars retained for worklog summaries (0 = no limit)')
  .option('--worklog-message-max-chars <n>', 'max chars retained per message in worklog digest (0 = no limit)')
  .option('--worklog-summary-chunk-chars <n>', 'chunk size for summarizing long session digests (0 = no chunking)')
  .option('--worklog-full-session-log', 'disable digest truncation for worklog summarization')
  .option('--no-git', 'skip git log integration')
  .option('--no-summarize', 'skip LLM summarization')
  .addHelpText('after', `
Examples:
  $ devday                    today's recap
  $ devday -d yesterday       yesterday's recap
  $ devday -d 2026-02-10      specific date
  $ devday --standup          short standup format
  $ devday --json             machine-readable output
  $ devday -d yesterday -s    yesterday's standup
  $ devday --worklog          detailed work log markdown
  $ devday --worklog --write-obsidian-inbox
  $ devday --worklog --session-summary-instructions ./prompts/worklog-session-summary.md
  $ devday --worklog --worklog-full-session-log
  $ devday --worklog --worklog-digest-max-chars 40000 --worklog-message-max-chars 2000

Environment variables:
  OPENAI_API_KEY              enables AI-powered summaries via OpenAI (recommended)
  ANTHROPIC_API_KEY           enables AI-powered summaries via Anthropic

Supported tools:
  opencode                    ~/.local/share/opencode/storage/
  claude code                 ~/.claude/
  cursor                      ~/Library/.../state.vscdb
  codex                       ~/.codex/sessions/
  copilot                     ~/.copilot/session-state/
`)
  .action(async (opts) => {
    verbose = opts.verbose ?? false;
    const date = resolveDate(opts.date);
    const config = loadConfig();
    const wantsWorklog = (opts.worklog ?? false) || (opts.writeObsidianInbox ?? false);
    applyWorklogDigestOptions(opts, wantsWorklog);

    // Validate date format
    if (!isValidDateString(date)) {
      console.error(chalk.red(`Invalid date format: "${opts.date}". Use YYYY-MM-DD, "today", or "yesterday".`));
      process.exit(1);
    }

    const isJson = opts.json ?? false;

    // ── First-run banner (skip for JSON output) ───────────────
    if (!isJson) {
      printBanner(config, date);
    }

    const spinner = ora({ text: 'Scanning sessions...', color: 'cyan' });
    if (!verbose && !isJson) spinner.start();

    try {
      // ── Initialize parsers ──────────────────────────────────
      const parsers: Parser[] = [];

      if (config.enabledTools.includes('opencode') && config.paths.opencodeStorage) {
        parsers.push(new OpenCodeParser(config.paths.opencodeStorage));
        debug(`opencode storage: ${config.paths.opencodeStorage}`);
      }

      if (config.enabledTools.includes('claude-code') && config.paths.claudeCodeHome) {
        parsers.push(new ClaudeCodeParser(config.paths.claudeCodeHome));
        debug(`claude code home: ${config.paths.claudeCodeHome}`);
      }

      if (config.enabledTools.includes('cursor') && config.paths.cursorStateDb) {
        parsers.push(new CursorParser(config.paths.cursorStateDb));
        debug(`cursor db: ${config.paths.cursorStateDb}`);
      }

      if (config.enabledTools.includes('codex') && config.paths.codexSessions) {
        parsers.push(new CodexParser(config.paths.codexSessions));
        debug(`codex sessions: ${config.paths.codexSessions}`);
      }

      if (config.enabledTools.includes('copilot') && config.paths.copilotSessionState) {
        parsers.push(new CopilotParser(config.paths.copilotSessionState));
        debug(`copilot session state: ${config.paths.copilotSessionState}`);
      }

      if (parsers.length === 0) {
        spinner.stop();
        printNoToolsMessage();
        return;
      }

      // ── Collect sessions ────────────────────────────────────
      const allSessions: Session[] = [];
      for (const parser of parsers) {
        if (await parser.isAvailable()) {
          spinner.text = `Reading ${parser.name} sessions...`;
          debug(`scanning ${parser.name}...`);
          const sessions = await parser.getSessions(date);
          debug(`  found ${sessions.length} session(s) from ${parser.name}`);
          allSessions.push(...sessions);
        } else {
          debug(`${parser.name} not available, skipping`);
        }
      }

      // ── Early exit if nothing found ─────────────────────────
      if (allSessions.length === 0) {
        spinner.stop();
        if (!isJson) {
          console.log(chalk.dim(`  No sessions found for ${date}.`));
          if (date === format(new Date(), 'yyyy-MM-dd')) {
            console.log(chalk.dim('  Try: devday -d yesterday'));
          }
          console.log('');
        } else {
          console.log(JSON.stringify({ date, projects: [], totalSessions: 0 }, null, 2));
        }
        return;
      }

      spinner.text = `Found ${allSessions.length} session(s). Checking git...`;

      // ── Collect git activity ────────────────────────────────
      const gitActivities: GitActivity[] = [];
      if (opts.git !== false) {
        const projectPaths = [...new Set(allSessions.map((s) => s.projectPath).filter(Boolean))] as string[];
        for (const projectPath of projectPaths) {
          debug(`checking git in ${projectPath}`);
          const git = getGitActivity(projectPath, date, config.gitAuthorFilter);
          if (git) {
            debug(`  ${git.commits.length} commit(s)`);
            gitActivities.push(git);
          }
        }
      }

      // ── Merge ───────────────────────────────────────────────
      let recap = buildDayRecap(date, allSessions, gitActivities);

      // ── Summarize (only if API key is available) ──────────
      const hasApiKey = config.preferredSummarizer !== 'none';

      if (!wantsWorklog && hasApiKey && opts.summarize !== false) {
        debug(`using ${config.preferredSummarizer} for summarization`);
        spinner.text = 'Generating summary...';
        recap = await summarizeRecap(recap, config);
      } else if (!hasApiKey && !wantsWorklog) {
        debug('no API key set, skipping summarization');
      }

      spinner.stop();

      if (wantsWorklog) {
        const sessionSummaries = await buildSessionSummaries(recap, config, {
          summarizeWithLlm: opts.summarize !== false,
          instructionsPath: opts.sessionSummaryInstructions,
          chunkChars: parseIntegerOption(opts.worklogSummaryChunkChars),
        });

        if (sessionSummaries.instructionsPath) {
          debug(`session summary instructions: ${sessionSummaries.instructionsPath}`);
        } else {
          debug('session summary instructions: built-in fallback');
        }

        const markdown = buildWorklogMarkdown(recap, sessionSummaries.summaries);

        if (opts.writeObsidianInbox) {
          const vaultPath = resolveVaultPath(opts.obsidianVault);
          const outputPaths = writeObsidianInboxEntries(recap, {
            vaultPath,
            cwd: process.cwd(),
            title: opts.worklogTitle,
            source: 'devday --worklog --write-obsidian-inbox',
            sessionSummaries: sessionSummaries.summaries,
          });

          if (isJson) {
            console.log(JSON.stringify({
              date,
              mode: 'worklog',
              outputPaths,
            }, null, 2));
          } else {
            console.log('');
            console.log(chalk.green(`  Wrote ${outputPaths.length} Obsidian session worklog note(s):`));
            for (const path of outputPaths) {
              console.log(chalk.dim(`    - ${path}`));
            }
            console.log('');
          }
          return;
        }

        if (isJson) {
          console.log(JSON.stringify({
            date,
            mode: 'worklog',
            markdown,
          }, null, 2));
        } else {
          console.log(markdown);
        }
        return;
      }

      // ── Standup without API key → exit early ────────────────
      if (opts.standup && !hasApiKey) {
        console.log('');
        console.log(chalk.yellow('  Standup requires an API key to generate summaries.'));
        console.log('');
        console.log('  Run:');
        console.log(chalk.cyan('    export OPENAI_API_KEY=sk-...'));
        console.log('');
        console.log('  Then try again:');
        console.log(chalk.cyan('    devday --standup'));
        console.log('');
        return;
      }

      // ── Render ──────────────────────────────────────────────
      renderRecap(recap, { standup: opts.standup, json: isJson });

      // Prompt to set API key if not configured
      if (!hasApiKey && !isJson) {
        console.log('');
        console.log('  To generate AI-powered summaries and standup messages:');
        console.log(chalk.cyan('    export OPENAI_API_KEY=sk-...'));
        console.log('');
      }
    } catch (error) {
      spinner.stop();
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      if (verbose && error instanceof Error && error.stack) {
        console.error(chalk.dim(error.stack));
      }
      process.exit(1);
    }
  });

program.parse();

// ── Helper functions ──────────────────────────────────────────────

function applyWorklogDigestOptions(
  opts: Record<string, unknown>,
  wantsWorklog: boolean,
): void {
  if (!wantsWorklog) return;

  const fullSessionLog = opts.worklogFullSessionLog === true;
  if (fullSessionLog) {
    process.env.DEVDAY_DIGEST_MAX_CHARS = '0';
    process.env.DEVDAY_DIGEST_MESSAGE_MAX_CHARS = '0';
    return;
  }

  const digestMaxChars = parseIntegerOption(opts.worklogDigestMaxChars);
  const messageMaxChars = parseIntegerOption(opts.worklogMessageMaxChars);

  if (digestMaxChars !== undefined) {
    process.env.DEVDAY_DIGEST_MAX_CHARS = String(digestMaxChars);
  }
  if (messageMaxChars !== undefined) {
    process.env.DEVDAY_DIGEST_MESSAGE_MAX_CHARS = String(messageMaxChars);
  }
}

function parseIntegerOption(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function printBanner(
  config: ReturnType<typeof loadConfig>,
  date: string,
): void {
  console.log('');
  console.log(chalk.bold.cyan('  devday') + chalk.dim(' v0.1.0'));
  console.log('');

  // Tools detected
  const tools: string[] = [];
  if (config.paths.opencodeStorage) tools.push(chalk.green('opencode'));
  if (config.paths.claudeCodeHome) tools.push(chalk.green('claude code'));
  if (config.paths.cursorStateDb) tools.push(chalk.green('cursor'));
  if (config.paths.codexSessions) tools.push(chalk.green('codex'));
  if (config.paths.copilotSessionState) tools.push(chalk.green('copilot'));
  if (tools.length > 0) {
    console.log(chalk.dim('  Tools: ') + tools.join(', '));
  } else {
    console.log(chalk.dim('  Tools: ') + chalk.yellow('none detected'));
  }

  // Summarizer status
  if (config.preferredSummarizer !== 'none') {
    console.log(chalk.dim('  Summaries: ') + chalk.green(config.preferredSummarizer));
  } else {
    console.log(chalk.dim('  Summaries: ') + chalk.yellow('not configured'));
  }

  console.log(chalk.dim(`  Date: ${date}`));
  console.log('');
}

function printNoToolsMessage(): void {
  const home = homedir();
  console.log('');
  console.log(chalk.yellow('  No AI coding tools detected.'));
  console.log('');
  console.log('  devday scans local conversations from these tools:');
  console.log('');
  console.log(`    ${chalk.cyan('opencode')}      ${chalk.dim(home + '/.local/share/opencode/storage/')}`);
    console.log(`    ${chalk.cyan('claude code')}    ${chalk.dim(home + '/.claude/')}`);
    console.log(`    ${chalk.cyan('cursor')}          ${chalk.dim('~/Library/.../state.vscdb')}`);
    console.log(`    ${chalk.cyan('codex')}           ${chalk.dim(home + '/.codex/sessions/')}`);
    console.log(`    ${chalk.cyan('copilot')}         ${chalk.dim(home + '/.copilot/session-state/')}`);
  console.log('');
  console.log('  Install a supported tool and start a coding session,');
  console.log('  then run ' + chalk.cyan('devday') + ' again.');
  console.log('');
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { DayRecap, ProjectSummary, Session } from './types.js';

interface ObsidianEntryOptions {
  vaultPath: string;
  cwd: string;
  title?: string;
  source?: string;
  agent?: string;
  now?: Date;
}

interface ObsidianEntry {
  filePath: string;
  content: string;
}

export function buildWorklogMarkdown(recap: DayRecap): string {
  const sessions = collectSessions(recap);
  const lines: string[] = [];

  lines.push(`# Devday Worklog (${recap.date})`);
  lines.push('');
  lines.push('## Local Context');
  lines.push(`- Date: ${recap.date}`);
  lines.push(`- Sessions captured: ${sessions.length}`);

  const projectPaths = [...new Set(recap.projects.map((p) => p.projectPath).filter(Boolean))] as string[];
  if (projectPaths.length > 0) {
    lines.push('- Repositories:');
    for (const path of projectPaths.sort()) {
      lines.push(`  - \`${path}\``);
    }
  }
  lines.push('');

  lines.push('## Work Completed');
  for (const project of recap.projects) {
    lines.push(...buildProjectSection(project));
  }

  const followUps = extractFollowUps(sessions);
  if (followUps.length > 0) {
    lines.push('');
    lines.push('## Follow-up');
    for (const item of followUps) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function buildObsidianInboxEntry(
  recap: DayRecap,
  worklogMarkdown: string,
  options: ObsidianEntryOptions,
): ObsidianEntry {
  const now = options.now ?? new Date();
  const melbourne = formatMelbourne(now);
  const title = options.title ?? `Devday worklog ${recap.date}`;
  const slug = slugify(title) || 'update';

  const filePath = join(
    options.vaultPath,
    'inbox',
    `${melbourne.fileStamp}-${slug}.md`,
  );

  const sessions = collectSessions(recap);
  const sessionIds = [...new Set(sessions.map((s) => s.id).filter(Boolean))];
  const links = [...new Set(recap.projects.map((p) => p.projectPath).filter(Boolean))] as string[];
  const agent = options.agent ?? 'devday';
  const source = options.source ?? 'devday --worklog';

  const frontmatter: string[] = [
    '---',
    `title: "${escapeYamlString(title)}"`,
    `created_at: "${melbourne.iso}"`,
    `agent: "${escapeYamlString(agent)}"`,
    `cwd: "${escapeYamlString(options.cwd)}"`,
    'type: "work-summary"',
    `date: "${recap.date}"`,
    `source: "${escapeYamlString(source)}"`,
    'tags: [squirl-inbox, work-summary, devday]',
  ];

  if (sessionIds.length === 1) {
    frontmatter.push(`session_id: "${escapeYamlString(sessionIds[0])}"`);
  }
  if (sessionIds.length > 0) {
    frontmatter.push('session_ids:');
    for (const id of sessionIds) {
      frontmatter.push(`  - "${escapeYamlString(id)}"`);
    }
  }
  if (links.length > 0) {
    frontmatter.push('links:');
    for (const link of links) {
      frontmatter.push(`  - "${escapeYamlString(link)}"`);
    }
  }
  frontmatter.push('---');

  const content = frontmatter.join('\n') + '\n\n' + worklogMarkdown.trim() + '\n';

  return { filePath, content };
}

export function writeObsidianInboxEntry(
  recap: DayRecap,
  worklogMarkdown: string,
  options: ObsidianEntryOptions,
): string {
  const entry = buildObsidianInboxEntry(recap, worklogMarkdown, options);
  mkdirSync(dirname(entry.filePath), { recursive: true });
  writeFileSync(entry.filePath, entry.content, 'utf-8');
  return entry.filePath;
}

export function resolveVaultPath(input: string | undefined): string {
  if (!input || !input.trim()) {
    return join(homedir(), 'obsidian-notebook');
  }

  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function buildProjectSection(project: ProjectSummary): string[] {
  const lines: string[] = [];
  lines.push(`### ${project.projectName}`);

  const sessions = [...project.sessions].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  for (const session of sessions) {
    const title = session.title ?? 'Untitled session';
    lines.push(`- ${title} [${session.tool}]`);
    lines.push(`  - Session ID: \`${session.id}\``);
    lines.push(`  - Time: ${formatLocalClock(session.startedAt)} - ${formatLocalClock(session.endedAt)} (${formatDuration(session.durationMs)})`);

    const actions = cleanList(session.toolCallSummaries, 8, 120);
    if (actions.length > 0) {
      lines.push(`  - Key actions: ${actions.join('; ')}`);
    }

    const files = formatFiles(session.filesTouched, project.projectPath);
    if (files.length > 0) {
      lines.push(`  - Files touched: ${files.join(', ')}`);
    }
  }

  if (project.git && project.git.commits.length > 0) {
    lines.push('- Git commits:');
    for (const commit of project.git.commits.slice(0, 8)) {
      lines.push(`  - ${commit.shortHash} ${commit.message}`);
    }
  }

  return lines;
}

function formatFiles(files: string[], projectPath: string): string[] {
  const unique = [...new Set(files)].filter(Boolean).slice(0, 8);
  return unique.map((filePath) => {
    if (projectPath && filePath.startsWith(projectPath)) {
      const rel = relative(projectPath, filePath);
      return rel || '.';
    }
    return shortenHome(filePath);
  });
}

function cleanList(items: string[], maxItems: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of items) {
    const clean = item.replace(/\s+/g, ' ').trim();
    if (!clean) continue;

    const shortened = clean.length > maxLen ? clean.slice(0, maxLen - 3) + '...' : clean;
    if (seen.has(shortened)) continue;

    seen.add(shortened);
    out.push(shortened);
    if (out.length >= maxItems) break;
  }

  return out;
}

function extractFollowUps(sessions: Session[]): string[] {
  const followUps: string[] = [];

  for (const session of sessions) {
    const lastUser = extractLastUserMessage(session.conversationDigest);
    if (!lastUser) continue;

    const summary = lastUser.replace(/\s+/g, ' ').trim();
    if (!summary) continue;

    const truncated = summary.length > 140 ? summary.slice(0, 137) + '...' : summary;
    followUps.push(`${session.projectName ?? 'Unknown project'}: ${truncated}`);
  }

  return [...new Set(followUps)].slice(0, 6);
}

function extractLastUserMessage(digest: string): string | null {
  if (!digest) return null;
  const regex = /\[User\]:\s*([\s\S]*?)(?=\n\n\[(?:User|Assistant)\]:|$)/g;

  let match: RegExpExecArray | null = null;
  let last: string | null = null;
  while ((match = regex.exec(digest)) !== null) {
    if (match[1]) last = match[1];
  }

  return last;
}

function collectSessions(recap: DayRecap): Session[] {
  return recap.projects.flatMap((project) => project.sessions);
}

function formatLocalClock(date: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function shortenHome(pathValue: string): string {
  const home = homedir();
  if (pathValue.startsWith(home)) {
    return '~' + pathValue.slice(home.length);
  }
  return pathValue;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatMelbourne(date: Date): { iso: string; fileStamp: string } {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Melbourne',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);

  const year = part(dateParts, 'year');
  const month = part(dateParts, 'month');
  const day = part(dateParts, 'day');
  const hour = part(timeParts, 'hour');
  const minute = part(timeParts, 'minute');
  const second = part(timeParts, 'second');
  const rawOffset = part(offsetParts, 'timeZoneName');
  const offset = normalizeOffset(rawOffset);

  return {
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`,
    fileStamp: `${year}-${month}-${day}-${hour}${minute}${second}`,
  };
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

function normalizeOffset(rawOffset: string): string {
  // Expected shape from Intl: "GMT+11" or "GMT+10:30"
  const cleaned = rawOffset.replace('GMT', '');
  if (!cleaned) return '+00:00';

  const sign = cleaned.startsWith('-') ? '-' : '+';
  const body = cleaned.replace(/^[-+]/, '');
  if (body.includes(':')) {
    const [h, m] = body.split(':');
    return `${sign}${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  return `${sign}${body.padStart(2, '0')}:00`;
}

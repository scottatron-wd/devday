import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { isDigestTruncated } from './parsers/digest.js';
import type { DayRecap, DevDayConfig, ProjectSummary, Session } from './types.js';

interface SessionContext {
  project: ProjectSummary;
  session: Session;
}

interface ObsidianEntryOptions {
  vaultPath: string;
  cwd: string;
  title?: string;
  source?: string;
  agent?: string;
  now?: Date;
  sessionSummaries?: Map<string, string>;
}

interface SessionSummaryOptions {
  summarizeWithLlm?: boolean;
  instructionsPath?: string;
  chunkChars?: number;
}

interface ObsidianEntry {
  filePath: string;
  content: string;
}

interface SessionSummaryInstructions {
  text: string;
  path: string | null;
}

interface SessionSummaryResult {
  summaries: Map<string, string>;
  instructionsPath: string | null;
}

const LLM_TIMEOUT_MS = 25_000;
const DEFAULT_SUMMARY_CHUNK_CHARS = 7_500;
const MAX_SUMMARY_CHUNKS = 12;

const DEFAULT_SESSION_SUMMARY_INSTRUCTIONS = `# Devday Session Summary Instructions

You are summarizing one coding session from a developer worklog.

## Output style
- Write in a conversational first-person plural style using "we".
- Prefer 1-3 short paragraphs that describe progression across the full session.
- You may add headings only if they improve clarity.

## Focus
- Emphasize outcomes, decisions, and technical changes.
- Explain how the session progressed from start to finish (early, middle, and late phases).
- Group related work into coherent phases/workstreams when useful.
- Prefer completed outcomes over attempted but unfinished actions.
- Call out noteworthy challenges, tradeoffs, or discoveries where relevant.
- Mention concrete files/systems if useful.
- Include concrete identifiers when available (for example commit SHAs, PR numbers, build IDs, refresh IDs).
- Mention unresolved decisions or risks only when they materially affect next steps.

## Avoid
- Token/cost/model/provider details.
- Forced templates or strict bullet-only output.
- Long verbatim transcript quotes.
- Invented identifiers or unsupported claims.
`;

export async function buildSessionSummaries(
  recap: DayRecap,
  config: DevDayConfig,
  options: SessionSummaryOptions = {},
): Promise<SessionSummaryResult> {
  const contexts = collectSessionContexts(recap);
  const summaries = new Map<string, string>();

  const shouldUseLlm =
    options.summarizeWithLlm !== false &&
    config.preferredSummarizer !== 'none';

  const instructions = loadSessionSummaryInstructions(options.instructionsPath);

  for (const ctx of contexts) {
    let summary = buildFallbackSessionSummary(ctx.session, ctx.project);

    if (shouldUseLlm) {
      const llmSummary = await summarizeSessionWithLlm(
        ctx.project,
        ctx.session,
        config,
        instructions.text,
        options,
      );
      if (llmSummary) summary = llmSummary;
    }

    summaries.set(ctx.session.id, summary);
  }

  return {
    summaries,
    instructionsPath: instructions.path,
  };
}

export function loadSessionSummaryInstructions(inputPath: string | undefined): SessionSummaryInstructions {
  const candidates: string[] = [];

  if (inputPath && inputPath.trim()) {
    candidates.push(expandHome(inputPath.trim()));
  } else {
    candidates.push(join(process.cwd(), 'prompts', 'worklog-session-summary.md'));
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf-8').trim();
      if (text) return { text, path };
    } catch {
      continue;
    }
  }

  return { text: DEFAULT_SESSION_SUMMARY_INSTRUCTIONS, path: null };
}

export function buildWorklogMarkdown(
  recap: DayRecap,
  sessionSummaries: Map<string, string> = new Map(),
): string {
  const lines: string[] = [];

  lines.push(`# Devday Worklog (${recap.date})`);
  lines.push('');

  for (const project of recap.projects) {
    lines.push(...buildProjectSection(project, sessionSummaries));
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function buildObsidianInboxEntries(
  recap: DayRecap,
  options: ObsidianEntryOptions,
): ObsidianEntry[] {
  const now = options.now ?? new Date();
  const contexts = collectSessionContexts(recap);
  const source = options.source ?? 'devday --worklog --write-obsidian-inbox';
  const toolName = options.agent ?? 'devday';

  return contexts.map((ctx, index) => {
    const { project, session } = ctx;
    const defaultTitle = `${project.projectName}: ${session.title ?? 'Session worklog'}`;
    const title = options.title ?? defaultTitle;
    const slug = slugify(title) || 'update';
    const shortId = session.id.slice(0, 8);
    const startedStamp = formatMelbourne(session.startedAt).fileStamp;
    const cwd = session.projectPath ?? options.cwd;

    const filePath = join(
      options.vaultPath,
      'inbox',
      `${startedStamp}-${slug}-${shortId}-${index + 1}.md`,
    );

    const frontmatter: string[] = [
      '---',
      `title: "${escapeYamlString(title)}"`,
      `created_at: "${formatMelbourne(now).iso}"`,
      `agent: "${escapeYamlString(session.tool)}"`,
      `cwd: "${escapeYamlString(cwd)}"`,
      'type: "work-summary"',
      `date: "${recap.date}"`,
      `project: "${escapeYamlString(project.projectName)}"`,
      `tool: "${escapeYamlString(toolName)}"`,
      `source: "${escapeYamlString(source)}"`,
      'tags: [squirl-inbox, work-summary, devday]',
      `session_id: "${escapeYamlString(session.id)}"`,
      'links:',
    ];

    if (session.projectPath) {
      frontmatter.push(`  - "${escapeYamlString(session.projectPath)}"`);
    }
    for (const file of session.filesTouched.slice(0, 8)) {
      frontmatter.push(`  - "${escapeYamlString(file)}"`);
    }
    frontmatter.push('---');

    const markdown = buildSingleSessionMarkdown(project, session, options.sessionSummaries);
    const content = frontmatter.join('\n') + '\n\n' + markdown.trim() + '\n';

    return { filePath, content };
  });
}

export function writeObsidianInboxEntries(
  recap: DayRecap,
  options: ObsidianEntryOptions,
): string[] {
  const entries = buildObsidianInboxEntries(recap, options);
  const outputPaths: string[] = [];

  for (const entry of entries) {
    mkdirSync(dirname(entry.filePath), { recursive: true });
    writeFileSync(entry.filePath, entry.content, 'utf-8');
    outputPaths.push(entry.filePath);
  }

  return outputPaths;
}

export function resolveVaultPath(input: string | undefined): string {
  if (!input || !input.trim()) {
    return join(homedir(), 'obsidian-notebook');
  }

  return expandHome(input.trim());
}

function buildSingleSessionMarkdown(
  project: ProjectSummary,
  session: Session,
  sessionSummaries?: Map<string, string>,
): string {
  const summary = sessionSummaries?.get(session.id) ?? buildFallbackSessionSummary(session, project);
  const toolsUsed = extractToolNames(session);
  const skillsUsed = extractSkillNames(session);
  const files = formatFiles(session.filesTouched, project.projectPath);
  const heading = buildSessionHeadingTitle(session);

  const lines: string[] = [];
  lines.push(`# ${project.projectName}: ${heading}`);
  lines.push('');
  lines.push(`Session: \`${session.id}\`  |  ${formatLocalClock(session.startedAt)} - ${formatLocalClock(session.endedAt)} (${formatDuration(session.durationMs)})`);
  lines.push('');
  lines.push(summary.trim());

  if (toolsUsed.length > 0) {
    lines.push('');
    lines.push('## Tools Used');
    for (const tool of toolsUsed) {
      lines.push(`- ${tool}`);
    }
  }

  if (skillsUsed.length > 0) {
    lines.push('');
    lines.push('## Skills Used');
    for (const skill of skillsUsed) {
      lines.push(`- ${skill}`);
    }
  }

  if (files.length > 0) {
    lines.push('');
    lines.push('## Files Touched');
    for (const file of files) {
      lines.push(`- ${file}`);
    }
  }

  return lines.join('\n');
}

function buildProjectSection(
  project: ProjectSummary,
  sessionSummaries: Map<string, string>,
): string[] {
  const lines: string[] = [];
  lines.push(`## ${project.projectName}`);

  const sessions = [...project.sessions].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );

  for (const session of sessions) {
    const summary = sessionSummaries.get(session.id) ?? buildFallbackSessionSummary(session, project);
    const toolsUsed = extractToolNames(session);
    const skillsUsed = extractSkillNames(session);
    const files = formatFiles(session.filesTouched, project.projectPath);

    lines.push('');
    lines.push(`### ${session.title ?? 'Untitled session'} (${session.tool})`);
    lines.push(`Session ID: \`${session.id}\``);
    lines.push(`Time: ${formatLocalClock(session.startedAt)} - ${formatLocalClock(session.endedAt)} (${formatDuration(session.durationMs)})`);
    lines.push('');
    lines.push(summary.trim());

    if (toolsUsed.length > 0) {
      lines.push('');
      lines.push(`Tools used: ${toolsUsed.join(', ')}`);
    }
    if (skillsUsed.length > 0) {
      lines.push(`Skills used: ${skillsUsed.join(', ')}`);
    }
    if (files.length > 0) {
      lines.push(`Files touched: ${files.join(', ')}`);
    }
  }

  if (project.git && project.git.commits.length > 0) {
    lines.push('');
    lines.push('Git commits:');
    for (const commit of project.git.commits.slice(0, 8)) {
      lines.push(`- ${commit.shortHash} ${commit.message}`);
    }
  }

  lines.push('');
  return lines;
}

function buildFallbackSessionSummary(session: Session, project: ProjectSummary): string {
  const firstUser = extractFirstUserMessage(session.conversationDigest);
  const lastAssistant = extractLastAssistantMessage(session.conversationDigest);
  const files = formatFiles(session.filesTouched, project.projectPath).slice(0, 5);
  const tools = extractToolNames(session).slice(0, 4);

  const chunks: string[] = [];
  chunks.push(`In this session we worked on ${session.title ?? `a ${session.tool} task`} in ${project.projectName}.`);

  if (firstUser) {
    chunks.push(`We started by focusing on ${truncateSentence(firstUser, 180)}.`);
    if (looksLikeChallenge(firstUser)) {
      chunks.push('A key part of the session was working through that challenge to keep momentum.');
    }
  }

  if (tools.length > 0) {
    chunks.push(`As the work progressed, we relied on ${tools.join(', ')} to move the task forward.`);
  }

  if (lastAssistant) {
    chunks.push(`By the end, we had reached a stable outcome: ${truncateSentence(lastAssistant, 180)}.`);
  }

  if (files.length > 0) {
    chunks.push(`The most relevant files we touched were ${files.join(', ')}.`);
  }

  return chunks.join(' ');
}

function looksLikeChallenge(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('issue') ||
    normalized.includes('error') ||
    normalized.includes('fail') ||
    normalized.includes('problem') ||
    normalized.includes('challenge') ||
    normalized.includes('debug')
  );
}

async function summarizeSessionWithLlm(
  project: ProjectSummary,
  session: Session,
  config: DevDayConfig,
  instructions: string,
  options: SessionSummaryOptions,
): Promise<string | null> {
  const digest = session.conversationDigest || 'No transcript text available.';
  const chunkChars = resolveSummaryChunkChars(options.chunkChars);
  const prompt = buildSessionPrompt(project, session, instructions, digest);

  if (digest.length <= chunkChars) {
    return callSummarizer(config, prompt);
  }

  const digestChunks = splitDigestIntoChunks(digest, chunkChars, MAX_SUMMARY_CHUNKS);
  const chunkSummaries: string[] = [];

  for (let index = 0; index < digestChunks.length; index++) {
    const chunkPrompt = buildChunkSummaryPrompt(
      project,
      session,
      instructions,
      digestChunks[index],
      index + 1,
      digestChunks.length,
    );
    const chunkSummary = await callSummarizer(config, chunkPrompt);
    if (chunkSummary) chunkSummaries.push(chunkSummary);
  }

  if (chunkSummaries.length === 0) {
    return callSummarizer(config, prompt);
  }

  const synthesisPrompt = buildChunkSynthesisPrompt(
    project,
    session,
    instructions,
    chunkSummaries,
    digestChunks.length,
  );
  const synthesized = await callSummarizer(config, synthesisPrompt);
  if (synthesized) return synthesized;

  return chunkSummaries.join('\n\n');
}

function buildSessionPrompt(
  project: ProjectSummary,
  session: Session,
  instructions: string,
  digest: string,
): string {
  const context = buildSessionContextBlock(project, session, digest);
  const toolTimeline = formatToolTimeline(session.toolCallSummaries);

  return `${instructions}

## Session Context
${context}

## Tool Activity Timeline
${toolTimeline}

## Conversation digest
${digest}
`;
}

function buildChunkSummaryPrompt(
  project: ProjectSummary,
  session: Session,
  instructions: string,
  chunk: string,
  chunkIndex: number,
  totalChunks: number,
): string {
  const context = buildSessionContextBlock(project, session, chunk);

  return `${instructions}

You are summarizing chunk ${chunkIndex} of ${totalChunks} from one long session.
Focus only on what happened in this chunk and keep it concise.

## Session Context
${context}

## Digest chunk (${chunkIndex}/${totalChunks})
${chunk}
`;
}

function buildChunkSynthesisPrompt(
  project: ProjectSummary,
  session: Session,
  instructions: string,
  chunkSummaries: string[],
  totalChunks: number,
): string {
  const digest = session.conversationDigest || 'No transcript text available.';
  const context = buildSessionContextBlock(project, session, digest);

  const numberedSummaries = chunkSummaries
    .map((summary, index) => `Chunk ${index + 1}:\n${summary}`)
    .join('\n\n');

  return `${instructions}

Synthesize these ${totalChunks} chunk summaries into one cohesive session summary.
Ensure the final writeup covers the overall progression from early work to final outcomes.

## Session Context
${context}

## Chunk Summaries
${numberedSummaries}
`;
}

function buildSessionContextBlock(
  project: ProjectSummary,
  session: Session,
  digest: string,
): string {
  const files = formatFiles(session.filesTouched, project.projectPath).join(', ') || 'None';
  const toolsUsed = extractToolNames(session).join(', ') || 'None';
  const skillsUsed = extractSkillNames(session).join(', ') || 'None';
  const nativeSummary = session.summary?.trim() || 'None';
  const digestTruncated = isDigestTruncated(digest) ? 'yes' : 'no';
  const evidenceSignals = extractEvidenceSignals(session);

  return [
    `- Project: ${project.projectName}`,
    `- Session title: ${session.title ?? 'Untitled'}`,
    `- Agent: ${session.tool}`,
    `- Start: ${session.startedAt.toISOString()}`,
    `- End: ${session.endedAt.toISOString()}`,
    `- Message counts: ${session.messageCount} total (${session.userMessageCount} user, ${session.assistantMessageCount} assistant)`,
    `- Native session summary: ${nativeSummary}`,
    `- Transcript truncated: ${digestTruncated}`,
    `- Files touched: ${files}`,
    `- Tools used: ${toolsUsed}`,
    `- Skills used: ${skillsUsed}`,
    `- Evidence signals: ${evidenceSignals}`,
  ].join('\n');
}

async function callSummarizer(
  config: DevDayConfig,
  prompt: string,
): Promise<string | null> {
  if (config.preferredSummarizer === 'anthropic' && config.anthropicApiKey) {
    return callAnthropic(config.anthropicApiKey, prompt);
  }
  if (config.preferredSummarizer === 'openai' && config.openaiApiKey) {
    return callOpenAI(config.openaiApiKey, prompt);
  }
  return null;
}

async function callAnthropic(apiKey: string, prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 280,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) return null;

    const data: unknown = await res.json();
    const content = (data as Record<string, unknown>)?.content;
    if (!Array.isArray(content) || content.length === 0) return null;

    const first = content[0] as Record<string, unknown>;
    const text = typeof first?.text === 'string' ? first.text : null;
    return text ? normalizeSummary(text) : null;
  } catch {
    return null;
  }
}

async function callOpenAI(apiKey: string, prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 280,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) return null;

    const data: unknown = await res.json();
    const choices = (data as Record<string, unknown>)?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;

    const first = choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    const text = typeof message?.content === 'string' ? message.content : null;
    return text ? normalizeSummary(text) : null;
  } catch {
    return null;
  }
}

function normalizeSummary(text: string): string {
  const cleaned = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  return cleaned || 'We completed focused development work in this session.';
}

function resolveSummaryChunkChars(input: number | undefined): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input <= 0) return Number.MAX_SAFE_INTEGER;
    return Math.floor(input);
  }

  const fromEnv = process.env.DEVDAY_SESSION_SUMMARY_CHUNK_CHARS;
  if (!fromEnv) return DEFAULT_SUMMARY_CHUNK_CHARS;

  const parsed = Number.parseInt(fromEnv, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SUMMARY_CHUNK_CHARS;
  if (parsed <= 0) return Number.MAX_SAFE_INTEGER;
  return parsed;
}

function splitDigestIntoChunks(
  digest: string,
  targetChars: number,
  maxChunks: number,
): string[] {
  if (digest.length <= targetChars) return [digest];

  const entries = digest
    .split(/\n\n(?=\[(?:User|Assistant)\]:)/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return [digest];

  const chunks: string[] = [];
  let current = '';

  for (const entry of entries) {
    const candidate = current ? `${current}\n\n${entry}` : entry;
    if (candidate.length > targetChars && current) {
      chunks.push(current);
      current = entry;
      continue;
    }
    current = candidate;
  }

  if (current) chunks.push(current);
  if (chunks.length <= maxChunks) return chunks;

  return rebalanceChunks(chunks, maxChunks);
}

function rebalanceChunks(chunks: string[], maxChunks: number): string[] {
  if (chunks.length <= maxChunks) return chunks;

  const grouped: string[] = [];
  const groupSize = Math.ceil(chunks.length / maxChunks);

  for (let index = 0; index < chunks.length; index += groupSize) {
    grouped.push(chunks.slice(index, index + groupSize).join('\n\n'));
  }

  return grouped;
}

function extractEvidenceSignals(session: Session): string {
  const source = `${session.conversationDigest}\n${session.toolCallSummaries.join('\n')}`;
  const values: string[] = [];
  const seen = new Set<string>();

  const add = (value: string): void => {
    const clean = value.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    values.push(clean);
  };

  for (const match of source.matchAll(/\b(?:commit\s+)?([0-9a-f]{7,12})\b/gi)) {
    add(`commit ${match[1]}`);
  }
  for (const match of source.matchAll(/\bPR\s*#\s*(\d+)\b/gi)) {
    add(`PR #${match[1]}`);
  }
  for (const match of source.matchAll(/\bbuild\s*#?\s*(\d+)\b/gi)) {
    add(`build ${match[1]}`);
  }
  for (const match of source.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
    add(`id ${match[0]}`);
  }

  return values.slice(0, 12).join(', ') || 'None';
}

function buildSessionHeadingTitle(session: Session): string {
  const candidates = [
    session.title,
    session.summary,
    extractFirstUserMessage(session.conversationDigest),
    extractLastAssistantMessage(session.conversationDigest),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const friendly = toFriendlyHeading(candidate);
    if (friendly) return friendly;
  }

  return `Work session (${session.tool})`;
}

function toFriendlyHeading(value: string): string {
  let clean = sanitizeTranscriptMessage(value)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const prefixPatterns = [
    /^(please|kindly)\s+/i,
    /^(can you|could you|would you|will you)\s+/i,
    /^(let's|lets)\s+/i,
    /^(i need to|we need to)\s+/i,
  ];

  let updated = true;
  while (updated) {
    updated = false;
    for (const pattern of prefixPatterns) {
      const next = clean.replace(pattern, '');
      if (next !== clean) {
        clean = next.trimStart();
        updated = true;
      }
    }
  }

  clean = clean.replace(/[.?!:;]+$/g, '').trim();

  if (!clean) return '';
  const capped = truncateSentence(clean, 90);
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function formatToolTimeline(toolCallSummaries: string[]): string {
  const entries = toolCallSummaries
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => truncateSentence(value, 200));

  if (entries.length === 0) return 'None';

  const limit = 36;
  const sampled = entries.length > limit
    ? [...entries.slice(0, 18), ...entries.slice(-18)]
    : entries;
  const omitted = entries.length - sampled.length;

  const lines = sampled.map((entry, index) => `${index + 1}. ${entry}`);
  if (omitted > 0) {
    lines.push(`... (${omitted} additional tool events omitted from the middle)`);
  }

  return lines.join('\n');
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

function extractToolNames(session: Session): string[] {
  const names = new Set<string>();

  for (const summary of session.toolCallSummaries) {
    const clean = summary.trim();
    if (!clean) continue;

    let tool = clean;
    if (tool.startsWith('bash:')) {
      tool = 'bash';
    } else if (tool.includes(':')) {
      tool = tool.split(':')[0];
    } else {
      tool = tool.split(/\s+/)[0];
    }

    tool = tool.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!tool) continue;
    names.add(tool);
    if (names.size >= 12) break;
  }

  return [...names];
}

function extractSkillNames(session: Session): string[] {
  const names = new Set<string>();
  const text = session.conversationDigest;
  if (!text) return [];

  const dollarPattern = /\$([a-z][a-z0-9-]+)/g;
  let match: RegExpExecArray | null = null;
  while ((match = dollarPattern.exec(text)) !== null) {
    const candidate = match[1].toLowerCase();
    if (!isIgnoredSkillName(candidate)) names.add(candidate);
  }

  const slashPattern = /(?:^|\n)\s*\/([a-z][a-z0-9-]+)/gm;
  while ((match = slashPattern.exec(text)) !== null) {
    const candidate = match[1].toLowerCase();
    if (candidate.length >= 3 && !isIgnoredSkillName(candidate)) names.add(candidate);
  }

  return [...names].slice(0, 8);
}

function isIgnoredSkillName(value: string): boolean {
  const ignored = new Set([
    'users',
    'tmp',
    'var',
    'src',
    'github',
    'com',
    'home',
    'local',
    'workspace',
    'environment',
    'codex-thread-id',
  ]);
  return ignored.has(value);
}

function extractFirstUserMessage(digest: string): string | null {
  return extractMessageByRole(digest, 'User', 'first');
}

function extractLastAssistantMessage(digest: string): string | null {
  return extractMessageByRole(digest, 'Assistant', 'last');
}

function extractMessageByRole(
  digest: string,
  role: 'User' | 'Assistant',
  which: 'first' | 'last',
): string | null {
  if (!digest) return null;

  const regex = new RegExp(`\\[${role}\\]:\\s*([\\s\\S]*?)(?=\\n\\n\\[(?:User|Assistant)\\]:|$)`, 'g');
  const matches: string[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(digest)) !== null) {
    const sanitized = sanitizeTranscriptMessage(match[1] ?? '');
    if (sanitized) matches.push(sanitized);
  }

  if (matches.length === 0) return null;
  return which === 'first' ? matches[0] : matches[matches.length - 1];
}

function sanitizeTranscriptMessage(text: string): string {
  let out = text;

  out = out.replace(/#\s*AGENTS\.md instructions[\s\S]*?(?=<environment_context>|<\/environment_context>|$)/gi, ' ');
  out = out.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, ' ');
  out = out.replace(/<INSTRUCTIONS>[\s\S]*$/gi, ' ');
  out = out.replace(/<\/?INSTRUCTIONS>/gi, ' ');
  out = out.replace(/#\s*AGENTS\.md instructions[\s\S]*?(?=\n\n|$)/gi, ' ');
  out = out.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ');
  out = out.replace(/<instructions>[\s\S]*?<\/instructions>/gi, ' ');
  out = out.replace(/<skill>[\s\S]*?<\/skill>/gi, ' ');
  out = out.replace(/<agent_instructions>[\s\S]*?<\/agent_instructions>/gi, ' ');
  out = out.replace(/##\s*Commit Trailer Policy[\s\S]*?(?=\n##|\n#|$)/gi, ' ');
  out = out.replace(/Co-authored-by:[^\n]*/gi, ' ');
  out = out.replace(/Session-ID:[^\n]*/gi, ' ');
  out = out.replace(/```[\s\S]*?```/g, ' ');

  out = out.replace(/\s+/g, ' ').trim();
  return out || '';
}

function collectSessionContexts(recap: DayRecap): SessionContext[] {
  const contexts: SessionContext[] = [];

  for (const project of recap.projects) {
    const sortedSessions = [...project.sessions].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
    for (const session of sortedSessions) {
      contexts.push({ project, session });
    }
  }

  return contexts;
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

function truncateSentence(value: string, maxLen: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + '...';
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

function expandHome(pathValue: string): string {
  if (pathValue === '~') return homedir();
  if (pathValue.startsWith('~/')) return join(homedir(), pathValue.slice(2));
  return pathValue;
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

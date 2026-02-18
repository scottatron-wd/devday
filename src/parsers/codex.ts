import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { Parser, Session } from '../types.js';
import { estimateCost, emptyTokenUsage } from '../cost.js';
import { truncateConversationDigest } from './digest.js';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export class CodexParser implements Parser {
  readonly name = 'codex' as const;
  private sessionsRoot: string;
  private home = homedir();

  constructor(sessionsRoot: string) {
    this.sessionsRoot = sessionsRoot;
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.sessionsRoot);
  }

  async getSessions(date: string): Promise<Session[]> {
    const [year, month, day] = date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    const files = this.findSessionFiles(this.sessionsRoot);
    const sessions: Session[] = [];

    for (const filePath of files) {
      const session = this.parseSessionFile(filePath, dayStartMs, dayEndMs);
      if (session) sessions.push(session);
    }

    return sessions;
  }

  private findSessionFiles(root: string): string[] {
    if (!existsSync(root)) return [];

    const files: string[] = [];
    const stack = [root];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  private parseSessionFile(
    filePath: string,
    dayStartMs: number,
    dayEndMs: number,
  ): Session | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const MAX_EVENT_GAP_MS = 5 * 60 * 1000;

    let sessionId = basename(filePath, '.jsonl');
    let projectPath: string | null = null;
    let projectName: string | null = null;
    let title: string | null = null;

    let userMessageCount = 0;
    let assistantMessageCount = 0;
    const models = new Set<string>();
    const tokens = emptyTokenUsage();

    const filesTouched = new Set<string>();
    const toolCallSummaries: string[] = [];
    const digestParts: string[] = [];
    const activityTimestamps: number[] = [];
    let sawStructuredMessages = false;

    let dayEarliest = Infinity;
    let dayLatest = -Infinity;

    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      let parsed: CodexLine;
      try {
        parsed = JSON.parse(line) as CodexLine;
      } catch {
        continue;
      }

      const ts = this.extractTimestampMs(parsed);
      const inDay = ts !== null && ts >= dayStartMs && ts <= dayEndMs;

      if (parsed.type === 'session_meta') {
        const payload = this.asRecord(parsed.payload);
        if (payload) {
          if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
          if (typeof payload.cwd === 'string' && payload.cwd) {
            projectPath = payload.cwd;
            projectName = basename(projectPath);
          }
        }
      }

      if (!inDay) continue;

      dayEarliest = Math.min(dayEarliest, ts);
      dayLatest = Math.max(dayLatest, ts);

      if (parsed.type === 'turn_context') {
        const payload = this.asRecord(parsed.payload);
        if (payload && typeof payload.model === 'string' && payload.model) {
          models.add(payload.model);
        }
        continue;
      }

      if (parsed.type === 'event_msg') {
        const payload = this.asRecord(parsed.payload);
        if (!payload) continue;

        const eventType = this.stringOrNull(payload.type);
        if (eventType === 'token_count') {
          this.addTokenUsage(tokens, payload);
        } else if (!sawStructuredMessages && eventType === 'user_message') {
          const text = this.stringOrNull(payload.message);
          if (text) {
            userMessageCount += 1;
            activityTimestamps.push(ts);
            digestParts.push(`[User]: ${this.truncateText(text)}`);
            if (!title && !this.looksLikeSystemEnvelope(text)) {
              title = this.truncatePrompt(text);
            }
          }
        } else if (!sawStructuredMessages && (eventType === 'agent_message' || eventType === 'assistant_message')) {
          const text = this.stringOrNull(payload.message) ?? this.stringOrNull(payload.text);
          if (text) {
            assistantMessageCount += 1;
            activityTimestamps.push(ts);
            digestParts.push(`[Assistant]: ${this.truncateText(text)}`);
          }
        }
        continue;
      }

      if (parsed.type !== 'response_item') continue;

      const payload = this.asRecord(parsed.payload);
      if (!payload) continue;

      const itemType = this.stringOrNull(payload.type);
      if (itemType === 'message') {
        sawStructuredMessages = true;
        const role = this.stringOrNull(payload.role);
        const text = this.extractMessageText(payload.content);
        if (!role || !text) continue;

        activityTimestamps.push(ts);

        if (role === 'user') {
          userMessageCount += 1;
          digestParts.push(`[User]: ${this.truncateText(text)}`);
          if (!title && !this.looksLikeSystemEnvelope(text)) {
            title = this.truncatePrompt(text);
          }
        } else if (role === 'assistant') {
          assistantMessageCount += 1;
          digestParts.push(`[Assistant]: ${this.truncateText(text)}`);
        }
      } else if (itemType === 'function_call') {
        const summary = this.summarizeToolCall(
          this.stringOrNull(payload.name),
          payload.arguments,
          filesTouched,
        );
        if (summary) {
          toolCallSummaries.push(summary);
          activityTimestamps.push(ts);
        }
      } else if (itemType === 'custom_tool_call') {
        const summary = this.summarizeToolCall(
          this.stringOrNull(payload.name),
          payload.input,
          filesTouched,
        );
        if (summary) {
          toolCallSummaries.push(summary);
          activityTimestamps.push(ts);
        }
      }
    }

    if (!isFinite(dayEarliest) || dayLatest === -Infinity) return null;

    tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;

    let durationMs = 0;
    const sortedActivity = [...activityTimestamps].sort((a, b) => a - b);
    for (let i = 1; i < sortedActivity.length; i++) {
      const gap = sortedActivity[i] - sortedActivity[i - 1];
      if (gap > 0) durationMs += Math.min(gap, MAX_EVENT_GAP_MS);
    }

    let costUsd = 0;
    if (tokens.total > 0 && models.size > 0) {
      costUsd = estimateCost([...models][0], tokens);
    }

    const conversationDigest = truncateConversationDigest(digestParts.join('\n\n'));

    return {
      id: sessionId,
      tool: 'codex',
      projectPath,
      projectName,
      title: title ?? null,
      startedAt: new Date(Math.max(dayStartMs, dayEarliest)),
      endedAt: new Date(Math.min(dayEndMs, dayLatest)),
      durationMs,
      messageCount: userMessageCount + assistantMessageCount,
      userMessageCount,
      assistantMessageCount,
      summary: null,
      topics: title ? [title] : [],
      tokens,
      costUsd,
      models: [...models],
      filesTouched: [...filesTouched],
      conversationDigest,
      toolCallSummaries: [...new Set(toolCallSummaries)],
    };
  }

  private summarizeToolCall(
    name: string | null,
    rawInput: unknown,
    filesTouched: Set<string>,
  ): string | null {
    const toolName = name ?? 'tool';
    const parsedInput = this.parseMaybeJson(rawInput);
    this.collectFilePaths(parsedInput, filesTouched);

    const input = this.asRecord(parsedInput);
    const filePath =
      this.stringFromRecord(input, 'filePath') ??
      this.stringFromRecord(input, 'path') ??
      this.stringFromRecord(input, 'file') ??
      this.stringFromRecord(input, 'filepath');
    if (filePath) return `${toolName} ${this.shortenHomePath(filePath)}`;

    const command = this.stringFromRecord(input, 'command');
    if (command) return `bash: ${command.slice(0, 80)}`;

    const pattern = this.stringFromRecord(input, 'pattern');
    if (pattern) return `${toolName}: ${pattern}`;

    if (typeof parsedInput === 'string' && parsedInput.trim()) {
      return `${toolName}: ${parsedInput.trim().slice(0, 80)}`;
    }

    return toolName;
  }

  private collectFilePaths(value: unknown, out: Set<string>): void {
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      for (const item of value) this.collectFilePaths(item, out);
      return;
    }

    const rec = this.asRecord(value);
    if (!rec) return;

    for (const [key, raw] of Object.entries(rec)) {
      if (typeof raw === 'string' && this.isPathLikeKey(key) && this.looksLikePath(raw)) {
        out.add(raw);
      } else if (typeof raw === 'object' && raw !== null) {
        this.collectFilePaths(raw, out);
      }
    }
  }

  private isPathLikeKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return normalized.includes('path') || normalized === 'file' || normalized.includes('file');
  }

  private looksLikePath(value: string): boolean {
    if (!value || value.length > 500 || value.includes('\n')) return false;
    return value.includes('/') || value.includes('\\') || value.startsWith('~') || value.startsWith('.');
  }

  private addTokenUsage(tokens: ReturnType<typeof emptyTokenUsage>, payload: Record<string, unknown>): void {
    const info = this.asRecord(payload.info);
    const usage = this.asRecord(info?.last_token_usage) ?? this.asRecord(payload.last_token_usage);
    if (!usage) return;

    tokens.input += this.numberOrZero(usage.input_tokens);
    tokens.output += this.numberOrZero(usage.output_tokens);
    tokens.reasoning += this.numberOrZero(usage.reasoning_output_tokens);
    tokens.cacheRead += this.numberOrZero(usage.cached_input_tokens);
    tokens.cacheWrite += this.numberOrZero(usage.cache_creation_input_tokens);
  }

  private extractMessageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    const parts: string[] = [];
    for (const item of content) {
      const rec = this.asRecord(item);
      if (!rec) continue;
      const text =
        this.stringOrNull(rec.text) ??
        this.stringOrNull(rec.content);
      if (text) parts.push(text);
    }
    return parts.join('\n').trim();
  }

  private extractTimestampMs(line: CodexLine): number | null {
    if (typeof line.timestamp === 'string') {
      const ts = new Date(line.timestamp).getTime();
      if (!Number.isNaN(ts)) return ts;
    }

    const payload = this.asRecord(line.payload);
    if (payload && typeof payload.timestamp === 'string') {
      const ts = new Date(payload.timestamp).getTime();
      if (!Number.isNaN(ts)) return ts;
    }

    return null;
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  private looksLikeSystemEnvelope(text: string): boolean {
    return text.includes('<environment_context>') || text.startsWith('# AGENTS.md');
  }

  private truncateText(text: string, maxLen = 500): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...';
  }

  private truncatePrompt(prompt: string): string {
    const clean = prompt.replace(/\s+/g, ' ').trim();
    if (clean.length <= 60) return clean;
    return clean.slice(0, 57) + '...';
  }

  private shortenHomePath(pathValue: string): string {
    if (pathValue.startsWith(this.home)) {
      return '~' + pathValue.slice(this.home.length);
    }
    return pathValue;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private stringFromRecord(record: Record<string, unknown> | null, key: string): string | null {
    if (!record) return null;
    return this.stringOrNull(record[key]);
  }
}

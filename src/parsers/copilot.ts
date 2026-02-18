import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { Parser, Session } from '../types.js';
import { emptyTokenUsage, estimateCost } from '../cost.js';
import { truncateConversationDigest } from './digest.js';

interface CopilotEvent {
  type?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

interface CopilotSessionInput {
  sessionId: string;
  eventsPath: string;
  workspacePath: string | null;
}

interface WorkspaceMetadata {
  cwd: string | null;
  gitRoot: string | null;
  summary: string | null;
}

export class CopilotParser implements Parser {
  readonly name = 'copilot' as const;
  private sessionStateRoot: string;
  private home = homedir();

  constructor(sessionStateRoot: string) {
    this.sessionStateRoot = sessionStateRoot;
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.sessionStateRoot);
  }

  async getSessions(date: string): Promise<Session[]> {
    const [year, month, day] = date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    const inputs = this.findSessionInputs();
    const sessions: Session[] = [];

    for (const input of inputs) {
      const session = this.parseSessionFile(input, dayStartMs, dayEndMs);
      if (session) sessions.push(session);
    }

    return sessions;
  }

  private findSessionInputs(): CopilotSessionInput[] {
    if (!existsSync(this.sessionStateRoot)) return [];

    let entries: Dirent[];
    try {
      entries = readdirSync(this.sessionStateRoot, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return [];
    }

    const inputs: CopilotSessionInput[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const eventsPath = join(this.sessionStateRoot, entry.name, 'events.jsonl');
        if (existsSync(eventsPath)) {
          const workspacePath = join(this.sessionStateRoot, entry.name, 'workspace.yaml');
          inputs.push({
            sessionId: entry.name,
            eventsPath,
            workspacePath: existsSync(workspacePath) ? workspacePath : null,
          });
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        inputs.push({
          sessionId: basename(entry.name, '.jsonl'),
          eventsPath: join(this.sessionStateRoot, entry.name),
          workspacePath: null,
        });
      }
    }

    return inputs;
  }

  private parseSessionFile(
    input: CopilotSessionInput,
    dayStartMs: number,
    dayEndMs: number,
  ): Session | null {
    let content: string;
    try {
      content = readFileSync(input.eventsPath, 'utf-8');
    } catch {
      return null;
    }

    const MAX_EVENT_GAP_MS = 5 * 60 * 1000;

    const workspace = this.parseWorkspaceMetadata(input.workspacePath);

    let sessionId = input.sessionId;
    let projectPath: string | null = workspace.cwd ?? workspace.gitRoot;
    let projectName: string | null = projectPath ? basename(projectPath) : null;
    let title: string | null = workspace.summary;

    let userMessageCount = 0;
    let assistantMessageCount = 0;
    const models = new Set<string>();
    const tokens = emptyTokenUsage();

    const filesTouched = new Set<string>();
    const toolCallSummaries: string[] = [];
    const digestParts: string[] = [];
    const activityTimestamps: number[] = [];

    let dayEarliest = Infinity;
    let dayLatest = -Infinity;

    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      let event: CopilotEvent;
      try {
        event = JSON.parse(line) as CopilotEvent;
      } catch {
        continue;
      }

      const data = this.asRecord(event.data);

      if (event.type === 'session.start' && data) {
        const sessionIdFromEvent = this.stringFromRecord(data, 'sessionId');
        if (sessionIdFromEvent) sessionId = sessionIdFromEvent;

        const context = this.asRecord(data.context);
        const cwd =
          this.stringFromRecord(context, 'cwd') ??
          this.stringFromRecord(data, 'cwd');
        const gitRoot =
          this.stringFromRecord(context, 'gitRoot') ??
          this.stringFromRecord(context, 'git_root') ??
          this.stringFromRecord(data, 'gitRoot') ??
          this.stringFromRecord(data, 'git_root');

        if (cwd || gitRoot) {
          projectPath = cwd ?? gitRoot ?? null;
          projectName = projectPath ? basename(projectPath) : null;
        }

        if (!title) {
          const summary = this.stringFromRecord(data, 'summary');
          if (summary) title = summary;
        }
      }

      this.collectModels(event.type ?? '', data, models);

      const ts = this.extractTimestampMs(event);
      const inDay = ts !== null && ts >= dayStartMs && ts <= dayEndMs;
      if (!inDay) continue;

      dayEarliest = Math.min(dayEarliest, ts);
      dayLatest = Math.max(dayLatest, ts);

      if (data) {
        this.visitUsageRecord(data, tokens, 0);
      }

      if (event.type === 'user.message') {
        userMessageCount += 1;
        activityTimestamps.push(ts);

        const text = this.extractMessageText(data);
        if (text) {
          digestParts.push(`[User]: ${this.truncateText(text)}`);
          if (!title && !this.looksLikeSystemEnvelope(text)) {
            title = this.truncatePrompt(text);
          }
        }
        continue;
      }

      if (event.type === 'assistant.message') {
        assistantMessageCount += 1;
        activityTimestamps.push(ts);

        const text = this.extractMessageText(data);
        if (text) {
          digestParts.push(`[Assistant]: ${this.truncateText(text)}`);
        }

        if (data) {
          const toolRequests = data.toolRequests;
          if (Array.isArray(toolRequests)) {
            for (const request of toolRequests) {
              const req = this.asRecord(request);
              if (!req) continue;
              const summary = this.summarizeToolCall(
                this.stringFromRecord(req, 'name'),
                req.arguments,
                filesTouched,
              );
              if (summary) toolCallSummaries.push(summary);
            }
          }
        }
        continue;
      }

      if (event.type === 'assistant.turn_start' || event.type === 'assistant.turn_end') {
        activityTimestamps.push(ts);
        continue;
      }

      if (event.type === 'tool.execution_start' || event.type === 'tool.execution_complete') {
        activityTimestamps.push(ts);

        if (data) {
          const summary = this.summarizeToolCall(
            this.stringFromRecord(data, 'toolName') ?? this.stringFromRecord(data, 'name'),
            data.arguments ?? data.result,
            filesTouched,
          );
          if (summary) toolCallSummaries.push(summary);

          this.collectFilePaths(this.parseMaybeJson(data.result), filesTouched);
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
      tool: 'copilot',
      projectPath,
      projectName,
      title: title ?? null,
      startedAt: new Date(Math.max(dayStartMs, dayEarliest)),
      endedAt: new Date(Math.min(dayEndMs, dayLatest)),
      durationMs,
      messageCount: userMessageCount + assistantMessageCount,
      userMessageCount,
      assistantMessageCount,
      summary: title ?? null,
      topics: title ? [title] : [],
      tokens,
      costUsd,
      models: [...models],
      filesTouched: [...filesTouched],
      conversationDigest,
      toolCallSummaries: [...new Set(toolCallSummaries)],
    };
  }

  private parseWorkspaceMetadata(filePath: string | null): WorkspaceMetadata {
    if (!filePath || !existsSync(filePath)) {
      return { cwd: null, gitRoot: null, summary: null };
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      let cwd: string | null = null;
      let gitRoot: string | null = null;
      let summary: string | null = null;

      for (const line of raw.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!match) continue;

        const key = match[1];
        let value = match[2].trim();
        if (!value) continue;

        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (key === 'cwd') cwd = value;
        else if (key === 'git_root') gitRoot = value;
        else if (key === 'summary') summary = value;
      }

      return { cwd, gitRoot, summary };
    } catch {
      return { cwd: null, gitRoot: null, summary: null };
    }
  }

  private collectModels(
    eventType: string,
    data: Record<string, unknown> | null,
    models: Set<string>,
  ): void {
    if (!data) return;

    const directKeys = ['model', 'modelId', 'modelName', 'newModel'];
    for (const key of directKeys) {
      const value = this.stringFromRecord(data, key);
      if (value) models.add(value);
    }

    const modelList = data.models;
    if (Array.isArray(modelList)) {
      for (const model of modelList) {
        if (typeof model === 'string' && model) models.add(model);
      }
    }

    const context = this.asRecord(data.context);
    const contextModel = this.stringFromRecord(context, 'model');
    if (contextModel) models.add(contextModel);

    if (eventType === 'session.info') {
      const infoType = this.stringFromRecord(data, 'infoType');
      const message = this.stringFromRecord(data, 'message');
      if (infoType === 'model' && message) {
        const match = message.match(/Model changed to:\s*([^\s(]+)/i);
        if (match && match[1]) models.add(match[1]);
      }
    }
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

    const command = this.stringFromRecord(input, 'command') ?? this.stringFromRecord(input, 'cmd');
    if (command) return `bash: ${command.slice(0, 80)}`;

    const pattern = this.stringFromRecord(input, 'pattern');
    if (pattern) return `${toolName}: ${pattern}`;

    if (typeof parsedInput === 'string' && parsedInput.trim()) {
      return `${toolName}: ${parsedInput.trim().slice(0, 80)}`;
    }

    return toolName;
  }

  private extractTimestampMs(event: CopilotEvent): number | null {
    if (typeof event.timestamp === 'string') {
      const ts = new Date(event.timestamp).getTime();
      if (!Number.isNaN(ts)) return ts;
    }

    const data = this.asRecord(event.data);
    if (!data) return null;

    const fallback =
      this.stringFromRecord(data, 'timestamp') ??
      this.stringFromRecord(data, 'startTime');
    if (!fallback) return null;

    const ts = new Date(fallback).getTime();
    return Number.isNaN(ts) ? null : ts;
  }

  private extractMessageText(data: Record<string, unknown> | null): string | null {
    if (!data) return null;
    const content = data.content;

    if (typeof content === 'string') {
      const text = content.trim();
      return text ? text : null;
    }

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (typeof part === 'string') {
          if (part.trim()) parts.push(part);
          continue;
        }
        const rec = this.asRecord(part);
        if (!rec) continue;
        const text =
          this.stringFromRecord(rec, 'text') ??
          this.stringFromRecord(rec, 'content') ??
          this.stringFromRecord(rec, 'value');
        if (text) parts.push(text);
      }
      const combined = parts.join('\n').trim();
      return combined ? combined : null;
    }

    const rec = this.asRecord(content);
    if (!rec) return null;

    const text =
      this.stringFromRecord(rec, 'text') ??
      this.stringFromRecord(rec, 'content') ??
      this.stringFromRecord(rec, 'value');
    if (!text) return null;

    const clean = text.trim();
    return clean ? clean : null;
  }

  private visitUsageRecord(
    value: unknown,
    tokens: ReturnType<typeof emptyTokenUsage>,
    depth: number,
  ): void {
    if (depth > 3) return;
    const record = this.asRecord(value);
    if (!record) return;

    if (this.applyUsageFromRecord(record, tokens)) return;

    const nestedKeys = ['usage', 'tokenUsage', 'tokens', 'metrics', 'result'];
    for (const key of nestedKeys) {
      this.visitUsageRecord(record[key], tokens, depth + 1);
    }
  }

  private applyUsageFromRecord(
    record: Record<string, unknown>,
    tokens: ReturnType<typeof emptyTokenUsage>,
  ): boolean {
    const input = this.firstNumber(record, [
      'input_tokens',
      'prompt_tokens',
      'inputTokens',
      'promptTokens',
      'inputTokenCount',
      'promptTokenCount',
    ]);
    const output = this.firstNumber(record, [
      'output_tokens',
      'completion_tokens',
      'outputTokens',
      'completionTokens',
      'outputTokenCount',
      'completionTokenCount',
    ]);
    const reasoning = this.firstNumber(record, [
      'reasoning_tokens',
      'reasoning_output_tokens',
      'reasoningTokens',
      'reasoningTokenCount',
    ]);
    const cacheRead = this.firstNumber(record, [
      'cached_input_tokens',
      'cached_tokens',
      'cache_read_tokens',
      'cacheReadTokens',
      'cachedInputTokens',
    ]);
    const cacheWrite = this.firstNumber(record, [
      'cache_creation_input_tokens',
      'cache_creation_tokens',
      'cache_write_tokens',
      'cacheWriteTokens',
      'cacheCreationInputTokens',
    ]);

    if (input === null && output === null && reasoning === null && cacheRead === null && cacheWrite === null) {
      return false;
    }

    tokens.input += input ?? 0;
    tokens.output += output ?? 0;
    tokens.reasoning += reasoning ?? 0;
    tokens.cacheRead += cacheRead ?? 0;
    tokens.cacheWrite += cacheWrite ?? 0;
    return true;
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
      if (typeof raw === 'string') {
        const parsed = this.parseMaybeJson(raw);
        if (parsed !== raw) {
          this.collectFilePaths(parsed, out);
          continue;
        }

        if (this.isPathLikeKey(key) && this.looksLikePath(raw)) {
          out.add(raw);
          continue;
        }
        continue;
      }

      if (typeof raw === 'object' && raw !== null) {
        this.collectFilePaths(raw, out);
      }
    }
  }

  private isPathLikeKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return (
      normalized.includes('path') ||
      normalized.includes('file') ||
      normalized === 'cwd' ||
      normalized === 'gitroot' ||
      normalized === 'git_root'
    );
  }

  private looksLikePath(value: string): boolean {
    if (!value || value.length > 500 || value.includes('\n')) return false;

    const lower = value.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) return false;

    return (
      value.includes('/') ||
      value.includes('\\') ||
      value.startsWith('~') ||
      value.startsWith('./') ||
      value.startsWith('../')
    );
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

  private firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = this.numberOrNull(record[key]);
      if (value !== null) return value;
    }
    return null;
  }

  private numberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private looksLikeSystemEnvelope(text: string): boolean {
    return text.includes('<environment_context>') || text.startsWith('# AGENTS.md') || text.includes('<agent_instructions>');
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

  private stringFromRecord(record: Record<string, unknown> | null, key: string): string | null {
    if (!record) return null;
    const value = record[key];
    return typeof value === 'string' ? value : null;
  }
}

/**
 * JSONL session reader — reads Claude Code session files from ~/.claude/projects/.
 *
 * Claude Code stores conversation history as JSONL files:
 *   ~/.claude/projects/{encoded-path}/{session-id}.jsonl
 *
 * Each line is a JSON object with a `type` field:
 *   - 'user'      — user message (message.content is text or content blocks)
 *   - 'assistant'  — agent message (message.content is text or content blocks)
 *   - 'progress'   — tool progress events
 *   - 'system'     — system events
 *   - 'file-history-snapshot' — file state snapshots
 *
 * Each line also carries: sessionId, cwd, timestamp, uuid, parentUuid.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: string;
  /** First user message (truncated). */
  summary: string;
  /** Message count (user + assistant). */
  messageCount: number;
  /** Last activity ISO timestamp. */
  lastActivity: string;
  /** Working directory. */
  cwd: string;
  /** Git branch at session time. */
  gitBranch?: string;
  /** Whether session can be resumed via SDK. */
  resumable: boolean;
}

export interface SessionMessage {
  type: 'user' | 'assistant';
  text: string;
  timestamp: string;
  uuid: string;
}

// ---------------------------------------------------------------------------
// Rich session messages — structured content blocks from JSONL
// ---------------------------------------------------------------------------

export type RichSessionMessage =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; ts: string; uuid: string }
  | {
      kind: 'tool_use';
      toolName: string;
      toolId: string;
      input: Record<string, unknown>;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'tool_result';
      toolId: string;
      output: string;
      isError: boolean;
      ts: string;
      uuid: string;
    }
  | { kind: 'thinking'; text: string; ts: string; uuid: string };

// ---------------------------------------------------------------------------
// Path encoding (matches Claude Code's directory naming)
// ---------------------------------------------------------------------------

/**
 * Decode a Claude Code project directory name back to a filesystem path.
 * Claude-style encoding:
 *   '/'  -> '-'
 *   '-'  -> '--'
 * Example: /Users/dev-user/my-project -> -Users-dev--user-my--project
 */
export function decodeProjectDir(dirName: string): string {
  const hasLeadingSlash = dirName.startsWith('-');
  const source = hasLeadingSlash ? dirName.slice(1) : dirName;
  let decoded = '';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '-') {
      decoded += ch;
      continue;
    }
    const next = source[i + 1];
    if (next === '-') {
      decoded += '-';
      i += 1;
    } else {
      decoded += '/';
    }
  }

  return hasLeadingSlash ? `/${decoded}` : decoded;
}

/**
 * Encode a filesystem path to a Claude Code project directory name.
 * '/'  -> '-'
 * '-'  -> '--'
 */
export function encodeProjectDir(fsPath: string): string {
  const normalized = path.resolve(fsPath);
  let encoded = '';
  for (const ch of normalized) {
    if (ch === '/') {
      encoded += '-';
    } else if (ch === '-') {
      encoded += '--';
    } else {
      encoded += ch;
    }
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Path to Claude Code's projects directory. */
export function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * List all Claude Code project directories.
 * Returns decoded paths and their encoded directory names.
 */
export async function listProjects(): Promise<Array<{ dirName: string; fsPath: string }>> {
  const projectsDir = claudeProjectsDir();
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const projects: Array<{ dirName: string; fsPath: string }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const decoded = decodeProjectDir(entry.name);
        // Verify the decoded path exists on disk
        try {
          await fs.access(decoded);
          projects.push({ dirName: entry.name, fsPath: decoded });
        } catch {
          // Directory no longer exists on disk, skip
        }
      }
    }

    return projects;
  } catch {
    return [];
  }
}

/**
 * List sessions for a specific project directory.
 * Reads JSONL files and extracts summary metadata.
 * @param projectDirName - Encoded project directory name
 * @param basePath - Override base path (defaults to ~/.claude/projects/)
 */
export async function listProjectSessions(
  projectDirName: string,
  basePath?: string,
): Promise<SessionSummary[]> {
  const projectPath = path.join(basePath ?? claudeProjectsDir(), projectDirName);
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    const sessions: SessionSummary[] = [];

    for (const entry of entries) {
      // Only process direct .jsonl files (skip subagent directories)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const sessionId = entry.name.replace('.jsonl', '');
        const filePath = path.join(projectPath, entry.name);
        try {
          const summary = await parseSessionSummary(filePath, sessionId);
          if (summary) {
            sessions.push(summary);
          }
        } catch {
          // Skip malformed files
        }
      }
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => {
      const ta = new Date(a.lastActivity).getTime();
      const tb = new Date(b.lastActivity).getTime();
      return tb - ta;
    });

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Parse a JSONL file to extract session summary metadata.
 * Reads only enough lines to get summary info (not full message content).
 */
async function parseSessionSummary(
  filePath: string,
  sessionId: string,
): Promise<SessionSummary | null> {
  let firstUserMessage = '';
  let messageCount = 0;
  let lastTimestamp = '';
  let cwd = '';
  let gitBranch: string | undefined;
  let resumePoisoned = false;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const type = entry.type as string;

      // Extract cwd and gitBranch from any line that has them
      if (!cwd && typeof entry.cwd === 'string') {
        cwd = entry.cwd;
      }
      if (!gitBranch && typeof entry.gitBranch === 'string' && entry.gitBranch !== 'HEAD') {
        gitBranch = entry.gitBranch;
      }

      if (type === 'user' || type === 'assistant') {
        messageCount++;

        // Track timestamp
        if (typeof entry.timestamp === 'string') {
          lastTimestamp = entry.timestamp;
        }

        const message = entry.message as Record<string, unknown> | undefined;
        if (type === 'user' && hasEmptyUserTextBlock(message)) {
          resumePoisoned = true;
        }
        if (
          type === 'assistant' &&
          entry.isApiErrorMessage === true &&
          isEmptyTextApiErrorMessage(extractTextContent(message))
        ) {
          resumePoisoned = true;
        }

        // Get first user message as summary
        if (type === 'user' && !firstUserMessage) {
          firstUserMessage = extractTextContent(message);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (messageCount === 0) return null;

  // Skip sessions with no meaningful user message (e.g. subagent stubs, API errors)
  if (!firstUserMessage.trim()) return null;

  return {
    sessionId,
    summary: firstUserMessage.slice(0, 120),
    messageCount,
    lastActivity: lastTimestamp || new Date().toISOString(),
    cwd,
    gitBranch,
    resumable: !resumePoisoned,
  };
}

/**
 * Read full session messages from a JSONL file.
 * Returns user and assistant messages in order (flat text only).
 * @deprecated Use readSessionMessagesRich() for structured content blocks.
 */
export async function readSessionMessages(
  projectDirName: string,
  sessionId: string,
  basePath?: string,
): Promise<SessionMessage[]> {
  const filePath = path.join(basePath ?? claudeProjectsDir(), projectDirName, `${sessionId}.jsonl`);
  const messages: SessionMessage[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const type = entry.type as string;

      if (type === 'user' || type === 'assistant') {
        const text = extractTextContent(entry.message as Record<string, unknown>);
        if (text) {
          messages.push({
            type,
            text,
            timestamp: (entry.timestamp as string) || new Date().toISOString(),
            uuid: (entry.uuid as string) || '',
          });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/**
 * Read full session messages from a JSONL file as structured content blocks.
 * Each content block (text, tool_use, tool_result, thinking) becomes its own
 * RichSessionMessage, preserving the order they appear in the JSONL.
 *
 * Delegates per-entry parsing to parseJSONLEntry().
 */
export async function readSessionMessagesRich(
  projectDirName: string,
  sessionId: string,
  basePath?: string,
): Promise<RichSessionMessage[]> {
  const filePath = path.join(basePath ?? claudeProjectsDir(), projectDirName, `${sessionId}.jsonl`);
  return readRichSessionMessagesFromFile(filePath);
}

/**
 * Read rich session messages from an arbitrary JSONL file path.
 * Supports both Claude JSONL and Codex session JSONL envelope formats.
 */
export async function readRichSessionMessagesFromFile(
  filePath: string,
): Promise<RichSessionMessage[]> {
  const blocks: RichSessionMessage[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      blocks.push(...parseJSONLEntry(entry));
    } catch {
      // Skip malformed lines
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Single-entry parser (used by both readSessionMessagesRich and tail events)
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL entry (already JSON.parsed) into RichSessionMessage blocks.
 * A single entry may produce 0, 1, or many blocks (e.g. an assistant message
 * with text + tool_use + thinking blocks).
 *
 * Extracted from readSessionMessagesRich() so both the full-file reader
 * and the incremental tailer can share the same parsing logic.
 */
export function parseJSONLEntry(entry: unknown): RichSessionMessage[] {
  if (typeof entry !== 'object' || entry === null) return [];

  const e = entry as Record<string, unknown>;
  return parseClaudeEntry(e) ?? parseCodexEntry(e) ?? [];
}

function parseClaudeEntry(e: Record<string, unknown>): RichSessionMessage[] | null {
  const type = e.type as string;
  if (type !== 'user' && type !== 'assistant') return null;

  const ts = (e.timestamp as string) || new Date().toISOString();
  const uuid = (e.uuid as string) || '';
  const message = e.message as Record<string, unknown> | undefined;
  if (!message) return [];

  const content = message.content;
  const blocks: RichSessionMessage[] = [];

  // Simple string content → single text block
  if (typeof content === 'string') {
    if (content) {
      blocks.push({ kind: 'text', role: type, text: content, ts, uuid });
    }
    return blocks;
  }

  if (!Array.isArray(content)) return blocks;

  for (const block of content) {
    if (typeof block === 'string') {
      if (block) {
        blocks.push({ kind: 'text', role: type, text: block, ts, uuid });
      }
      continue;
    }

    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const blockType = b.type as string;

    switch (blockType) {
      case 'text':
        if (typeof b.text === 'string' && b.text) {
          blocks.push({ kind: 'text', role: type, text: b.text, ts, uuid });
        }
        break;

      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking) {
          blocks.push({ kind: 'thinking', text: b.thinking, ts, uuid });
        }
        break;

      case 'tool_use':
        blocks.push({
          kind: 'tool_use',
          toolName: (b.name as string) || 'unknown',
          toolId: (b.id as string) || '',
          input:
            typeof b.input === 'object' && b.input !== null
              ? (b.input as Record<string, unknown>)
              : {},
          ts,
          uuid,
        });
        break;

      case 'tool_result': {
        const toolId = (b.tool_use_id as string) || '';
        const isError = b.is_error === true;
        const output = extractToolResultContent(b.content);
        blocks.push({ kind: 'tool_result', toolId, output, isError, ts, uuid });
        break;
      }
    }
  }

  return blocks;
}

function parseCodexEntry(e: Record<string, unknown>): RichSessionMessage[] | null {
  const envelopeType = e.type as string;
  if (envelopeType !== 'response_item') return null;

  const payload =
    typeof e.payload === 'object' && e.payload !== null
      ? (e.payload as Record<string, unknown>)
      : null;
  if (!payload) return [];

  const ts = timestampFromEntry(e, payload);
  const itemType = payload.type as string;

  if (itemType === 'message') {
    const role = normalizeCodexRole(payload.role);
    const messageBlocks: RichSessionMessage[] = [];
    const content = payload.content;
    const baseUuid = codexUuid(payload, ts, 'message');

    if (typeof content === 'string') {
      const text = content.trim();
      if (text) {
        messageBlocks.push({ kind: 'text', role, text, ts, uuid: baseUuid });
      }
      return messageBlocks;
    }

    if (!Array.isArray(content)) return messageBlocks;

    for (let i = 0; i < content.length; i += 1) {
      const item = content[i];
      const itemRec =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
      const text = extractCodexContentText(itemRec ?? item);
      if (!text) continue;
      messageBlocks.push({
        kind: 'text',
        role,
        text,
        ts,
        uuid: `${baseUuid}-${i}`,
      });
    }
    return messageBlocks;
  }

  if (itemType === 'function_call') {
    const toolId = codexToolId(payload);
    const toolName =
      (typeof payload.name === 'string' && payload.name) ||
      (typeof payload.tool_name === 'string' && payload.tool_name) ||
      'tool';
    return [
      {
        kind: 'tool_use',
        toolName,
        toolId,
        input: parseCodexFunctionCallInput(payload.arguments),
        ts,
        uuid: codexUuid(payload, ts, 'tool-use'),
      },
    ];
  }

  if (itemType === 'function_call_output') {
    const output =
      (typeof payload.output === 'string' && payload.output) ||
      (typeof payload.result === 'string' && payload.result) ||
      '';
    return [
      {
        kind: 'tool_result',
        toolId: codexToolId(payload),
        output,
        isError: payload.is_error === true || payload.isError === true,
        ts,
        uuid: codexUuid(payload, ts, 'tool-result'),
      },
    ];
  }

  if (itemType === 'reasoning') {
    const thinking = extractCodexReasoning(payload);
    if (!thinking) return [];
    return [
      {
        kind: 'thinking',
        text: thinking,
        ts,
        uuid: codexUuid(payload, ts, 'thinking'),
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text from a tool_result content field.
 * Content can be a string, an array of text blocks, or absent.
 */
function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (typeof item === 'object' && item !== null) {
        const c = item as Record<string, unknown>;
        if (c.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}

function timestampFromEntry(
  entry: Record<string, unknown>,
  payload?: Record<string, unknown>,
): string {
  const fromPayload = payload?.timestamp;
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
  const fromEntry = entry.timestamp;
  if (typeof fromEntry === 'string' && fromEntry) return fromEntry;
  return new Date().toISOString();
}

function normalizeCodexRole(value: unknown): 'user' | 'assistant' {
  return value === 'user' ? 'user' : 'assistant';
}

function codexToolId(payload: Record<string, unknown>): string {
  const candidates = [payload.call_id, payload.callId, payload.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

function codexUuid(payload: Record<string, unknown>, ts: string, suffix: string): string {
  const candidates = [payload.id, payload.call_id, payload.callId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return `codex-${suffix}-${ts}`;
}

function parseCodexFunctionCallInput(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function extractCodexContentText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed;
  }
  if (typeof value !== 'object' || value === null) return '';
  const rec = value as Record<string, unknown>;
  const candidates = [rec.text, rec.output_text, rec.input_text, rec.value, rec.content];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function extractCodexReasoning(payload: Record<string, unknown>): string {
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    const pieces: string[] = [];
    for (const item of summary) {
      if (typeof item === 'string' && item.trim()) {
        pieces.push(item.trim());
        continue;
      }
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const text = extractCodexContentText(rec);
      if (text) pieces.push(text);
    }
    if (pieces.length > 0) return pieces.join('\n');
  }
  const fallback = extractCodexContentText(payload);
  return fallback;
}

/**
 * Extract text content from a Claude message object.
 * Content can be a string or an array of content blocks.
 */
function extractTextContent(message: Record<string, unknown> | undefined): string {
  if (!message) return '';

  const content = message.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
    }
    return parts.join('\n');
  }

  return '';
}

function hasEmptyUserTextBlock(message: Record<string, unknown> | undefined): boolean {
  if (!message) return false;
  const content = message.content;

  if (typeof content === 'string') {
    return content.trim().length === 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim().length === 0) return true;
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'text') continue;
    const text = b.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      return true;
    }
  }

  return false;
}

function isEmptyTextApiErrorMessage(text: string): boolean {
  return (
    text.includes('messages: text content blocks must be non-empty') ||
    text.includes('cache_control cannot be set for empty text blocks')
  );
}

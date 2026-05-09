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
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseJSONLEntry, type RichSessionMessage } from './jsonl-entry-parser.js';
import { claudeProjectsDir, decodeProjectDir } from './jsonl-paths.js';

export { parseJSONLEntry } from './jsonl-entry-parser.js';
export type { RichSessionMessage } from './jsonl-entry-parser.js';
export { claudeProjectsDir, decodeProjectDir, encodeProjectDir } from './jsonl-paths.js';

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
  /** Source JSONL file backing this session. */
  sourcePath?: string;
}

export interface SessionMessage {
  type: 'user' | 'assistant';
  text: string;
  timestamp: string;
  uuid: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

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
    sourcePath: filePath,
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

/**
 * Read the newest rich messages from a JSONL session file without parsing the
 * whole transcript. Session detail pages usually need the latest timeline slice,
 * and large Codex sessions can expand into tens of thousands of rich blocks.
 */
export async function readRichSessionMessagesTailFromFile(
  filePath: string,
  limit: number,
  options: RichSessionTailReadOptions = {},
): Promise<RichSessionMessage[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const blocksNewestFirst: RichSessionMessage[] = [];
    const chunkSize = normalizePositiveInteger(options.chunkSize, DEFAULT_TAIL_CHUNK_SIZE);
    const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_TAIL_SCAN_BYTES);
    const maxLineBytes = normalizePositiveInteger(options.maxLineBytes, DEFAULT_TAIL_LINE_BYTES);
    let remaining = stat.size;
    let bytesScanned = 0;
    let carry = Buffer.alloc(0);

    while (remaining > 0 && blocksNewestFirst.length < limit && bytesScanned < maxBytes) {
      const readSize = Math.min(chunkSize, remaining, maxBytes - bytesScanned);
      if (readSize <= 0) break;
      remaining -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      await handle.read(buffer, 0, readSize, remaining);
      bytesScanned += readSize;

      const data =
        carry.length > 0 ? Buffer.concat([buffer, carry], readSize + carry.length) : buffer;
      let lineEnd = data.length;

      for (
        let index = data.length - 1;
        index >= 0 && blocksNewestFirst.length < limit;
        index -= 1
      ) {
        if (data[index] !== 0x0a) continue;
        pushTailLineBlocks(
          data.subarray(index + 1, lineEnd),
          limit,
          maxLineBytes,
          blocksNewestFirst,
        );
        lineEnd = index;
      }

      carry = data.subarray(0, lineEnd);
    }

    if (remaining === 0 && blocksNewestFirst.length < limit && carry.length > 0) {
      pushTailLineBlocks(carry, limit, maxLineBytes, blocksNewestFirst);
    }

    return blocksNewestFirst.reverse();
  } finally {
    await handle.close();
  }
}

export interface RichSessionTailPage {
  messages: RichSessionMessage[];
  nextOffset: number;
  hasMoreBefore: boolean;
}

/**
 * Read a latest-first page from the end of a JSONL transcript.
 *
 * `offset` is measured from the newest parsed rich block. offset=0 returns the
 * latest page; offset=200 returns the page immediately before the newest 200
 * blocks. Internally this still reads backwards from the file and asks for one
 * extra block so callers can render an honest "load older" affordance without
 * scanning the whole file.
 */
export async function readRichSessionMessagesTailPageFromFile(
  filePath: string,
  limit: number,
  offset = 0,
  options: RichSessionTailReadOptions = {},
): Promise<RichSessionTailPage> {
  const safeLimit = normalizePositiveInteger(limit, 1);
  const safeOffset = normalizeNonNegativeInteger(offset);
  const tail = await readRichSessionMessagesTailFromFile(
    filePath,
    safeLimit + safeOffset + 1,
    options,
  );

  return pageFromTailMessages(tail, safeLimit, safeOffset);
}

export function pageFromTailMessages<T>(
  tail: T[],
  limit: number,
  offset = 0,
): {
  messages: T[];
  nextOffset: number;
  hasMoreBefore: boolean;
} {
  const safeLimit = normalizePositiveInteger(limit, 1);
  const safeOffset = normalizeNonNegativeInteger(offset);
  const withoutNewer = safeOffset > 0 ? tail.slice(0, Math.max(0, tail.length - safeOffset)) : tail;
  const page = withoutNewer.slice(-safeLimit);
  return {
    messages: page,
    nextOffset: safeOffset + page.length,
    hasMoreBefore: withoutNewer.length > page.length,
  };
}

export interface RichSessionTailReadOptions {
  /** Bytes per backwards file read. Exposed for deterministic split-boundary tests. */
  chunkSize?: number;
  /** Hard cap on bytes scanned from the end of the file. Keeps live transcript requests bounded. */
  maxBytes?: number;
  /** Lines above this size are skipped instead of parsed into giant ack payloads. */
  maxLineBytes?: number;
}

const DEFAULT_TAIL_CHUNK_SIZE = 512 * 1024;
const DEFAULT_TAIL_SCAN_BYTES = 64 * 1024 * 1024;
const DEFAULT_TAIL_LINE_BYTES = 8 * 1024 * 1024;

function pushTailLineBlocks(
  lineBuffer: Buffer,
  limit: number,
  maxLineBytes: number,
  outNewestFirst: RichSessionMessage[],
): void {
  if (outNewestFirst.length >= limit) return;
  const line = trimAsciiWhitespace(lineBuffer);
  if (line.length === 0 || line.length > maxLineBytes) return;

  try {
    const entry = JSON.parse(line.toString('utf-8'));
    const parsed = parseJSONLEntry(entry);
    for (let blockIndex = parsed.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = parsed[blockIndex];
      if (!block) continue;
      outNewestFirst.push(block);
      if (outNewestFirst.length >= limit) break;
    }
  } catch {
    // Skip malformed JSONL lines. In active sessions the writer may leave a trailing partial line.
  }
}

function trimAsciiWhitespace(buffer: Buffer): Buffer {
  let start = 0;
  let end = buffer.length;
  while (start < end && isAsciiWhitespace(buffer[start]!)) start += 1;
  while (end > start && isAsciiWhitespace(buffer[end - 1]!)) end -= 1;
  return buffer.subarray(start, end);
}

function isAsciiWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return 0;
  return Math.floor(value);
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

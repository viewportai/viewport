import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DiscoveredSession, SessionDiscovery } from '../core/interfaces.js';
import { readRichSessionMessagesFromFile, type RichSessionMessage } from './jsonl-reader.js';

const MAX_FILES_PER_SCAN = 2_000;

interface ParsedSession {
  sessionId: string;
  cwd?: string;
  summary: string;
  messageCount?: number;
  lastModified: number;
  sourcePath?: string;
}

export class CodexDiscovery implements SessionDiscovery {
  readonly agentId = 'codex';

  async discoverSessions(projectPath: string): Promise<DiscoveredSession[]> {
    const target = path.resolve(projectPath);
    const files = await listSessionFiles(codexSessionsDir());
    const results: DiscoveredSession[] = [];

    for (const filePath of files) {
      const parsed = await parseSessionFile(filePath);
      if (!parsed) continue;
      if (!parsed.cwd) continue;
      if (path.resolve(parsed.cwd) !== target) continue;

      results.push({
        agentId: this.agentId,
        sessionId: parsed.sessionId,
        summary: parsed.summary,
        lastModified: parsed.lastModified,
        cwd: parsed.cwd,
        resumable: true,
        messageCount: parsed.messageCount,
        sourcePath: parsed.sourcePath,
      });
    }

    results.sort((a, b) => b.lastModified - a.lastModified);
    return dedupeBySessionId(results);
  }
}

export function codexHomeDir(): string {
  const fromEnv = process.env['CODEX_HOME'];
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.codex');
}

export function codexSessionsDir(): string {
  return path.join(codexHomeDir(), 'sessions');
}

export async function findCodexSessionFile(
  sessionId: string,
  preferredSourcePath?: string,
): Promise<string | null> {
  if (preferredSourcePath) {
    try {
      await fs.access(preferredSourcePath);
      return preferredSourcePath;
    } catch {
      // Fall through to search by ID.
    }
  }

  const files = await listSessionFiles(codexSessionsDir());
  for (const filePath of files) {
    const parsed = await parseSessionFile(filePath);
    if (!parsed) continue;
    if (parsed.sessionId === sessionId) return filePath;
  }
  return null;
}

export async function readCodexSessionMessagesRich(
  sessionId: string,
  preferredSourcePath?: string,
): Promise<RichSessionMessage[]> {
  const filePath = await findCodexSessionFile(sessionId, preferredSourcePath);
  if (!filePath) {
    throw new Error(`Codex session file not found for ${sessionId}`);
  }
  return readRichSessionMessagesFromFile(filePath);
}

async function listSessionFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0 && out.length < MAX_FILES_PER_SCAN) {
    const dir = queue.shift();
    if (!dir) continue;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_SCAN) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
      out.push(full);
    }
  }

  return out;
}

async function parseSessionFile(filePath: string): Promise<ParsedSession | null> {
  if (filePath.endsWith('.jsonl')) {
    return parseJsonlSession(filePath);
  }
  return parseJsonSession(filePath);
}

async function parseJsonSession(filePath: string): Promise<ParsedSession | null> {
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const stat = await fs.stat(filePath).catch(() => null);
  const rec = toRecord(data);
  if (!rec) return null;

  const messages = readMessages(rec);
  const firstUser = firstUserText(messages);
  const summary = (firstUser || guessSummary(rec) || 'Codex session').slice(0, 120);
  const messageCount = messages.length || undefined;
  const sessionId = detectSessionId(rec) ?? path.basename(filePath, '.json');
  const cwd = detectCwd(rec);
  const lastModified = detectTimestamp(rec) ?? stat?.mtimeMs ?? Date.now();

  return {
    sessionId,
    cwd,
    summary,
    messageCount,
    lastModified,
    sourcePath: filePath,
  };
}

async function parseJsonlSession(filePath: string): Promise<ParsedSession | null> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let summary = '';
  let messageCount = 0;
  let lastModified = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = toRecord(entry);
    if (!rec) continue;

    sessionId = sessionId ?? detectSessionId(rec);
    cwd = cwd ?? detectCwd(rec);
    lastModified = Math.max(lastModified, detectTimestamp(rec) ?? 0);

    const messages = readMessages(rec);
    for (const msg of messages) {
      messageCount += 1;
      if (!summary && msg.role === 'user' && msg.text) {
        summary = msg.text.slice(0, 120);
      }
    }

    if (!summary) {
      const guessed = guessSummary(rec);
      if (guessed) summary = guessed.slice(0, 120);
    }
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');

  return {
    sessionId,
    cwd,
    summary: summary || 'Codex session',
    messageCount: messageCount || undefined,
    lastModified: lastModified || stat?.mtimeMs || Date.now(),
    sourcePath: filePath,
  };
}

function detectSessionId(rec: Record<string, unknown>): string | undefined {
  const payload = toRecord(rec['payload']);
  const candidates = [
    rec['sessionId'],
    rec['session_id'],
    rec['threadId'],
    rec['thread_id'],
    rec['id'],
    payload?.['sessionId'],
    payload?.['session_id'],
    payload?.['threadId'],
    payload?.['thread_id'],
    payload?.['id'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

function detectCwd(rec: Record<string, unknown>): string | undefined {
  const direct = [rec['cwd'], rec['workingDirectory'], rec['workdir'], rec['projectPath']];
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  const nested = [rec['payload'], rec['metadata'], rec['context'], rec['project']];
  for (const parent of nested) {
    const nestedRec = toRecord(parent);
    if (!nestedRec) continue;
    const candidate = detectCwd(nestedRec);
    if (candidate) return candidate;
  }
  return undefined;
}

function detectTimestamp(rec: Record<string, unknown>): number | undefined {
  const payload = toRecord(rec['payload']);
  const fields = [
    rec['lastModified'],
    rec['updatedAt'],
    rec['timestamp'],
    rec['createdAt'],
    rec['last_activity'],
    payload?.['lastModified'],
    payload?.['updatedAt'],
    payload?.['timestamp'],
    payload?.['createdAt'],
    payload?.['last_activity'],
  ];
  for (const field of fields) {
    const parsed = parseTimestamp(field);
    if (parsed) return parsed;
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return parseTimestamp(asNum);
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) return asDate;
  }
  return undefined;
}

function readMessages(rec: Record<string, unknown>): Array<{ role: string; text: string }> {
  const codexMessages = readCodexEnvelopeMessages(rec);
  if (codexMessages.length > 0) return codexMessages;

  const rootCandidates = [rec['messages'], rec['history'], rec['turns'], rec['conversation']];
  for (const candidate of rootCandidates) {
    if (!Array.isArray(candidate)) continue;
    const parsed = candidate
      .map((item) => parseMessage(toRecord(item)))
      .filter((msg): msg is { role: string; text: string } => !!msg);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function readCodexEnvelopeMessages(
  rec: Record<string, unknown>,
): Array<{ role: string; text: string }> {
  if (rec['type'] !== 'response_item') return [];
  const payload = toRecord(rec['payload']);
  if (!payload) return [];
  if (payload['type'] !== 'message') return [];

  const role = typeof payload['role'] === 'string' ? payload['role'] : 'assistant';
  const content = payload['content'];
  const text = extractText(content);
  if (!text) return [];
  return [{ role, text }];
}

function parseMessage(rec: Record<string, unknown> | null): { role: string; text: string } | null {
  if (!rec) return null;
  const role =
    typeof rec['role'] === 'string'
      ? rec['role']
      : typeof rec['type'] === 'string'
        ? rec['type']
        : 'unknown';
  const text = extractText(rec['content'] ?? rec['text'] ?? rec['message'] ?? rec['input']) ?? '';
  if (!text.trim()) return null;
  return { role, text: text.trim() };
}

function firstUserText(messages: Array<{ role: string; text: string }>): string {
  for (const msg of messages) {
    if (msg.role.toLowerCase() === 'user') return msg.text;
  }
  return messages[0]?.text ?? '';
}

function guessSummary(rec: Record<string, unknown>): string {
  const payload = toRecord(rec['payload']);
  const summary = extractText(
    rec['summary'] ??
      rec['title'] ??
      rec['prompt'] ??
      rec['input'] ??
      payload?.['summary'] ??
      payload?.['title'] ??
      payload?.['prompt'] ??
      payload?.['input'],
  );
  return summary?.trim() ?? '';
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => extractText(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join(' ');
    return joined || undefined;
  }
  const rec = toRecord(value);
  if (!rec) return undefined;
  return (
    extractText(rec['text']) ??
    extractText(rec['value']) ??
    extractText(rec['content']) ??
    extractText(rec['message']) ??
    extractText(rec['output'])
  );
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function dedupeBySessionId(sessions: DiscoveredSession[]): DiscoveredSession[] {
  const seen = new Set<string>();
  const out: DiscoveredSession[] = [];
  for (const session of sessions) {
    const key = `${session.agentId}:${session.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(session);
  }
  return out;
}

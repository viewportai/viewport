import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { cleanCodexSummary, firstMeaningfulUserSummary } from './codex-summary.js';

export interface ParsedCodexSession {
  sessionId: string;
  cwd?: string;
  summary: string;
  messageCount?: number;
  lastModified: number;
  sourcePath?: string;
}

export async function parseCodexSessionFile(filePath: string): Promise<ParsedCodexSession | null> {
  if (filePath.endsWith('.jsonl')) {
    return parseJsonlSession(filePath);
  }
  return parseJsonSession(filePath);
}

async function parseJsonSession(filePath: string): Promise<ParsedCodexSession | null> {
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
  const summary =
    firstMeaningfulUserSummary(messages) || cleanCodexSummary(guessSummary(rec)) || 'Codex session';
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

async function parseJsonlSession(filePath: string): Promise<ParsedCodexSession | null> {
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
        summary = cleanCodexSummary(msg.text);
      }
    }

    if (!summary) {
      const guessed = guessSummary(rec);
      if (guessed) summary = cleanCodexSummary(guessed);
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
  const text = extractText(payload['content']);
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

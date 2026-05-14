import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { cleanCodexSummary, firstMeaningfulUserSummary } from './codex-summary.js';

export interface ParsedCodexSession {
  sessionId: string;
  cwd?: string;
  summary: string;
  nativeTitle?: string;
  generatedTitle?: string;
  displayTitle?: string;
  titleSource?: 'native' | 'generated' | 'first_prompt' | 'fallback';
  firstPrompt?: string;
  lastPrompt?: string;
  latestModel?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  reasoningEffort?: string;
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
  const firstPrompt = firstMeaningfulUserSummary(messages);
  const lastPrompt = lastMeaningfulUserSummary(messages);
  const nativeTitle = detectNativeTitle(rec);
  const guessed = cleanCodexSummary(guessSummary(rec));
  const summary = firstPrompt || guessed || nativeTitle || 'Codex session';
  const messageCount = messages.length || undefined;
  const sessionId = detectSessionId(rec) ?? path.basename(filePath, '.json');
  const cwd = detectCwd(rec);
  const lastModified = detectTimestamp(rec) ?? stat?.mtimeMs ?? Date.now();
  const latestModel = detectLatestModel(rec);
  const approvalPolicy = detectStringField(rec, ['approvalPolicy', 'approval_policy']);
  const sandboxMode = detectStringField(rec, ['sandboxMode', 'sandbox_mode']);
  const reasoningEffort = detectStringField(rec, [
    'modelReasoningEffort',
    'model_reasoning_effort',
    'reasoningEffort',
    'reasoning_effort',
  ]);

  return {
    sessionId,
    cwd,
    summary,
    nativeTitle,
    displayTitle: nativeTitle || firstPrompt || guessed || 'Codex session',
    titleSource: nativeTitle ? 'native' : firstPrompt ? 'first_prompt' : 'fallback',
    firstPrompt: firstPrompt || undefined,
    lastPrompt: lastPrompt || undefined,
    latestModel,
    approvalPolicy,
    sandboxMode,
    reasoningEffort,
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
  let nativeTitle: string | undefined;
  let firstPrompt = '';
  let lastPrompt = '';
  let latestModel: string | undefined;
  let approvalPolicy: string | undefined;
  let sandboxMode: string | undefined;
  let reasoningEffort: string | undefined;
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
    nativeTitle = detectNativeTitle(rec) ?? nativeTitle;
    latestModel = detectLatestModel(rec) ?? latestModel;
    approvalPolicy =
      detectStringField(rec, ['approvalPolicy', 'approval_policy']) ?? approvalPolicy;
    sandboxMode = detectStringField(rec, ['sandboxMode', 'sandbox_mode']) ?? sandboxMode;
    reasoningEffort =
      detectStringField(rec, [
        'modelReasoningEffort',
        'model_reasoning_effort',
        'reasoningEffort',
        'reasoning_effort',
      ]) ?? reasoningEffort;
    lastModified = Math.max(lastModified, detectTimestamp(rec) ?? 0);

    const messages = readMessages(rec);
    for (const msg of messages) {
      messageCount += 1;
      if (msg.role === 'user' && msg.text) {
        const clean = cleanCodexSummary(msg.text);
        if (clean) {
          if (!firstPrompt) firstPrompt = clean;
          lastPrompt = clean;
          if (!summary) summary = clean;
        }
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
    summary: summary || nativeTitle || 'Codex session',
    nativeTitle,
    displayTitle: nativeTitle || firstPrompt || summary || 'Codex session',
    titleSource: nativeTitle ? 'native' : firstPrompt ? 'first_prompt' : 'fallback',
    firstPrompt: firstPrompt || undefined,
    lastPrompt: lastPrompt || undefined,
    latestModel,
    approvalPolicy,
    sandboxMode,
    reasoningEffort,
    messageCount: messageCount || undefined,
    lastModified: lastModified || stat?.mtimeMs || Date.now(),
    sourcePath: filePath,
  };
}

function lastMeaningfulUserSummary(messages: Array<{ role: string; text: string }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (!msg || msg.role !== 'user') continue;
    const clean = cleanCodexSummary(msg.text);
    if (clean) return clean;
  }
  return '';
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

function detectNativeTitle(rec: Record<string, unknown>): string | undefined {
  const payload = toRecord(rec['payload']);
  const candidates = [
    rec['thread_name'],
    rec['threadName'],
    rec['customTitle'],
    rec['title'],
    payload?.['thread_name'],
    payload?.['threadName'],
    payload?.['customTitle'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const clean = cleanCodexSummary(candidate);
      if (clean) return clean;
    }
  }
  return undefined;
}

function detectLatestModel(rec: Record<string, unknown>): string | undefined {
  const payload = toRecord(rec['payload']);
  const candidates = [
    rec['model'],
    rec['modelId'],
    rec['model_id'],
    payload?.['model'],
    payload?.['modelId'],
    payload?.['model_id'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const provider =
    typeof payload?.['provider_id'] === 'string' ? payload['provider_id'] : undefined;
  const model = typeof payload?.['model_id'] === 'string' ? payload['model_id'] : undefined;
  if (provider && model) return `${provider}/${model}`;
  return undefined;
}

function detectStringField(rec: Record<string, unknown>, names: string[]): string | undefined {
  const payload = toRecord(rec['payload']);
  const nested = [rec, payload, toRecord(payload?.['config']), toRecord(payload?.['settings'])];
  for (const source of nested) {
    if (!source) continue;
    for (const name of names) {
      const value = source[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
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
  const payload = toRecord(rec['payload']);
  if (!payload) return [];
  if (rec['type'] === 'event_msg') {
    if (payload['type'] === 'user_message') {
      const text = extractText(payload['message']);
      return text ? [{ role: 'user', text }] : [];
    }
    if (payload['type'] === 'agent_message' || payload['type'] === 'assistant_message') {
      const text = extractText(payload['message'] ?? payload['text']);
      return text ? [{ role: 'assistant', text }] : [];
    }
  }
  if (rec['type'] !== 'response_item') return [];
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

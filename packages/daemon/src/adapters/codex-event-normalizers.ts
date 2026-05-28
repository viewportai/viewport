import { randomUUID } from 'node:crypto';
import { toToolCallDetail, type SessionMessage } from '../core/types.js';

export function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join('');
  }
  if (typeof value !== 'object') return '';
  const rec = value as Record<string, unknown>;
  const direct =
    rec['text'] ?? rec['output_text'] ?? rec['content'] ?? rec['message'] ?? rec['output'];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) return extractText(direct);
  if (typeof direct === 'object' && direct !== null) return extractText(direct);

  const delta = rec['delta'];
  if (typeof delta === 'object' && delta !== null) {
    const text = extractText((delta as Record<string, unknown>)['text'] ?? delta);
    if (text) return text;
  }
  const item = rec['item'];
  if (typeof item === 'object' && item !== null) {
    const text = extractText(item);
    if (text) return text;
  }
  const finalResponse = rec['finalResponse'];
  if (typeof finalResponse === 'string') return finalResponse;
  const choices = rec['choices'];
  if (Array.isArray(choices)) {
    const out = choices
      .map((choice) => extractText(choice))
      .filter(Boolean)
      .join('');
    if (out) return out;
  }
  return '';
}

export function extractEventsStream(value: unknown): AsyncIterable<unknown> | null {
  if (isAsyncIterable(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const events = (value as Record<string, unknown>)['events'];
  if (isAsyncIterable(events)) return events;
  return null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || typeof value !== 'object') return false;
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

export function extractStreamText(value: unknown): string {
  if (!value || typeof value !== 'object') return extractText(value);
  const rec = value as Record<string, unknown>;
  const type = rec['type'];

  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = rec['item'];
    if (typeof item === 'object' && item !== null) {
      const itemRec = item as Record<string, unknown>;
      const itemType = itemRec['type'];
      if (itemType === 'agent_message' || itemType === 'reasoning') {
        return extractText(itemRec['text']);
      }
    }
  }

  return extractText(value);
}

export function extractStreamError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const type = rec['type'];
  if (type === 'turn.failed') {
    const err = rec['error'];
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const message = (err as Record<string, unknown>)['message'];
      if (typeof message === 'string' && message.trim()) return message;
    }
    return 'Codex turn failed';
  }
  if (type === 'error') {
    const message = rec['message'];
    return typeof message === 'string' && message.trim() ? message : 'Codex stream error';
  }
  return null;
}

function codexToolId(item: Record<string, unknown>): string {
  const candidates = [item['id'], item['call_id'], item['tool_call_id'], item['toolUseId']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return randomUUID();
}

export function extractToolCallEvent(value: unknown): SessionMessage | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec['type'] !== 'item.started') return null;
  const item =
    typeof rec['item'] === 'object' && rec['item'] !== null
      ? (rec['item'] as Record<string, unknown>)
      : null;
  if (!item || item['type'] !== 'function_call') return null;
  const toolName =
    (typeof item['name'] === 'string' && item['name']) ||
    (typeof item['tool_name'] === 'string' && item['tool_name']) ||
    'tool';
  const rawInput =
    typeof item['arguments'] === 'object' && item['arguments'] !== null
      ? (item['arguments'] as Record<string, unknown>)
      : {};
  return {
    type: 'tool_call',
    toolCallId: codexToolId(item),
    toolName,
    title: `${toolName} called`,
    input: rawInput,
    detail: toToolCallDetail(toolName, rawInput),
    status: 'in_progress',
    timestamp: Date.now(),
  };
}

export function extractToolCallUpdateEvent(value: unknown): SessionMessage | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec['type'] !== 'item.completed') return null;
  const item =
    typeof rec['item'] === 'object' && rec['item'] !== null
      ? (rec['item'] as Record<string, unknown>)
      : null;
  if (!item || item['type'] !== 'function_call') return null;
  return {
    type: 'tool_call_update',
    toolCallId: codexToolId(item),
    toolName:
      (typeof item['name'] === 'string' && item['name']) ||
      (typeof item['tool_name'] === 'string' && item['tool_name']) ||
      undefined,
    status: 'completed',
    output: extractText(item['output'] ?? item['result']),
    timestamp: Date.now(),
  };
}

export function extractTokenUsageEvent(value: unknown): SessionMessage | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (
    rec['type'] !== 'turn.completed' &&
    rec['type'] !== 'response.completed' &&
    rec['type'] !== 'result'
  ) {
    return null;
  }
  const usage =
    typeof rec['usage'] === 'object' && rec['usage'] !== null
      ? (rec['usage'] as Record<string, unknown>)
      : null;
  if (!usage) return null;
  const inputTokens = numberOrZero(usage['input_tokens'] ?? usage['inputTokens']);
  const outputTokens = numberOrZero(usage['output_tokens'] ?? usage['outputTokens']);
  const cacheReadInputTokens = numberOrZero(
    usage['cache_read_input_tokens'] ?? usage['cacheReadInputTokens'],
  );
  const cacheCreationInputTokens = numberOrZero(
    usage['cache_creation_input_tokens'] ?? usage['cacheCreationInputTokens'],
  );
  const hasCacheAccounting = cacheReadInputTokens > 0 || cacheCreationInputTokens > 0;
  const billableInputTokens = hasCacheAccounting
    ? Math.max(0, inputTokens - cacheReadInputTokens)
    : 0;
  const budgetedTotalTokens = billableInputTokens + outputTokens;
  const totalCostUsd = numberOrUndefined(
    rec['total_cost_usd'] ??
      rec['totalCostUsd'] ??
      usage['total_cost_usd'] ??
      usage['totalCostUsd'] ??
      usage['cost_usd'] ??
      usage['costUsd'],
  );
  const durationMs = numberOrUndefined(rec['duration_ms'] ?? rec['durationMs']);
  const numTurns = numberOrUndefined(rec['num_turns'] ?? rec['numTurns']);
  if (inputTokens <= 0 && outputTokens <= 0 && cacheReadInputTokens <= 0) return null;
  return {
    type: 'token_usage',
    inputTokens,
    inputTokenScope: hasCacheAccounting ? 'billable' : 'raw_provider',
    outputTokens,
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(hasCacheAccounting ? { billableInputTokens } : {}),
    budgetedTotalTokens,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(readModelUsage(rec['modelUsage']) ? { modelUsage: readModelUsage(rec['modelUsage']) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(numTurns !== undefined ? { numTurns } : {}),
    timestamp: Date.now(),
  };
}

function readModelUsage(
  value: unknown,
): Extract<SessionMessage, { type: 'token_usage' }>['modelUsage'] {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  > = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const inputTokens = numberOrZero(rec['inputTokens'] ?? rec['input_tokens']);
    const outputTokens = numberOrZero(rec['outputTokens'] ?? rec['output_tokens']);
    const costUsd = numberOrZero(rec['costUSD'] ?? rec['costUsd'] ?? rec['cost_usd']);
    const cacheReadInputTokens = numberOrZero(
      rec['cacheReadInputTokens'] ?? rec['cache_read_input_tokens'],
    );
    const cacheCreationInputTokens = numberOrZero(
      rec['cacheCreationInputTokens'] ?? rec['cache_creation_input_tokens'],
    );
    result[model] = {
      inputTokens,
      outputTokens,
      costUsd,
      ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
      ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function numberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = numberOrZero(value);
  return parsed > 0 ? parsed : undefined;
}

export function shouldFallbackToLegacyRun(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes('invalid input') ||
    normalized.includes('expected input') ||
    normalized.includes('must be a string') ||
    normalized.includes('unsupported input') ||
    normalized.includes('input type')
  );
}

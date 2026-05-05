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
    if (!role) return [];
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

function normalizeCodexRole(value: unknown): 'user' | 'assistant' | null {
  if (value === 'user') return 'user';
  if (value === 'assistant') return 'assistant';
  return null;
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

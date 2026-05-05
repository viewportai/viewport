import type { SessionMessage } from '../core/types.js';
import { toToolCallDetail } from '../core/types.js';

/**
 * Minimal shape of SDK messages we need to handle.
 * The actual SDK has 22+ message types; this boundary intentionally accepts the
 * loose SDK surface and emits the daemon's typed SessionMessage events.
 */
export interface SDKRawMessage {
  type: string;
  subtype?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK messages are untyped at our boundary
  [key: string]: any;
}

export interface AssistantNormalizationResult {
  messages: SessionMessage[];
  poisonedHistoryDetected: boolean;
}

export function normalizeSystemMessage(
  msg: SDKRawMessage,
  now: number,
  sessionId: string,
): SessionMessage[] | null {
  switch (msg.subtype) {
    case 'init':
      return [
        {
          type: 'system_status',
          status: 'initialized',
          sessionId: msg.session_id ?? sessionId,
          timestamp: now,
        },
      ];

    case 'status':
      return [
        {
          type: 'system_status',
          status: msg.status ?? 'unknown',
          sessionId,
          timestamp: now,
        },
      ];

    default:
      return null;
  }
}

export function normalizeAssistantMessage(
  msg: SDKRawMessage,
  now: number,
): AssistantNormalizationResult | null {
  if (msg.isReplay) return null;

  const betaMessage = msg.message;
  if (!betaMessage?.content) return null;

  const messages: SessionMessage[] = [];
  let poisonedHistoryDetected = false;

  for (const block of betaMessage.content) {
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.length === 0) continue;
      messages.push({
        type: 'agent_message',
        text,
        messageId: msg.uuid ?? `msg-${now}`,
        timestamp: now,
      });
      poisonedHistoryDetected ||= isPoisonedHistoryApiError(text);
    } else if (block.type === 'thinking') {
      messages.push({
        type: 'agent_thought_chunk',
        text: block.thinking ?? '',
        messageId: msg.uuid ?? `thought-${now}`,
        timestamp: now,
      });
    } else if (block.type === 'tool_use') {
      const input = block.input as Record<string, unknown>;
      messages.push({
        type: 'tool_call',
        toolCallId: block.id,
        toolName: block.name,
        title: block.name,
        input,
        detail: toToolCallDetail(block.name, input),
        status: 'in_progress',
        timestamp: now,
      });
    }
  }

  return messages.length > 0 ? { messages, poisonedHistoryDetected } : null;
}

export function normalizeUserMessage(msg: SDKRawMessage, now: number): SessionMessage[] | null {
  if (msg.isReplay) return null;

  const messages: SessionMessage[] = [];
  const content = msg.message?.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const output = extractToolResultText(block);
        messages.push({
          type: 'tool_call_update',
          toolCallId: block.tool_use_id ?? 'unknown',
          status: block.is_error ? 'error' : 'completed',
          output,
          timestamp: now,
        });
      }
    }
  }

  return messages.length > 0 ? messages : null;
}

export function extractToolResultText(block: SDKRawMessage): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: SDKRawMessage) => {
        if (c.type === 'text') return c.text ?? '';
        if (c.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function normalizeStreamEvent(msg: SDKRawMessage, now: number): SessionMessage[] | null {
  const event = msg.event;
  if (!event) return null;

  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return [
      {
        type: 'agent_message_chunk',
        text: event.delta.text,
        messageId: msg.uuid ?? `chunk-${now}`,
        timestamp: now,
      },
    ];
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
    return [
      {
        type: 'agent_thought_chunk',
        text: event.delta.thinking ?? '',
        messageId: msg.uuid ?? `thought-${now}`,
        timestamp: now,
      },
    ];
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    return [
      {
        type: 'tool_call',
        toolCallId: event.content_block.id,
        toolName: event.content_block.name,
        title: event.content_block.name,
        input: {},
        detail: toToolCallDetail(event.content_block.name, {}),
        status: 'in_progress',
        timestamp: now,
      },
    ];
  }

  return null;
}

export function normalizeToolProgressMessage(msg: SDKRawMessage, now: number): SessionMessage[] {
  return [
    {
      type: 'tool_call_update',
      toolCallId: msg.tool_use_id ?? 'unknown',
      toolName: msg.tool_name,
      status: 'completed',
      title: `Progress: ${msg.elapsed_time_seconds}s`,
      timestamp: now,
    },
  ];
}

export function isPoisonedHistoryApiError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('messages: text content blocks must be non-empty') ||
    normalized.includes('cache_control cannot be set for empty text blocks')
  );
}

export function resultErrorDetail(msg: SDKRawMessage): string | undefined {
  if (Array.isArray(msg.errors) && msg.errors.length > 0) {
    const first = msg.errors[0];
    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim();
    }
  }
  if (typeof msg.result === 'string' && msg.result.trim().length > 0) {
    return msg.result.trim();
  }
  if (typeof msg.error === 'string' && msg.error.trim().length > 0) {
    return msg.error.trim();
  }
  if (msg.error && typeof msg.error === 'object') {
    try {
      const serialized = JSON.stringify(msg.error);
      if (serialized.length > 0) return serialized;
    } catch {
      // ignore serialization errors
    }
  }
  return undefined;
}

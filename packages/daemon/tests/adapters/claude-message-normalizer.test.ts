import { describe, expect, it } from 'vitest';
import {
  extractToolResultText,
  normalizeAssistantMessage,
  normalizeStreamEvent,
  normalizeSystemMessage,
  normalizeToolProgressMessage,
  normalizeUserMessage,
  resultErrorDetail,
} from '../../src/adapters/claude-message-normalizer.js';

describe('Claude message normalizer', () => {
  it('normalizes system init and status messages', () => {
    expect(normalizeSystemMessage({ type: 'system', subtype: 'init' }, 100, 'sid')).toEqual([
      {
        type: 'system_status',
        status: 'initialized',
        sessionId: 'sid',
        timestamp: 100,
      },
    ]);

    expect(
      normalizeSystemMessage({ type: 'system', subtype: 'status', status: 'working' }, 101, 'sid'),
    ).toEqual([
      {
        type: 'system_status',
        status: 'working',
        sessionId: 'sid',
        timestamp: 101,
      },
    ]);
  });

  it('normalizes assistant text, thinking, and tool use blocks', () => {
    const result = normalizeAssistantMessage(
      {
        type: 'assistant',
        uuid: 'msg-1',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
          ],
        },
      },
      200,
    );

    expect(result?.poisonedHistoryDetected).toBe(false);
    expect(result?.messages.map((message) => message.type)).toEqual([
      'agent_message',
      'agent_thought_chunk',
      'tool_call',
    ]);
  });

  it('flags poisoned-history API error text without owning session state', () => {
    const result = normalizeAssistantMessage(
      {
        type: 'assistant',
        uuid: 'msg-2',
        message: {
          content: [{ type: 'text', text: 'messages: text content blocks must be non-empty' }],
        },
      },
      201,
    );

    expect(result?.poisonedHistoryDetected).toBe(true);
    expect(result?.messages).toHaveLength(1);
  });

  it('normalizes tool result user messages', () => {
    const messages = normalizeUserMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'file contents' }],
            },
          ],
        },
      },
      300,
    );

    expect(messages).toEqual([
      {
        type: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        output: 'file contents',
        timestamp: 300,
      },
    ]);
  });

  it('extracts readable text from mixed tool result content', () => {
    expect(
      extractToolResultText({
        type: 'tool_result',
        content: [
          { type: 'text', text: 'alpha' },
          { type: 'image' },
          { type: 'unknown' },
          { type: 'text', text: 'omega' },
        ],
      }),
    ).toBe('alpha\n[image]\nomega');
  });

  it('normalizes streaming text, thinking, and tool starts', () => {
    expect(
      normalizeStreamEvent(
        {
          type: 'stream_event',
          uuid: 'stream-1',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        },
        400,
      )?.[0],
    ).toMatchObject({ type: 'agent_message_chunk', text: 'hi' });

    expect(
      normalizeStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'thinking' },
          },
        },
        401,
      )?.[0],
    ).toMatchObject({ type: 'agent_thought_chunk', text: 'thinking' });

    expect(
      normalizeStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-2', name: 'Bash' },
          },
        },
        402,
      )?.[0],
    ).toMatchObject({ type: 'tool_call', toolCallId: 'tool-2', toolName: 'Bash' });
  });

  it('normalizes tool progress and result errors', () => {
    expect(
      normalizeToolProgressMessage(
        {
          type: 'tool_progress',
          tool_use_id: 'tool-1',
          tool_name: 'Bash',
          elapsed_time_seconds: 2,
        },
        500,
      ),
    ).toEqual([
      {
        type: 'tool_call_update',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        status: 'completed',
        title: 'Progress: 2s',
        timestamp: 500,
      },
    ]);

    expect(resultErrorDetail({ type: 'result', errors: ['first failure'] })).toBe('first failure');
    expect(resultErrorDetail({ type: 'result', error: { code: 'bad' } })).toBe('{"code":"bad"}');
  });
});

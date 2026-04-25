import { describe, expect, it } from 'vitest';
import { transcriptExcerptFromRichMessages } from '../../src/workflows/session-output.js';

describe('workflow session output helpers', () => {
  it('builds bounded transcript excerpts from rich text messages', () => {
    const excerpt = transcriptExcerptFromRichMessages(
      [
        { kind: 'text', role: 'user', text: 'first request', ts: '1', uuid: '1' },
        { kind: 'tool_use', toolName: 'Bash', toolId: 'tool-1', input: {}, ts: '2', uuid: '2' },
        { kind: 'text', role: 'assistant', text: 'first response', ts: '3', uuid: '3' },
        { kind: 'text', role: 'user', text: 'second request', ts: '4', uuid: '4' },
        {
          kind: 'text',
          role: 'assistant',
          text: 'x'.repeat(20),
          ts: '5',
          uuid: '5',
        },
      ],
      { maxMessages: 3, maxCharsPerMessage: 8 },
    );

    expect(excerpt).toEqual([
      { role: 'assistant', text: 'first re...' },
      { role: 'user', text: 'second r...' },
      { role: 'assistant', text: 'xxxxxxxx...' },
    ]);
  });
});

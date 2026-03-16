import { describe, expect, it } from 'vitest';
import { IncomingMessageSchema } from './lib/protocol';

describe('session alert protocol message', () => {
  it('accepts session-alert payloads from daemon', () => {
    const parsed = IncomingMessageSchema.safeParse({
      type: 'session-alert',
      sessionId: 'sess-1',
      directoryId: 'dir-1',
      requiresAttention: true,
      reason: 'permission',
      toolName: 'Bash',
      requestId: 'req-1',
      timestamp: Date.now(),
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('session-alert');
    expect(parsed.data.sessionId).toBe('sess-1');
    expect(parsed.data.requiresAttention).toBe(true);
  });
});

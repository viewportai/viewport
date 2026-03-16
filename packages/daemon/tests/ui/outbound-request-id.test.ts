import { describe, expect, it } from 'vitest';
import { ensureOutboundRequestId } from './lib/request-id';

describe('connection-store outbound requestId', () => {
  it('adds requestId when missing', () => {
    const payload = ensureOutboundRequestId({
      type: 'watch-discovered-session',
      sessionId: 'sess-1',
      directoryId: 'dir-1',
    });

    expect(payload.type).toBe('watch-discovered-session');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.directoryId).toBe('dir-1');
    expect(typeof payload.requestId).toBe('string');
    expect((payload.requestId as string).length).toBeGreaterThan(0);
  });

  it('preserves existing requestId', () => {
    const payload = ensureOutboundRequestId({
      type: 'subscribe',
      sessionId: 'sess-2',
      requestId: 'req-existing',
    });

    expect(payload.requestId).toBe('req-existing');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { RelayLogger } from '../src/logger.js';

describe('relay logger', () => {
  it('redacts sensitive payload details before storing or printing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const logger = new RelayLogger(10);
      logger.warn('daemon_frame_rejected', {
        workspaceId: 'workspace_1',
        token: 'vp_secret',
        nested: {
          authorization: 'Bearer secret',
          payload: { prompt: 'private prompt' },
          safe: 'kept',
        },
      });

      expect(logger.recent()[0]?.details).toEqual({
        workspaceId: 'workspace_1',
        token: '[redacted]',
        nested: {
          authorization: '[redacted]',
          payload: '[redacted]',
          safe: 'kept',
        },
      });
      expect(String(spy.mock.calls[0]?.[0] ?? '')).not.toContain('private prompt');
      expect(String(spy.mock.calls[0]?.[0] ?? '')).not.toContain('vp_secret');
    } finally {
      spy.mockRestore();
    }
  });
});

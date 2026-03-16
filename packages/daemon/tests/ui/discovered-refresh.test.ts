import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredSessionInfo, RichSessionMessage } from './lib/protocol-types';
import { refreshSelectedDiscoveredSessionFromUpdate } from './lib/discovered-refresh';

function discovered(overrides: Partial<DiscoveredSessionInfo>): DiscoveredSessionInfo {
  return {
    id: 'sess-1',
    directoryId: 'dir-1',
    summary: 'Codex session',
    lastActivity: 100,
    messageCount: 10,
    resumable: true,
    ...overrides,
  };
}

describe('discovered refresh fallback', () => {
  it('refreshes selected discovered session when metadata advances without tail push', async () => {
    const fetchMessages = vi.fn(
      async () =>
        [
          {
            kind: 'text',
            role: 'assistant',
            text: 'new message from codex',
            ts: new Date().toISOString(),
            uuid: 'msg-11',
          },
        ] as RichSessionMessage[],
    );
    const emitTail = vi.fn();

    const refreshed = await refreshSelectedDiscoveredSessionFromUpdate(
      {
        previousSessions: [discovered({ messageCount: 10, lastActivity: 100 })],
        updatedSessions: [discovered({ messageCount: 11, lastActivity: 200 })],
        selectedSessionId: 'sess-1',
        selectedDirectoryId: 'dir-1',
        selectedIsActive: false,
      },
      { fetchMessages, emitTail },
    );

    expect(refreshed).toBe(true);
    expect(fetchMessages).toHaveBeenCalledWith('dir-1', 'sess-1');
    expect(emitTail).toHaveBeenCalledWith('sess-1', 'dir-1', expect.any(Array));
  });

  it('does not refresh when selected session is active', async () => {
    const fetchMessages = vi.fn(async () => [] as RichSessionMessage[]);
    const emitTail = vi.fn();

    const refreshed = await refreshSelectedDiscoveredSessionFromUpdate(
      {
        previousSessions: [discovered({ messageCount: 10 })],
        updatedSessions: [discovered({ messageCount: 11 })],
        selectedSessionId: 'sess-1',
        selectedDirectoryId: 'dir-1',
        selectedIsActive: true,
      },
      { fetchMessages, emitTail },
    );

    expect(refreshed).toBe(false);
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(emitTail).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { dedupeDiscoveredSessionInfo } from './lib/discovered-session-dedupe';
import type { DiscoveredSessionInfo } from './lib/protocol-types';

function discovered(overrides: Partial<DiscoveredSessionInfo>): DiscoveredSessionInfo {
  return {
    id: 'sess-1',
    directoryId: 'dir-1',
    summary: 'hello',
    lastActivity: 100,
    messageCount: 1,
    resumable: true,
    ...overrides,
  };
}

describe('dedupeDiscoveredSessionInfo', () => {
  it('collapses duplicates in the same directory and keeps richer metadata', () => {
    const deduped = dedupeDiscoveredSessionInfo([
      discovered({ summary: '', messageCount: 0, lastActivity: 100 }),
      discovered({ summary: 'what agent are you', messageCount: 3, lastActivity: 200 }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({
      id: 'sess-1',
      directoryId: 'dir-1',
      summary: 'what agent are you',
      messageCount: 3,
      lastActivity: 200,
    });
  });

  it('keeps same session id in different directories as separate entries', () => {
    const deduped = dedupeDiscoveredSessionInfo([
      discovered({ id: 'sess-1', directoryId: 'dir-a' }),
      discovered({ id: 'sess-1', directoryId: 'dir-b' }),
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.map((s) => s.directoryId).sort()).toEqual(['dir-a', 'dir-b']);
  });
});

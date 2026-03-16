import { describe, expect, it } from 'vitest';
import { dedupeDiscoveredSessions } from '../../src/core/discovered-sessions.js';
import type { DiscoveredSession } from '../../src/core/interfaces.js';

function discovered(overrides: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    agentId: 'claude',
    sessionId: 'sess-1',
    summary: 'hello',
    lastModified: 100,
    resumable: true,
    messageCount: 1,
    ...overrides,
  };
}

describe('dedupeDiscoveredSessions', () => {
  it('keeps one record per session id and prefers richer/newer metadata', () => {
    const deduped = dedupeDiscoveredSessions([
      discovered({ summary: '', messageCount: 0, lastModified: 100 }),
      discovered({ summary: 'what agent are you', messageCount: 3, lastModified: 200 }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({
      sessionId: 'sess-1',
      summary: 'what agent are you',
      messageCount: 3,
      lastModified: 200,
    });
  });

  it('keeps sessions sorted by most recent activity', () => {
    const deduped = dedupeDiscoveredSessions([
      discovered({ sessionId: 'sess-2', lastModified: 5 }),
      discovered({ sessionId: 'sess-1', lastModified: 10 }),
      discovered({ sessionId: 'sess-3', lastModified: 1 }),
    ]);

    expect(deduped.map((s) => s.sessionId)).toEqual(['sess-1', 'sess-2', 'sess-3']);
  });
});

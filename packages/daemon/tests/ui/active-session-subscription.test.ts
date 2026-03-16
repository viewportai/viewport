import { describe, expect, it } from 'vitest';
import { reconcileActiveSubscription } from './lib/active-session-subscription';

describe('active session subscription scope', () => {
  it('subscribes only to selected active session', () => {
    const result = reconcileActiveSubscription(
      { subscribedSessionId: null },
      {
        connectionStatus: 'connected',
        selectedSessionId: 'sess-a',
        selectedDirectoryId: 'dir-1',
        sessions: {
          'sess-a': {
            id: 'sess-a',
            directoryId: 'dir-1',
            lastSeq: 12,
          },
          'sess-b': {
            id: 'sess-b',
            directoryId: 'dir-1',
            lastSeq: 3,
          },
        },
      },
    );

    expect(result.commands).toEqual([{ type: 'subscribe', sessionId: 'sess-a', lastSeq: 12 }]);
    expect(result.state.subscribedSessionId).toBe('sess-a');
  });

  it('switches from A to B by unsubscribing A then subscribing B', () => {
    const result = reconcileActiveSubscription(
      { subscribedSessionId: 'sess-a' },
      {
        connectionStatus: 'connected',
        selectedSessionId: 'sess-b',
        selectedDirectoryId: 'dir-1',
        sessions: {
          'sess-a': {
            id: 'sess-a',
            directoryId: 'dir-1',
            lastSeq: 12,
          },
          'sess-b': {
            id: 'sess-b',
            directoryId: 'dir-1',
            lastSeq: 8,
          },
        },
      },
    );

    expect(result.commands).toEqual([
      { type: 'unsubscribe', sessionId: 'sess-a' },
      { type: 'subscribe', sessionId: 'sess-b', lastSeq: 8 },
    ]);
    expect(result.state.subscribedSessionId).toBe('sess-b');
  });

  it('does not subscribe when selected session is discovered (not active)', () => {
    const result = reconcileActiveSubscription(
      { subscribedSessionId: null },
      {
        connectionStatus: 'connected',
        selectedSessionId: 'disc-1',
        selectedDirectoryId: 'dir-1',
        sessions: {
          'sess-a': {
            id: 'sess-a',
            directoryId: 'dir-1',
            lastSeq: 4,
          },
        },
      },
    );

    expect(result.commands).toEqual([]);
    expect(result.state.subscribedSessionId).toBeNull();
  });

  it('resets when disconnected and resubscribes on reconnect', () => {
    const disconnected = reconcileActiveSubscription(
      { subscribedSessionId: 'sess-a' },
      {
        connectionStatus: 'disconnected',
        selectedSessionId: 'sess-a',
        selectedDirectoryId: 'dir-1',
        sessions: {
          'sess-a': {
            id: 'sess-a',
            directoryId: 'dir-1',
            lastSeq: 9,
          },
        },
      },
    );

    expect(disconnected.commands).toEqual([]);
    expect(disconnected.state.subscribedSessionId).toBeNull();

    const reconnected = reconcileActiveSubscription(disconnected.state, {
      connectionStatus: 'connected',
      selectedSessionId: 'sess-a',
      selectedDirectoryId: 'dir-1',
      sessions: {
        'sess-a': {
          id: 'sess-a',
          directoryId: 'dir-1',
          lastSeq: 9,
        },
      },
    });

    expect(reconnected.commands).toEqual([{ type: 'subscribe', sessionId: 'sess-a', lastSeq: 9 }]);
    expect(reconnected.state.subscribedSessionId).toBe('sess-a');
  });
});

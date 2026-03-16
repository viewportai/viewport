import { describe, expect, it } from 'vitest';
import {
  activeChatViewKey,
  discoveredChatViewKey,
  discoveredSessionKey,
  isErroredEndReason,
  sameScopedSession,
  sessionEndKey,
  sessionPermissionKey,
} from './lib/session-scope.ts';

describe('test-ui2 session scope helpers', () => {
  it('builds discovered session keys with directory scope', () => {
    expect(discoveredSessionKey({ id: 'sess-1', directoryId: 'dir-a' })).toBe('dir-a::sess-1');
  });

  it('matches by id and directory when directory is provided', () => {
    expect(
      sameScopedSession(
        { id: 'sess-1', directoryId: 'dir-a' },
        { id: 'sess-1', directoryId: 'dir-a' },
      ),
    ).toBe(true);
    expect(
      sameScopedSession(
        { id: 'sess-1', directoryId: 'dir-a' },
        { id: 'sess-1', directoryId: 'dir-b' },
      ),
    ).toBe(false);
  });

  it('falls back to id-only match when target directory is missing', () => {
    expect(sameScopedSession({ id: 'sess-1', directoryId: 'dir-a' }, { id: 'sess-1' })).toBe(true);
  });

  it('produces deterministic keys for chat/rendering and dedupe', () => {
    expect(activeChatViewKey('sess-1', 'dir-a')).toBe('active-dir-a-sess-1');
    expect(activeChatViewKey('sess-1')).toBe('active-none-sess-1');
    expect(discoveredChatViewKey({ id: 'sess-1', directoryId: 'dir-a' })).toBe(
      'discovered-dir-a-sess-1',
    );
    expect(sessionPermissionKey('sess-1', 'req-1')).toBe('sess-1:req-1');
    expect(sessionEndKey('sess-1', undefined, undefined)).toBe('sess-1:0:');
  });

  it('detects errored end reasons from normalized daemon strings', () => {
    expect(isErroredEndReason(undefined)).toBe(false);
    expect(isErroredEndReason('completed')).toBe(false);
    expect(isErroredEndReason('error: adapter failure')).toBe(true);
    expect(isErroredEndReason('Exited with code 1')).toBe(true);
    expect(isErroredEndReason('history_poisoned')).toBe(true);
    expect(isErroredEndReason('request failed')).toBe(true);
  });
});

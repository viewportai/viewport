import { describe, expect, it } from 'vitest';
import {
  discoveredWatchKey,
  matchesDiscoveredWatch,
  resolveMatchedDiscoveredWatch,
  removeDiscoveredWatch,
} from '../../src/server/discovered-watch-key.js';

describe('discovered-watch-key', () => {
  it('builds directory-scoped keys', () => {
    expect(discoveredWatchKey('sess-1', 'dir-1')).toBe('dir-1::sess-1');
  });

  it('matches scoped key or wildcard fallback', () => {
    const watched = new Set<string>(['dir-1::sess-1', '*::sess-2']);
    expect(matchesDiscoveredWatch(watched, 'sess-1', 'dir-1')).toBe(true);
    expect(matchesDiscoveredWatch(watched, 'sess-1', 'dir-2')).toBe(false);
    expect(matchesDiscoveredWatch(watched, 'sess-2', 'dir-3')).toBe(true);
  });

  it('resolves a matched alias by scoped watch first', () => {
    const watched = new Set<string>(['dir-1::old-id']);
    const matched = resolveMatchedDiscoveredWatch(watched, ['new-id', 'old-id'], 'dir-1');
    expect(matched).toBe('old-id');
  });

  it('removes only targeted scope when directory is provided', () => {
    const watched = new Set<string>(['dir-1::sess-1', 'dir-2::sess-1', '*::sess-1']);
    removeDiscoveredWatch(watched, 'sess-1', 'dir-1');
    expect(watched.has('dir-1::sess-1')).toBe(false);
    expect(watched.has('dir-2::sess-1')).toBe(true);
    expect(watched.has('*::sess-1')).toBe(true);
  });

  it('removes all scopes for a session when directory is omitted', () => {
    const watched = new Set<string>([
      'dir-1::sess-1',
      'dir-2::sess-1',
      '*::sess-1',
      'dir-3::sess-2',
    ]);
    removeDiscoveredWatch(watched, 'sess-1');
    expect(watched).toEqual(new Set(['dir-3::sess-2']));
  });
});

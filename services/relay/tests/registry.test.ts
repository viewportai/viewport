import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from '../src/registry.js';

describe('connection registry', () => {
  it('creates and reuses workspace state', () => {
    const registry = new ConnectionRegistry();
    const a = registry.getOrCreate('workspace-a');
    const b = registry.getOrCreate('workspace-a');
    expect(a).toBe(b);
  });

  it('prunes empty workspaces after ttl', () => {
    const registry = new ConnectionRegistry();
    const state = registry.getOrCreate('workspace-a');
    state.lastActivityAt = Date.now() - 10_000;
    const removed = registry.pruneEmpty(1_000);
    expect(removed).toEqual(['workspace-a']);
  });

  it('does not prune active workspace', () => {
    const registry = new ConnectionRegistry();
    const state = registry.getOrCreate('workspace-a');
    // Fake active daemon reference.
    state.daemon = {} as never;
    state.lastActivityAt = Date.now() - 100_000;
    const removed = registry.pruneEmpty(1_000);
    expect(removed).toEqual([]);
  });

  it('only clears the daemon that currently owns the workspace scope', () => {
    const registry = new ConnectionRegistry();
    const state = registry.getOrCreate('workspace-a');
    const stale = {} as never;
    const current = {} as never;

    state.daemon = current;
    expect(registry.clearDaemon('workspace-a', stale)).toBe(false);
    expect(state.daemon).toBe(current);

    expect(registry.clearDaemon('workspace-a', current)).toBe(true);
    expect(state.daemon).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { SupervisionManager } from '../../src/hooks/supervision.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';

function mockClient(): ConnectedClient {
  return {
    send: () => {},
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
}

describe('SupervisionManager', () => {
  it('starts unsupervised', () => {
    const mgr = new SupervisionManager();
    expect(mgr.isSupervised('session-1')).toBe(false);
    expect(mgr.getSupervisors('session-1').size).toBe(0);
  });

  it('supervises a session', () => {
    const mgr = new SupervisionManager();
    const client = mockClient();
    mgr.supervise('session-1', client);
    expect(mgr.isSupervised('session-1')).toBe(true);
    expect(mgr.getSupervisors('session-1').size).toBe(1);
  });

  it('supports multiple supervisors', () => {
    const mgr = new SupervisionManager();
    const c1 = mockClient();
    const c2 = mockClient();
    mgr.supervise('session-1', c1);
    mgr.supervise('session-1', c2);
    expect(mgr.getSupervisors('session-1').size).toBe(2);
  });

  it('unsupervises a session', () => {
    const mgr = new SupervisionManager();
    const client = mockClient();
    mgr.supervise('session-1', client);
    mgr.unsupervise('session-1', client);
    expect(mgr.isSupervised('session-1')).toBe(false);
  });

  it('unsupervise is safe when not supervised', () => {
    const mgr = new SupervisionManager();
    const client = mockClient();
    mgr.unsupervise('nonexistent', client);
    expect(mgr.isSupervised('nonexistent')).toBe(false);
  });

  it('removeClient cleans up all sessions', () => {
    const mgr = new SupervisionManager();
    const client = mockClient();
    mgr.supervise('session-1', client);
    mgr.supervise('session-2', client);
    const released = mgr.removeClient(client);
    expect(released).toEqual(['session-1', 'session-2']);
    expect(mgr.isSupervised('session-1')).toBe(false);
    expect(mgr.isSupervised('session-2')).toBe(false);
  });

  it('removeClient does not release sessions with other supervisors', () => {
    const mgr = new SupervisionManager();
    const c1 = mockClient();
    const c2 = mockClient();
    mgr.supervise('session-1', c1);
    mgr.supervise('session-1', c2);
    const released = mgr.removeClient(c1);
    expect(released).toEqual([]);
    expect(mgr.isSupervised('session-1')).toBe(true);
    expect(mgr.getSupervisors('session-1').size).toBe(1);
  });

  it('getSupervisedSessions lists all supervised', () => {
    const mgr = new SupervisionManager();
    const client = mockClient();
    mgr.supervise('a', client);
    mgr.supervise('b', client);
    expect(mgr.getSupervisedSessions().sort()).toEqual(['a', 'b']);
  });

  it('removeClient returns empty when client has no sessions', () => {
    const mgr = new SupervisionManager();
    const client = mockClient();
    expect(mgr.removeClient(client)).toEqual([]);
  });

  it('evicts oldest supervised sessions when cap is reached', () => {
    const mgr = new SupervisionManager(2);
    const client = mockClient();
    mgr.supervise('session-1', client);
    mgr.supervise('session-2', client);
    mgr.supervise('session-3', client);

    expect(mgr.isSupervised('session-1')).toBe(false);
    expect(mgr.isSupervised('session-2')).toBe(true);
    expect(mgr.isSupervised('session-3')).toBe(true);
    expect(mgr.getSupervisedSessions().sort()).toEqual(['session-2', 'session-3']);
  });
});

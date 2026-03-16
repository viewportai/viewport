import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter } from '../../src/core/events.js';
import type { DaemonEvents } from '../../src/core/events.js';

describe('TypedEventEmitter', () => {
  it('emits and receives events with correct data', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const handler = vi.fn();

    bus.on('session:started', handler);
    bus.emit('session:started', {
      sessionId: 'abc',
      directoryId: 'dir-1',
      config: {
        agent: 'claude',
        gitTracker: {
          enabled: true,
          commitOn: ['Edit'],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/session-',
          commitAuthor: 'Test <noreply@example.test>',
          maxCommitsPerSession: 100,
          worktreeRoot: '.viewport/worktrees',
        },
        permissions: { autoApprove: [], requireApproval: [], deny: [] },
        trust: 'operator',
      },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'abc', directoryId: 'dir-1' }),
    );
  });

  it('supports once() for single-fire handlers', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const handler = vi.fn();

    bus.once('config:changed', handler);
    bus.emit('config:changed', { directoryId: 'dir-1' });
    bus.emit('config:changed', { directoryId: 'dir-2' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ directoryId: 'dir-1' });
  });

  it('removes listeners with off()', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const handler = vi.fn();

    bus.on('session:ended', handler);
    bus.off('session:ended', handler);
    bus.emit('session:ended', { sessionId: 'abc', reason: 'completed' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('removes all listeners for an event', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('session:ended', handler1);
    bus.on('session:ended', handler2);
    bus.removeAllListeners('session:ended');
    bus.emit('session:ended', { sessionId: 'abc', reason: 'completed' });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });

  it('removes all listeners across all events', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('session:started', handler1);
    bus.on('session:ended', handler2);
    bus.removeAllListeners();
    bus.emit('session:started', {
      sessionId: 'abc',
      directoryId: 'dir-1',
      config: {
        agent: 'claude',
        gitTracker: {
          enabled: true,
          commitOn: [],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/',
          commitAuthor: 'Test <noreply@example.test>',
          maxCommitsPerSession: 100,
          worktreeRoot: '.viewport/worktrees',
        },
        permissions: { autoApprove: [], requireApproval: [], deny: [] },
        trust: 'operator',
      },
    });
    bus.emit('session:ended', { sessionId: 'abc', reason: 'done' });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });

  it('reports correct listener count', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const handler = vi.fn();

    expect(bus.listenerCount('session:ended')).toBe(0);

    bus.on('session:ended', handler);
    expect(bus.listenerCount('session:ended')).toBe(1);

    bus.on('session:ended', handler);
    expect(bus.listenerCount('session:ended')).toBe(2);

    bus.off('session:ended', handler);
    expect(bus.listenerCount('session:ended')).toBe(1);
  });

  it('supports multiple event types independently', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const sessionHandler = vi.fn();
    const permissionHandler = vi.fn();

    bus.on('session:message', sessionHandler);
    bus.on('permission:requested', permissionHandler);

    bus.emit('session:message', {
      sessionId: 'abc',
      message: { type: 'agent_message', text: 'hello', messageId: 'm1', timestamp: Date.now() },
    });

    expect(sessionHandler).toHaveBeenCalledOnce();
    expect(permissionHandler).not.toHaveBeenCalled();
  });

  it('returns true from emit when listeners exist', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    bus.on('config:changed', vi.fn());

    expect(bus.emit('config:changed', {})).toBe(true);
  });

  it('returns false from emit when no listeners exist', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();

    expect(bus.emit('config:changed', {})).toBe(false);
  });

  it('supports method chaining', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const handler = vi.fn();

    const result = bus.on('config:changed', handler).on('session:ended', handler);

    expect(result).toBe(bus);
  });
});

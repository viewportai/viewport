import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from '../../src/core/events.js';
import type { DaemonEvents } from '../../src/core/events.js';
import { registerWsDaemonEventBridge } from '../../src/server/ws-daemon-event-bridge.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';
import type { Daemon } from '../../src/core/daemon.js';

function client(subscriptions: string[] = []): ConnectedClient & {
  send: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(),
    subscriptions: new Set(subscriptions),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
}

describe('registerWsDaemonEventBridge hook privacy', () => {
  it('does not broadcast raw Stop hook messages beyond session subscribers', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const daemon = bus as unknown as Daemon;
    const subscribed = client(['s1']);
    const other = client();
    const cleanup = registerWsDaemonEventBridge({
      daemon,
      clients: new Set([subscribed, other]),
      ringBuffers: new Map(),
      sessionStreaming: new Map(),
      broadcastUpdate: () => {},
    });

    bus.emit('hook:stop', {
      sessionId: 's1',
      adapter: 'claude',
      lastMessage: '```viewport-plan\n{"metadata":{"secret":"do-not-broadcast"}}\n```',
    });

    expect(subscribed.send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(subscribed.send.mock.calls[0]?.[0]))).toMatchObject({
      type: 'hook-stop',
      sessionId: 's1',
      adapter: 'claude',
    });
    expect(String(subscribed.send.mock.calls[0]?.[0])).not.toContain('do-not-broadcast');
    expect(other.send).not.toHaveBeenCalled();

    cleanup();
  });

  it('sends Plan proposal hook frames only to session subscribers', () => {
    const bus = new TypedEventEmitter<DaemonEvents>();
    const daemon = bus as unknown as Daemon;
    const subscribed = client(['s1']);
    const other = client();
    const cleanup = registerWsDaemonEventBridge({
      daemon,
      clients: new Set([subscribed, other]),
      ringBuffers: new Map(),
      sessionStreaming: new Map(),
      broadcastUpdate: () => {},
    });

    bus.emit('hook:plan-proposed', {
      sessionId: 's1',
      adapter: 'claude',
      cwd: '/Users/alice/private-repo',
      title: 'Review plan',
      body: '## Plan',
      metadata: { providerModel: 'sonnet' },
    });

    expect(subscribed.send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(subscribed.send.mock.calls[0]?.[0]))).toMatchObject({
      type: 'hook-plan-proposed',
      sessionId: 's1',
      title: 'Review plan',
      metadata: { providerModel: 'sonnet' },
    });
    expect(String(subscribed.send.mock.calls[0]?.[0])).not.toContain('/Users/alice/private-repo');
    expect(JSON.parse(String(subscribed.send.mock.calls[0]?.[0]))).not.toHaveProperty('cwd');
    expect(other.send).not.toHaveBeenCalled();

    cleanup();
  });
});

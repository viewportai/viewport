import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { RelayBackplane } from '../src/backplane.js';
import { loadConfig } from '../src/config.js';
import { RelayLogger } from '../src/logger.js';
import { RelayMetrics } from '../src/metrics.js';
import { ConnectionRegistry } from '../src/registry.js';
import { registerConnection, routeBusFrame } from '../src/relay-routing.js';
import { FixedWindowRateLimiter, TokenBucketRateLimiter } from '../src/security.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  closeCalls: Array<{ code: number; reason: string }> = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close');
  }
}

function safeSendToFake(ws: WebSocket, payload: string): boolean {
  (ws as unknown as FakeWs).send(payload);
  return true;
}

type TestBackplane = RelayBackplane & {
  resolvePresence: ReturnType<typeof vi.fn>;
  upsertPresence: ReturnType<typeof vi.fn>;
  publishClientToDaemon: ReturnType<typeof vi.fn>;
  publishDaemonToClients: ReturnType<typeof vi.fn>;
  pullFrames: ReturnType<typeof vi.fn>;
};

function createTestBackplane(overrides: Partial<TestBackplane> = {}): TestBackplane {
  return {
    mode: 'single',
    crossRelayEnabled: false,
    pollIntervalMs: null,
    resolvePresence: vi.fn().mockResolvedValue(null),
    upsertPresence: vi.fn().mockResolvedValue(undefined),
    publishClientToDaemon: vi.fn().mockResolvedValue(false),
    publishDaemonToClients: vi.fn().mockResolvedValue(false),
    pullFrames: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('relay routing', () => {
  it('accepts version 3 relay_key_exchange_init frame shape', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_KEX_INIT_RATE_PER_MINUTE: '10',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();

    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: () => true,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'runtime', workspaceId: 'workspace_demo' },
    );

    const validInitV3 = JSON.stringify({
      type: 'relay_key_exchange_init',
      version: 3,
      profile: 'noise-ik',
      requestId: 'kex-v3-1',
      clientEphemeralPublicKey: 'ephemeral',
      encryptedClientStatic: 'cipher',
    });

    (clientWs as unknown as FakeWs).emit('message', Buffer.from(validInitV3));

    expect(closed).toHaveLength(0);
  });

  it('rate-limits repeated relay_key_exchange_init frames per client', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_KEX_INIT_RATE_PER_MINUTE: '1',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();

    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;

    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: () => true,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'runtime', workspaceId: 'workspace_demo' },
    );

    const validInit = JSON.stringify({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId: 'kex-1',
      clientPublicKey: 'pub',
      clientNonce: 'nonce',
      clientProof: 'proof',
    });

    (clientWs as unknown as FakeWs).emit('message', Buffer.from(validInit));
    (clientWs as unknown as FakeWs).emit('message', Buffer.from(validInit));

    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ code: 4008, reason: 'key exchange rate limit exceeded' });
  });

  it('preserves key exchange rate limits across client reconnects', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_KEX_INIT_RATE_PER_MINUTE: '1',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];
    const sharedKexLimiter = new FixedWindowRateLimiter(
      config.maxKeyExchangeInitPerMinute,
      60_000,
      config.kexRateLimiterMaxKeys,
    );

    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: () => true,
      closeWithReason: (ws: WebSocket, code: number, reason: string) => {
        closed.push({ code, reason });
        (ws as unknown as FakeWs).close(code, reason);
      },
      kexFrameLimiter: sharedKexLimiter,
    };

    const firstClientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      context,
      firstClientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'runtime', workspaceId: 'workspace_demo' },
    );

    const validInit = JSON.stringify({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId: 'kex-reconnect-1',
      clientPublicKey: 'pub',
      clientNonce: 'nonce',
      clientProof: 'proof',
    });
    (firstClientWs as unknown as FakeWs).emit('message', Buffer.from(validInit));
    (firstClientWs as unknown as FakeWs).close(1000, 'done');

    const secondClientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      context,
      secondClientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'runtime', workspaceId: 'workspace_demo' },
    );
    (secondClientWs as unknown as FakeWs).emit('message', Buffer.from(validInit));

    expect(closed).toContainEqual({ code: 4008, reason: 'key exchange rate limit exceeded' });
  });

  it('rejects client frames when profile mismatches admission claims', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_KEX_INIT_RATE_PER_MINUTE: '10',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: () => true,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      {
        clientId: 'client_demo',
        scope: 'runtime',
        e2eeProfile: 'noise-ikpsk2',
        workspaceId: 'workspace_demo',
      },
    );

    const mismatchedInit = JSON.stringify({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId: 'kex-mismatch',
      clientPublicKey: 'pub',
      clientNonce: 'nonce',
      clientProof: 'proof',
    });
    (clientWs as unknown as FakeWs).emit('message', Buffer.from(mismatchedInit));
    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ code: 4008, reason: 'client frame profile mismatch' });
  });

  it('accepts stronger daemon control frame profile than daemon admission profile', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const daemonWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: () => true,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      daemonWs,
      'workspace-daemon',
      'workspace_demo',
      '127.0.0.1',
      { e2eeProfile: 'noise-ik', workspaceId: 'workspace_demo' },
    );

    const strongerProfileResponse = JSON.stringify({
      type: 'relay_key_exchange_response',
      version: 3,
      profile: 'noise-ikpsk2',
      requestId: 'kex-upgrade',
      daemonPublicKey: 'pub',
      daemonEphemeralPublicKey: 'eph',
      encryptedMetadata: 'meta',
      sessionId: 'session-1',
      epoch: 1,
      proof: 'proof',
    });
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(strongerProfileResponse));
    expect(closed).toHaveLength(0);
  });

  it('rejects runtime frames for pairing-scoped clients', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: safeSendToFake,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'pairing', workspaceId: 'workspace_demo' },
    );

    const runtimeInit = JSON.stringify({
      type: 'relay_key_exchange_init',
      version: 3,
      profile: 'noise-ik',
      requestId: 'kex-v3-runtime',
      clientEphemeralPublicKey: 'ephemeral',
      encryptedClientStatic: 'cipher',
    });
    (clientWs as unknown as FakeWs).emit('message', Buffer.from(runtimeInit));

    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ code: 4008, reason: 'pairing scope only' });
  });

  it('rate-limits runtime e2ee frames per client', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_RUNTIME_RATE_PER_MINUTE: '1',
      RELAY_RUNTIME_RATE_PER_MINUTE_WORKSPACE: '100',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: safeSendToFake,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'runtime', workspaceId: 'workspace_demo' },
    );

    const envelope1 = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-1',
      epoch: 1,
      seq: 1,
      iv: 'iv-1',
      tag: 'tag-1',
      ciphertext: 'cipher-1',
    });
    const envelope2 = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-1',
      epoch: 1,
      seq: 2,
      iv: 'iv-2',
      tag: 'tag-2',
      ciphertext: 'cipher-2',
    });
    (clientWs as unknown as FakeWs).emit('message', Buffer.from(envelope1));
    (clientWs as unknown as FakeWs).emit('message', Buffer.from(envelope2));

    expect(closed).toContainEqual({ code: 4008, reason: 'runtime rate limit exceeded' });
  });

  it('rate-limits runtime e2ee frames at workspace aggregate scope', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_RUNTIME_RATE_PER_MINUTE: '100',
      RELAY_RUNTIME_RATE_PER_MINUTE_WORKSPACE: '1',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const runtimeClientLimiter = new TokenBucketRateLimiter(100, 60_000);
    const runtimeWorkspaceLimiter = new TokenBucketRateLimiter(1, 60_000);
    const closedA: Array<{ code: number; reason: string }> = [];
    const closedB: Array<{ code: number; reason: string }> = [];
    const clientWsA = new FakeWs() as unknown as WebSocket;
    const clientWsB = new FakeWs() as unknown as WebSocket;

    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      runtimeClientLimiter,
      runtimeWorkspaceLimiter,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) => {
        const bucket = ws === clientWsA ? closedA : closedB;
        bucket.push({ code, reason });
        (ws as unknown as FakeWs).close(code, reason);
      },
    };
    registerConnection(context, clientWsA, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_a',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, clientWsB, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_b',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });

    const envelope = (seq: number) =>
      JSON.stringify({
        type: 'e2ee',
        version: 2,
        profile: 'noise-ik',
        sessionId: 'sess-1',
        epoch: 1,
        seq,
        iv: `iv-${seq}`,
        tag: `tag-${seq}`,
        ciphertext: `cipher-${seq}`,
      });

    (clientWsA as unknown as FakeWs).emit('message', Buffer.from(envelope(1)));
    (clientWsB as unknown as FakeWs).emit('message', Buffer.from(envelope(2)));

    expect(closedA).toHaveLength(0);
    expect(closedB).toContainEqual({ code: 4008, reason: 'runtime rate limit exceeded' });
  });

  it('rate-limits daemon frames per workspace', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_DAEMON_RUNTIME_RATE_PER_MINUTE: '1',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const daemonWs = new FakeWs() as unknown as WebSocket;
    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) => {
        closed.push({ code, reason });
        (ws as unknown as FakeWs).close(code, reason);
      },
    };

    registerConnection(context, daemonWs, 'workspace-daemon', 'workspace_demo', '127.0.0.1', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
    });

    const frame = JSON.stringify({
      type: 'relay_key_update_required',
      sessionId: 'session-limited',
      nextEpoch: 2,
    });

    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(frame));
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(frame));

    expect(closed).toContainEqual({ code: 4008, reason: 'daemon rate limit exceeded' });
  });

  it('rejects client connection when scope claim is missing', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: safeSendToFake,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_demo', workspaceId: 'workspace_demo' } as never,
    );

    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ code: 4008, reason: 'invalid scope claim' });
  });

  it('rejects connection when workspace claim mismatches requested workspace', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: safeSendToFake,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_requested',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'runtime', workspaceId: 'workspace_claimed' },
    );

    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ code: 4008, reason: 'workspace claim mismatch' });
    expect(registry.getOrCreate('workspace_requested').clients.size).toBe(0);
  });

  it('rejects connection when workspace claim is missing', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const clientWs = new FakeWs() as unknown as WebSocket;
    registerConnection(
      {
        config,
        logger,
        metrics,
        registry,
        backplane,
        wsIp,
        wsWorkspace,
        wsRole,
        setupHeartbeat: () => undefined,
        markWsActivity: () => undefined,
        adjustIpConnectionCount: () => undefined,
        updateGauges: () => undefined,
        safeSend: safeSendToFake,
        closeWithReason: (ws, code, reason) => {
          closed.push({ code, reason });
          (ws as unknown as FakeWs).close(code, reason);
        },
      },
      clientWs,
      'client',
      'workspace_requested',
      '127.0.0.1',
      { clientId: 'client_demo', scope: 'runtime' },
    );

    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({ code: 4008, reason: 'missing workspace claim' });
    expect(registry.getOrCreate('workspace_requested').clients.size).toBe(0);
  });

  it('routes pairing responses only to the requesting client', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();

    const daemonWs = new FakeWs() as unknown as WebSocket;
    const clientWsA = new FakeWs() as unknown as WebSocket;
    const clientWsB = new FakeWs() as unknown as WebSocket;

    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) =>
        (ws as unknown as FakeWs).close(code, reason),
    };

    registerConnection(
      context,
      daemonWs,
      'workspace-daemon',
      'workspace_demo',
      '127.0.0.1',
      { e2eeProfile: 'noise-ikpsk2', workspaceId: 'workspace_demo' },
    );
    registerConnection(
      context,
      clientWsA,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_a', scope: 'pairing', workspaceId: 'workspace_demo' },
    );
    registerConnection(
      context,
      clientWsB,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_b', scope: 'pairing', workspaceId: 'workspace_demo' },
    );

    const offerReq = JSON.stringify({
      type: 'relay_pairing_offer_request',
      requestId: 'pair-1',
      clientChannelPublicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ttlSeconds: 600,
    });
    (clientWsA as unknown as FakeWs).emit('message', Buffer.from(offerReq));
    expect((daemonWs as unknown as FakeWs).sent).toContain(offerReq);

    const offerResp = JSON.stringify({
      type: 'relay_pairing_offer_response',
      requestId: 'pair-1',
      ok: true,
      daemonChannelPublicKey: 'BBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      encIv: 'iv',
      encTag: 'tag',
      encCiphertext: 'ciphertext',
    });
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(offerResp));

    expect((clientWsA as unknown as FakeWs).sent).toContain(offerResp);
    expect((clientWsB as unknown as FakeWs).sent).not.toContain(offerResp);
    expect(backplane.publishDaemonToClients).not.toHaveBeenCalled();
  });

  it('bounds pairing request tracking map and evicts oldest requests', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_PAIRING_REQUEST_TRACK_MAX: '1',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();

    const daemonWs = new FakeWs() as unknown as WebSocket;
    const clientWs = new FakeWs() as unknown as WebSocket;

    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) =>
        (ws as unknown as FakeWs).close(code, reason),
    };

    registerConnection(
      context,
      daemonWs,
      'workspace-daemon',
      'workspace_demo',
      '127.0.0.1',
      { e2eeProfile: 'noise-ikpsk2', workspaceId: 'workspace_demo' },
    );
    registerConnection(
      context,
      clientWs,
      'client',
      'workspace_demo',
      '127.0.0.1',
      { clientId: 'client_a', scope: 'pairing', workspaceId: 'workspace_demo' },
    );

    const req1 = JSON.stringify({
      type: 'relay_pairing_offer_request',
      requestId: 'pair-evict-1',
      clientChannelPublicKey: 'BCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const req2 = JSON.stringify({
      type: 'relay_pairing_offer_request',
      requestId: 'pair-evict-2',
      clientChannelPublicKey: 'BDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    (clientWs as unknown as FakeWs).emit('message', Buffer.from(req1));
    (clientWs as unknown as FakeWs).emit('message', Buffer.from(req2));

    const resp1 = JSON.stringify({
      type: 'relay_pairing_offer_response',
      requestId: 'pair-evict-1',
      ok: true,
      daemonChannelPublicKey: 'BEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      encIv: 'iv-1',
      encTag: 'tag-1',
      encCiphertext: 'cipher-1',
    });
    const resp2 = JSON.stringify({
      type: 'relay_pairing_offer_response',
      requestId: 'pair-evict-2',
      ok: true,
      daemonChannelPublicKey: 'BFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      encIv: 'iv-2',
      encTag: 'tag-2',
      encCiphertext: 'cipher-2',
    });
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(resp1));
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(resp2));

    const sent = (clientWs as unknown as FakeWs).sent.join('\n');
    expect(sent).not.toContain('"requestId":"pair-evict-1"');
    expect(sent).toContain('"requestId":"pair-evict-2"');
  });

  it('routes daemon runtime envelopes only to the session-owning client', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();

    const daemonWs = new FakeWs() as unknown as WebSocket;
    const clientWsA = new FakeWs() as unknown as WebSocket;
    const clientWsB = new FakeWs() as unknown as WebSocket;

    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) =>
        (ws as unknown as FakeWs).close(code, reason),
    };

    registerConnection(context, daemonWs, 'workspace-daemon', 'workspace_demo', '127.0.0.1', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, clientWsA, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_a',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, clientWsB, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_b',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });

    const kexInit = JSON.stringify({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId: 'kex-owned',
      clientPublicKey: 'pub-a',
      clientNonce: 'nonce-a',
      clientProof: 'proof-a',
    });
    (clientWsA as unknown as FakeWs).emit('message', Buffer.from(kexInit));

    const kexResp = JSON.stringify({
      type: 'relay_key_exchange_response',
      version: 2,
      profile: 'noise-ik',
      requestId: 'kex-owned',
      daemonNonce: 'daemon-nonce',
      sessionId: 'sess-owned',
      epoch: 1,
      proof: 'daemon-proof',
    });
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(kexResp));

    const envelope = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-owned',
      epoch: 1,
      seq: 1,
      iv: 'iv',
      tag: 'tag',
      ciphertext: 'cipher',
    });
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(envelope));

    expect((clientWsA as unknown as FakeWs).sent).toContain(kexResp);
    expect((clientWsA as unknown as FakeWs).sent).toContain(envelope);
    expect((clientWsB as unknown as FakeWs).sent).not.toContain(kexResp);
    expect((clientWsB as unknown as FakeWs).sent).not.toContain(envelope);
  });

  it('rejects a second daemon connection while one is already active', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const daemonA = new FakeWs() as unknown as WebSocket;
    const daemonB = new FakeWs() as unknown as WebSocket;
    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) => {
        closed.push({ code, reason });
        (ws as unknown as FakeWs).close(code, reason);
      },
    };

    registerConnection(context, daemonA, 'workspace-daemon', 'workspace_demo', '127.0.0.1', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, daemonB, 'workspace-daemon', 'workspace_demo', '127.0.0.2', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
    });

    expect(closed).toContainEqual({ code: 4008, reason: 'daemon already connected' });
    expect((daemonA as unknown as FakeWs).readyState).toBe(1);
    expect((daemonB as unknown as FakeWs).readyState).toBe(3);
  });

  it('rejects daemon connections with stale daemon issue generation claims', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const closed: Array<{ code: number; reason: string }> = [];

    const daemonCurrent = new FakeWs() as unknown as WebSocket;
    const daemonStale = new FakeWs() as unknown as WebSocket;
    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) => {
        closed.push({ code, reason });
        (ws as unknown as FakeWs).close(code, reason);
      },
    };

    registerConnection(context, daemonCurrent, 'workspace-daemon', 'workspace_demo', '127.0.0.1', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
      daemonIssueGeneration: 3,
    });

    registerConnection(context, daemonStale, 'workspace-daemon', 'workspace_demo', '127.0.0.2', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
      daemonIssueGeneration: 2,
    });

    expect(closed).toContainEqual({ code: 4008, reason: 'stale daemon generation' });
    expect((daemonCurrent as unknown as FakeWs).readyState).toBe(1);
    expect((daemonStale as unknown as FakeWs).readyState).toBe(3);
  });

  it('does not leak ip connection counts when a duplicate daemon is rejected', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();
    const adjustments: number[] = [];

    const daemonA = new FakeWs() as unknown as WebSocket;
    const daemonB = new FakeWs() as unknown as WebSocket;
    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: (_ip: string, delta: number) => {
        adjustments.push(delta);
      },
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) =>
        (ws as unknown as FakeWs).close(code, reason),
    };

    registerConnection(context, daemonA, 'workspace-daemon', 'workspace_demo', '127.0.0.1', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, daemonB, 'workspace-daemon', 'workspace_demo', '127.0.0.2', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
    });

    expect(adjustments).toEqual([1]);
  });

  it('evicts oldest session owners when session owner map hits configured max', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_SESSION_OWNER_TRACK_MAX: '1',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();

    const daemonWs = new FakeWs() as unknown as WebSocket;
    const clientWsA = new FakeWs() as unknown as WebSocket;
    const clientWsB = new FakeWs() as unknown as WebSocket;
    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) =>
        (ws as unknown as FakeWs).close(code, reason),
    };

    registerConnection(context, daemonWs, 'workspace-daemon', 'workspace_demo', '127.0.0.1', {
      e2eeProfile: 'noise-ik',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, clientWsA, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_a',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, clientWsB, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_b',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });

    (clientWsA as unknown as FakeWs).emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'relay_key_exchange_init',
          version: 2,
          profile: 'noise-ik',
          requestId: 'kex-a',
          clientPublicKey: 'pub-a',
          clientNonce: 'nonce-a',
          clientProof: 'proof-a',
        }),
      ),
    );
    (daemonWs as unknown as FakeWs).emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'relay_key_exchange_response',
          version: 2,
          profile: 'noise-ik',
          requestId: 'kex-a',
          daemonNonce: 'daemon-nonce-a',
          sessionId: 'sess-a',
          epoch: 1,
          proof: 'proof-a',
        }),
      ),
    );

    (clientWsB as unknown as FakeWs).emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'relay_key_exchange_init',
          version: 2,
          profile: 'noise-ik',
          requestId: 'kex-b',
          clientPublicKey: 'pub-b',
          clientNonce: 'nonce-b',
          clientProof: 'proof-b',
        }),
      ),
    );
    (daemonWs as unknown as FakeWs).emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'relay_key_exchange_response',
          version: 2,
          profile: 'noise-ik',
          requestId: 'kex-b',
          daemonNonce: 'daemon-nonce-b',
          sessionId: 'sess-b',
          epoch: 1,
          proof: 'proof-b',
        }),
      ),
    );

    const envelopeA = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-a',
      epoch: 1,
      seq: 1,
      iv: 'iv-a',
      tag: 'tag-a',
      ciphertext: 'cipher-a',
    });
    const envelopeB = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-b',
      epoch: 1,
      seq: 1,
      iv: 'iv-b',
      tag: 'tag-b',
      ciphertext: 'cipher-b',
    });
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(envelopeA));
    (daemonWs as unknown as FakeWs).emit('message', Buffer.from(envelopeB));

    expect((clientWsA as unknown as FakeWs).sent).not.toContain(envelopeA);
    expect((clientWsB as unknown as FakeWs).sent).toContain(envelopeB);
  });

  it('routes bus daemon envelopes to session owner only and drops unknown sessions', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();

    const clientWsA = new FakeWs() as unknown as WebSocket;
    const clientWsB = new FakeWs() as unknown as WebSocket;
    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) =>
        (ws as unknown as FakeWs).close(code, reason),
    };

    registerConnection(context, clientWsA, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_a',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });
    registerConnection(context, clientWsB, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_b',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });
    registry.getOrCreate('workspace_demo').sessionOwners.set('sess-owned', {
      clientWs: clientWsA as unknown as WebSocket,
      createdAt: Date.now(),
    });

    const ownedEnvelope = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-owned',
      epoch: 1,
      seq: 1,
      iv: 'iv',
      tag: 'tag',
      ciphertext: 'cipher',
    });
    routeBusFrame(context, {
      id: 1,
      workspaceId: 'workspace_demo',
      sourceRelayId: 'relay-b',
      targetRelayId: 'relay-a',
      direction: 'daemon_to_clients',
      payload: ownedEnvelope,
    });

    const unknownEnvelope = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-unknown',
      epoch: 1,
      seq: 1,
      iv: 'iv-u',
      tag: 'tag-u',
      ciphertext: 'cipher-u',
    });
    routeBusFrame(context, {
      id: 2,
      workspaceId: 'workspace_demo',
      sourceRelayId: 'relay-b',
      targetRelayId: 'relay-a',
      direction: 'daemon_to_clients',
      payload: unknownEnvelope,
    });

    expect((clientWsA as unknown as FakeWs).sent).toContain(ownedEnvelope);
    expect((clientWsB as unknown as FakeWs).sent).not.toContain(ownedEnvelope);
    expect((clientWsA as unknown as FakeWs).sent).not.toContain(unknownEnvelope);
    expect((clientWsB as unknown as FakeWs).sent).not.toContain(unknownEnvelope);
  });

  it('rate-limits bus-originated daemon frames per workspace', () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_DAEMON_RUNTIME_RATE_PER_MINUTE: '1',
    });
    const logger = new RelayLogger(10);
    const metrics = new RelayMetrics();
    const registry = new ConnectionRegistry();
    const backplane = createTestBackplane();
    const wsIp = new WeakMap<WebSocket, string>();
    const wsWorkspace = new WeakMap<WebSocket, string>();
    const wsRole = new WeakMap<WebSocket, 'workspace-daemon' | 'client'>();

    const clientWs = new FakeWs() as unknown as WebSocket;
    const context = {
      config,
      logger,
      metrics,
      registry,
      backplane,
      wsIp,
      wsWorkspace,
      wsRole,
      setupHeartbeat: () => undefined,
      markWsActivity: () => undefined,
      adjustIpConnectionCount: () => undefined,
      updateGauges: () => undefined,
      safeSend: safeSendToFake,
      closeWithReason: (ws: WebSocket, code: number, reason: string) =>
        (ws as unknown as FakeWs).close(code, reason),
    };

    registerConnection(context, clientWs, 'client', 'workspace_demo', '127.0.0.1', {
      clientId: 'client_a',
      scope: 'runtime',
      workspaceId: 'workspace_demo',
    });
    registry.getOrCreate('workspace_demo').sessionOwners.set('sess-owned', {
      clientWs,
      createdAt: Date.now(),
    });

    const envelope1 = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-owned',
      epoch: 1,
      seq: 1,
      iv: 'iv-1',
      tag: 'tag-1',
      ciphertext: 'cipher-1',
    });
    const envelope2 = JSON.stringify({
      type: 'e2ee',
      version: 2,
      profile: 'noise-ik',
      sessionId: 'sess-owned',
      epoch: 1,
      seq: 2,
      iv: 'iv-2',
      tag: 'tag-2',
      ciphertext: 'cipher-2',
    });

    routeBusFrame(context, {
      id: 1,
      workspaceId: 'workspace_demo',
      sourceRelayId: 'relay-b',
      targetRelayId: 'relay-a',
      direction: 'daemon_to_clients',
      payload: envelope1,
    });
    routeBusFrame(context, {
      id: 2,
      workspaceId: 'workspace_demo',
      sourceRelayId: 'relay-b',
      targetRelayId: 'relay-a',
      direction: 'daemon_to_clients',
      payload: envelope2,
    });

    expect((clientWs as unknown as FakeWs).sent).toContain(envelope1);
    expect((clientWs as unknown as FakeWs).sent).not.toContain(envelope2);
  });
});

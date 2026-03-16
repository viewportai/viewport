import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelayBackplane } from '../src/backplane.js';
import { loadConfig } from '../src/config.js';
import { RelayLogger } from '../src/logger.js';
import { RelayMetrics } from '../src/metrics.js';

const presenceInstance = {
  resolve: vi.fn(),
  upsert: vi.fn(),
};

const busInstance = {
  publishClientToDaemon: vi.fn(),
  publishDaemonToClients: vi.fn(),
  pull: vi.fn(),
};

vi.mock('../src/presence.js', () => ({
  RelayPresenceClient: vi.fn().mockImplementation(() => presenceInstance),
}));

vi.mock('../src/bus.js', () => ({
  RelayBusClient: vi.fn().mockImplementation(() => busInstance),
}));

describe('relay backplane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    presenceInstance.resolve.mockResolvedValue(null);
    presenceInstance.upsert.mockResolvedValue(undefined);
    busInstance.publishClientToDaemon.mockResolvedValue(false);
    busInstance.publishDaemonToClients.mockResolvedValue(false);
    busInstance.pull.mockResolvedValue([]);
  });

  it('creates a single-relay backplane with no-op cross-relay behavior', async () => {
    const config = loadConfig({
      RELAY_BACKPLANE_MODE: 'single',
      RELAY_BUS_ENABLED: '0',
      RELAY_CLIENT_REDIRECT_ENABLED: '0',
    });

    const backplane = createRelayBackplane(config, new RelayLogger(5), new RelayMetrics());

    expect(backplane.mode).toBe('single');
    expect(backplane.crossRelayEnabled).toBe(false);
    expect(backplane.pollIntervalMs).toBeNull();
    await expect(backplane.resolvePresence('workspace_demo')).resolves.toBeNull();
    await expect(backplane.upsertPresence('workspace_demo', true)).resolves.toBeUndefined();
    await expect(
      backplane.publishClientToDaemon('workspace_demo', 'payload', 'relay-b'),
    ).resolves.toBe(false);
    await expect(backplane.publishDaemonToClients('workspace_demo', 'payload')).resolves.toBe(
      false,
    );
    await expect(backplane.pullFrames()).resolves.toEqual([]);
    expect(presenceInstance.resolve).not.toHaveBeenCalled();
    expect(busInstance.publishClientToDaemon).not.toHaveBeenCalled();
  });

  it('creates a server backplane that delegates to presence and bus clients', async () => {
    presenceInstance.resolve.mockResolvedValue({
      relayId: 'relay-b',
      relayWsBaseUrl: 'wss://relay-b.example.com/ws',
      daemonConnected: true,
    });
    busInstance.publishClientToDaemon.mockResolvedValue(true);
    busInstance.publishDaemonToClients.mockResolvedValue(true);
    busInstance.pull.mockResolvedValue([
      {
        id: 7,
        workspaceId: 'workspace_demo',
        sourceRelayId: 'relay-b',
        targetRelayId: 'relay-a',
        direction: 'client_to_daemon',
        payload: '{"type":"e2ee"}',
      },
    ]);

    const config = loadConfig({
      RELAY_BACKPLANE_MODE: 'server',
      RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-signing-key',
      RELAY_BUS_POLL_INTERVAL_MS: '333',
    });

    const backplane = createRelayBackplane(config, new RelayLogger(5), new RelayMetrics());

    expect(backplane.mode).toBe('server');
    expect(backplane.crossRelayEnabled).toBe(true);
    expect(backplane.pollIntervalMs).toBe(333);
    await expect(backplane.resolvePresence('workspace_demo')).resolves.toEqual({
      relayId: 'relay-b',
      relayWsBaseUrl: 'wss://relay-b.example.com/ws',
      daemonConnected: true,
    });
    await expect(backplane.upsertPresence('workspace_demo', true)).resolves.toBeUndefined();
    await expect(
      backplane.publishClientToDaemon('workspace_demo', 'payload', 'relay-b'),
    ).resolves.toBe(true);
    await expect(backplane.publishDaemonToClients('workspace_demo', 'payload', 'relay-a')).resolves.toBe(
      true,
    );
    await expect(backplane.pullFrames()).resolves.toEqual([
      {
        id: 7,
        workspaceId: 'workspace_demo',
        sourceRelayId: 'relay-b',
        targetRelayId: 'relay-a',
        direction: 'client_to_daemon',
        payload: '{"type":"e2ee"}',
      },
    ]);
    expect(presenceInstance.resolve).toHaveBeenCalledWith('workspace_demo');
    expect(presenceInstance.upsert).toHaveBeenCalledWith('workspace_demo', true);
    expect(busInstance.publishClientToDaemon).toHaveBeenCalledWith(
      'workspace_demo',
      'payload',
      'relay-b',
    );
    expect(busInstance.publishDaemonToClients).toHaveBeenCalledWith(
      'workspace_demo',
      'payload',
      'relay-a',
    );
    expect(busInstance.pull).toHaveBeenCalled();
  });

  it('creates a redis backplane when redis mode is configured', () => {
    const config = loadConfig({
      RELAY_BACKPLANE_MODE: 'redis',
      RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      RELAY_REDIS_URL: 'redis://127.0.0.1:6379',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-signing-key',
    });

    const backplane = createRelayBackplane(config, new RelayLogger(5), new RelayMetrics());
    expect(backplane.mode).toBe('redis');
    expect(backplane.crossRelayEnabled).toBe(true);
  });
});

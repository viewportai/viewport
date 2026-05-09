import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { RelayBackplane } from '../src/backplane.js';
import type { RelayLogger } from '../src/logger.js';
import type { RelayMetrics } from '../src/metrics.js';
import { routeClientMessageWithoutLocalDaemon } from '../src/relay-runtime-routing.js';

function createContext(overrides: Partial<RelayBackplane> = {}) {
  const sent: string[] = [];
  const metrics = {
    increment: vi.fn(),
  } as unknown as RelayMetrics;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as RelayLogger;
  const backplane: RelayBackplane = {
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

  return {
    backplane,
    logger,
    metrics,
    sent,
    context: {
      config: {
        clientRedirectEnabled: true,
        relayId: 'relay-local',
      },
      backplane,
      logger,
      metrics,
      safeSend: (_ws: WebSocket, payload: string): boolean => {
        sent.push(payload);
        return true;
      },
    },
    ws: {} as WebSocket,
  };
}

describe('relay runtime routing contracts', () => {
  it('returns a non-retryable status when a runtime message has no machine target', async () => {
    const { context, ws, sent, metrics, logger, backplane } = createContext();

    await routeClientMessageWithoutLocalDaemon(context, ws, {
      workspaceId: 'workspace_1',
      clientId: 'client_1',
      payload: '{"type":"relay_key_exchange_init"}',
    });

    expect(sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: 'relay_status',
        code: 'RUNTIME_TARGET_REQUIRED',
        message: 'Runtime client must specify a runtime target',
        workspaceId: 'workspace_1',
        retryable: false,
      },
    ]);
    expect(metrics.increment).toHaveBeenCalledWith('relay_client_messages_dropped_total');
    expect(logger.warn).toHaveBeenCalledWith('client_message_dropped', {
      workspaceId: 'workspace_1',
      clientId: 'client_1',
      reason: 'missing_runtime_target',
    });
    expect(backplane.resolvePresence).not.toHaveBeenCalled();
  });

  it('publishes to a remote relay when presence resolves to a connected daemon', async () => {
    const { context, ws, sent, metrics, logger, backplane } = createContext({
      resolvePresence: vi.fn().mockResolvedValue({
        relayId: 'relay-remote',
        relayWsBaseUrl: 'wss://relay.example/ws',
        daemonConnected: true,
        runtimeTargetId: 'binding_1',
        machineId: 'machine_1',
      }),
      publishClientToDaemon: vi.fn().mockResolvedValue(true),
    });

    await routeClientMessageWithoutLocalDaemon(context, ws, {
      workspaceId: 'workspace_1',
      runtimeTargetId: 'binding_1',
      machineId: 'machine_1',
      clientId: 'client_1',
      payload: '{"type":"relay_key_exchange_init"}',
    });

    expect(sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: 'relay_status',
        code: 'RELAY_REDIRECT',
        message: 'Workspace is assigned to a different relay instance',
        workspaceId: 'workspace_1',
        runtimeTargetId: 'binding_1',
        relayWsBaseUrl: 'wss://relay.example/ws',
      },
    ]);
    expect(backplane.resolvePresence).toHaveBeenCalledWith('workspace_1', 'binding_1');
    expect(backplane.publishClientToDaemon).toHaveBeenCalledWith(
      'workspace_1',
      'binding_1',
      'machine_1',
      '{"type":"relay_key_exchange_init"}',
      'relay-remote',
    );
    expect(metrics.increment).toHaveBeenCalledWith('relay_client_messages_routed_bus_total');
    expect(logger.info).toHaveBeenCalledWith('client_message_routed_bus', {
      workspaceId: 'workspace_1',
      clientId: 'client_1',
      targetRelayId: 'relay-remote',
    });
  });

  it('returns a retryable unavailable status when no daemon can accept the target', async () => {
    const { context, ws, sent, metrics, logger, backplane } = createContext({
      resolvePresence: vi.fn().mockResolvedValue(null),
    });

    await routeClientMessageWithoutLocalDaemon(context, ws, {
      workspaceId: 'workspace_1',
      runtimeTargetId: 'binding_1',
      machineId: 'machine_1',
      clientId: 'client_1',
      payload: '{"type":"relay_key_exchange_init"}',
    });

    expect(sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: 'relay_status',
        code: 'DAEMON_UNAVAILABLE',
        message: 'No machine runtime is connected for this runtime target',
        workspaceId: 'workspace_1',
        runtimeTargetId: 'binding_1',
        machineId: 'machine_1',
        retryable: true,
      },
    ]);
    expect(backplane.publishClientToDaemon).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('relay_client_messages_dropped_total');
    expect(logger.warn).toHaveBeenCalledWith('client_message_dropped', {
      workspaceId: 'workspace_1',
      clientId: 'client_1',
      runtimeTargetId: 'binding_1',
      machineId: 'machine_1',
      reason: 'daemon_unavailable',
    });
  });
});

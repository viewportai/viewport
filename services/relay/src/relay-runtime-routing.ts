import type { WebSocket } from 'ws';
import type { RelayBackplane } from './backplane.js';
import type { RelayConfig } from './config.js';
import type { RelayLogger } from './logger.js';
import type { RelayMetrics } from './metrics.js';
import {
  missingRuntimeTargetPayload,
  relayRedirectPayload,
  relayStatusPayload,
} from './relay-status-payloads.js';

export interface RuntimeRoutingContext {
  config: Pick<RelayConfig, 'clientRedirectEnabled' | 'relayId'>;
  backplane: RelayBackplane;
  logger: RelayLogger;
  metrics: RelayMetrics;
  safeSend: (ws: WebSocket, payload: string) => boolean;
}

export interface RuntimeRoutingTarget {
  workspaceId: string;
  runtimeTargetId?: string;
  machineId?: string;
  clientId: string;
  payload: string;
}

export async function routeClientMessageWithoutLocalDaemon(
  context: RuntimeRoutingContext,
  ws: WebSocket,
  target: RuntimeRoutingTarget,
): Promise<void> {
  const { config, safeSend, metrics, logger, backplane } = context;
  const { workspaceId, runtimeTargetId, machineId, clientId, payload } = target;

  if (!runtimeTargetId) {
    metrics.increment('relay_client_messages_dropped_total');
    safeSend(ws, JSON.stringify(missingRuntimeTargetPayload(workspaceId)));
    logger.warn('client_message_dropped', {
      workspaceId,
      clientId,
      reason: 'missing_runtime_target',
    });
    return;
  }

  const preferred = await backplane.resolvePresence(workspaceId, runtimeTargetId);
  if (preferred && preferred.daemonConnected && preferred.relayId !== config.relayId) {
    if (config.clientRedirectEnabled) {
      safeSend(
        ws,
        JSON.stringify(relayRedirectPayload(workspaceId, preferred.relayWsBaseUrl, runtimeTargetId)),
      );
    }
    const published = await backplane.publishClientToDaemon(
      workspaceId,
      runtimeTargetId,
      machineId,
      payload,
      preferred.relayId,
    );
    if (published) {
      metrics.increment('relay_client_messages_routed_bus_total');
      logger.info('client_message_routed_bus', {
        workspaceId,
        clientId,
        targetRelayId: preferred.relayId,
      });
      return;
    }
  }

  metrics.increment('relay_client_messages_dropped_total');
  safeSend(ws, JSON.stringify(relayStatusPayload(workspaceId, runtimeTargetId, machineId)));
  logger.warn('client_message_dropped', {
    workspaceId,
    clientId,
    runtimeTargetId,
    machineId,
    reason: 'daemon_unavailable',
  });
}

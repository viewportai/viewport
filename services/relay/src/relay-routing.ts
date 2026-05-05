import { WebSocket } from 'ws';
import type { RelayBusFrame } from './bus.js';
import type { RelayBackplane } from './backplane.js';
import type { RelayConfig } from './config.js';
import type { RelayLogger } from './logger.js';
import type { RelayMetrics } from './metrics.js';
import type { ConnectionRegistry } from './registry.js';
import {
  extractFrameProfile,
  extractPairingRequestId,
  isAllowedClientFrame,
  isAllowedDaemonFrame,
  isE2eeEnvelope,
  isKeyExchangeInitFrame,
  isKeyExchangeResponseFrame,
  isKeyUpdateRequiredFrame,
  isPairingClientFrame,
  isPairingDaemonFrame,
  parseFramePayload,
  type FramePayload,
} from './relay-frame-validation.js';
import {
  missingRuntimeTargetPayload,
  runtimeScopeKey,
} from './relay-status-payloads.js';
import { resolveConnectionAdmission } from './relay-connection-admission.js';
import { routeClientMessageWithoutLocalDaemon } from './relay-runtime-routing.js';
import { FixedWindowRateLimiter, TokenBucketRateLimiter } from './security.js';
import type { AdmissionClaims, RelayRole } from './types.js';

interface RelayRoutingContext {
  config: RelayConfig;
  logger: RelayLogger;
  metrics: RelayMetrics;
  registry: ConnectionRegistry;
  backplane: RelayBackplane;
  wsIp: WeakMap<WebSocket, string>;
  wsWorkspace: WeakMap<WebSocket, string>;
  wsRole: WeakMap<WebSocket, RelayRole>;
  setupHeartbeat: (ws: WebSocket) => void;
  markWsActivity: (ws: WebSocket) => void;
  adjustIpConnectionCount: (ip: string, delta: number) => void;
  updateGauges: () => void;
  safeSend: (ws: WebSocket, payload: string) => boolean;
  closeWithReason: (ws: WebSocket, code: number, reason: string) => void;
  kexFrameLimiter?: FixedWindowRateLimiter;
  pairingFrameLimiter?: FixedWindowRateLimiter;
  runtimeClientLimiter?: TokenBucketRateLimiter;
  runtimeWorkspaceLimiter?: TokenBucketRateLimiter;
  daemonFrameLimiter?: TokenBucketRateLimiter;
}

const PAIRING_REQUEST_TTL_MS = 2 * 60_000;
const KEY_EXCHANGE_REQUEST_TTL_MS = 2 * 60_000;
const SESSION_OWNER_TTL_MS = 30 * 60_000;
const runtimeLimiterCache = new WeakMap<
  RelayRoutingContext,
  { byClient: TokenBucketRateLimiter; byWorkspace: TokenBucketRateLimiter }
>();
const controlLimiterCache = new WeakMap<
  RelayRoutingContext,
  { kex: FixedWindowRateLimiter; pairing: FixedWindowRateLimiter }
>();
const daemonLimiterCache = new WeakMap<RelayRoutingContext, TokenBucketRateLimiter>();

function profileStrength(profile: 'noise-ik' | 'noise-ikpsk2'): number {
  return profile === 'noise-ikpsk2' ? 2 : 1;
}

function pruneStalePairingRequests(state: ReturnType<ConnectionRegistry['getOrCreate']>): void {
  const now = Date.now();
  for (const [requestId, owner] of state.pairingRequests.entries()) {
    if (now - owner.createdAt > PAIRING_REQUEST_TTL_MS) {
      state.pairingRequests.delete(requestId);
    }
  }
}

function trackPairingRequest(
  state: ReturnType<ConnectionRegistry['getOrCreate']>,
  requestId: string,
  owner: { sourceRelayId?: string; clientWs?: WebSocket; createdAt: number },
  maxTracked: number,
): void {
  while (state.pairingRequests.size >= maxTracked) {
    const oldest = state.pairingRequests.keys().next();
    if (oldest.done) break;
    state.pairingRequests.delete(oldest.value);
  }
  state.pairingRequests.set(requestId, owner);
}

function pruneStaleKeyExchangeRequests(state: ReturnType<ConnectionRegistry['getOrCreate']>): void {
  const now = Date.now();
  for (const [requestId, owner] of state.keyExchangeRequests.entries()) {
    if (now - owner.createdAt > KEY_EXCHANGE_REQUEST_TTL_MS) {
      state.keyExchangeRequests.delete(requestId);
    }
  }
}

function trackKeyExchangeRequest(
  state: ReturnType<ConnectionRegistry['getOrCreate']>,
  requestId: string,
  owner: { sourceRelayId?: string; clientWs?: WebSocket; createdAt: number },
  maxTracked: number,
): void {
  while (state.keyExchangeRequests.size >= maxTracked) {
    const oldest = state.keyExchangeRequests.keys().next();
    if (oldest.done) break;
    state.keyExchangeRequests.delete(oldest.value);
  }
  state.keyExchangeRequests.set(requestId, owner);
}

function trackSessionOwner(
  state: ReturnType<ConnectionRegistry['getOrCreate']>,
  sessionId: string,
  owner: { sourceRelayId?: string; clientWs?: WebSocket; createdAt: number },
  maxTracked: number,
): void {
  while (state.sessionOwners.size >= maxTracked) {
    const oldest = state.sessionOwners.keys().next();
    if (oldest.done) break;
    state.sessionOwners.delete(oldest.value);
  }
  state.sessionOwners.set(sessionId, owner);
}

function pruneStaleSessionOwners(state: ReturnType<ConnectionRegistry['getOrCreate']>): void {
  const now = Date.now();
  for (const [sessionId, owner] of state.sessionOwners.entries()) {
    if (now - owner.createdAt > SESSION_OWNER_TTL_MS) {
      state.sessionOwners.delete(sessionId);
    }
  }
}

function routeSessionOwnedFrame(
  context: RelayRoutingContext,
  workspaceId: string,
  scopeKey: string,
  sessionId: string,
  text: string,
): boolean {
  const { registry, safeSend, metrics } = context;
  const { backplane } = context;
  const state = registry.getOrCreate(scopeKey, { workspaceId });
  pruneStaleSessionOwners(state);
  const owner = state.sessionOwners.get(sessionId);
  if (!owner) {
    metrics.increment('relay_session_frame_dropped_total');
    return false;
  }

  if (owner.clientWs && owner.clientWs.readyState === WebSocket.OPEN) {
    safeSend(owner.clientWs, text);
    metrics.increment('relay_session_frame_routed_local_total');
    return true;
  }

  if (owner.sourceRelayId && state.projectMachineBindingId) {
    void backplane.publishDaemonToClients(
      workspaceId,
      state.projectMachineBindingId,
      undefined,
      text,
      owner.sourceRelayId,
    );
    metrics.increment('relay_session_frame_routed_bus_total');
    return true;
  }

  metrics.increment('relay_session_frame_dropped_total');
  return false;
}

function resolveRuntimeLimiters(context: RelayRoutingContext): {
  byClient: TokenBucketRateLimiter;
  byWorkspace: TokenBucketRateLimiter;
} {
  if (context.runtimeClientLimiter && context.runtimeWorkspaceLimiter) {
    return {
      byClient: context.runtimeClientLimiter,
      byWorkspace: context.runtimeWorkspaceLimiter,
    };
  }
  const cached = runtimeLimiterCache.get(context);
  if (cached) return cached;
  const created = {
    byClient: new TokenBucketRateLimiter(
      context.config.maxRuntimeFramesPerMinute,
      60_000,
      context.config.runtimeRateLimiterMaxKeys,
    ),
    byWorkspace: new TokenBucketRateLimiter(
      context.config.maxRuntimeFramesPerMinuteWorkspace,
      60_000,
      context.config.runtimeWorkspaceRateLimiterMaxKeys,
    ),
  };
  runtimeLimiterCache.set(context, created);
  return created;
}

function resolveControlFrameLimiters(context: RelayRoutingContext): {
  kex: FixedWindowRateLimiter;
  pairing: FixedWindowRateLimiter;
} {
  if (context.kexFrameLimiter && context.pairingFrameLimiter) {
    return {
      kex: context.kexFrameLimiter,
      pairing: context.pairingFrameLimiter,
    };
  }
  const cached = controlLimiterCache.get(context);
  if (cached) return cached;
  const created = {
    kex: new FixedWindowRateLimiter(
      context.config.maxKeyExchangeInitPerMinute,
      60_000,
      context.config.kexRateLimiterMaxKeys,
    ),
    pairing: new FixedWindowRateLimiter(
      context.config.maxPairingFramesPerMinute,
      60_000,
      context.config.pairingRateLimiterMaxKeys,
    ),
  };
  controlLimiterCache.set(context, created);
  return created;
}

function resolveDaemonFrameLimiter(context: RelayRoutingContext): TokenBucketRateLimiter {
  if (context.daemonFrameLimiter) return context.daemonFrameLimiter;
  const cached = daemonLimiterCache.get(context);
  if (cached) return cached;
  const created = new TokenBucketRateLimiter(
    context.config.maxDaemonRuntimeFramesPerMinute,
    60_000,
    context.config.daemonRateLimiterMaxKeys,
  );
  daemonLimiterCache.set(context, created);
  return created;
}

function routeKeyExchangeResponse(
  context: RelayRoutingContext,
  workspaceId: string,
  scopeKey: string,
  text: string,
  parsedFrame: FramePayload,
): boolean {
  const { registry, safeSend, metrics, logger } = context;
  const { backplane } = context;
  const requestId = typeof parsedFrame['requestId'] === 'string' ? parsedFrame['requestId'].trim() : '';
  const sessionId = typeof parsedFrame['sessionId'] === 'string' ? parsedFrame['sessionId'].trim() : '';
  if (!requestId || !sessionId) {
    metrics.increment('relay_key_exchange_response_dropped_total');
    return true;
  }
  const state = registry.getOrCreate(scopeKey, { workspaceId });
  pruneStaleKeyExchangeRequests(state);
  const owner = state.keyExchangeRequests.get(requestId);
  if (!owner) {
    metrics.increment('relay_key_exchange_response_dropped_total');
    logger.warn('key_exchange_response_owner_missing', {
      workspaceId,
      requestId,
      sessionId,
    });
    return true;
  }
  state.keyExchangeRequests.delete(requestId);
  trackSessionOwner(
    state,
    sessionId,
    {
      ...owner,
      createdAt: Date.now(),
    },
    context.config.maxSessionOwnerTrack,
  );

  if (owner.clientWs && owner.clientWs.readyState === WebSocket.OPEN) {
    safeSend(owner.clientWs, text);
    metrics.increment('relay_key_exchange_response_routed_local_total');
    return true;
  }
  if (owner.sourceRelayId && state.projectMachineBindingId) {
    void backplane.publishDaemonToClients(
      workspaceId,
      state.projectMachineBindingId,
      undefined,
      text,
      owner.sourceRelayId,
    );
    metrics.increment('relay_key_exchange_response_routed_bus_total');
    return true;
  }
  metrics.increment('relay_key_exchange_response_dropped_total');
  return true;
}

function routePairingResponse(
  context: RelayRoutingContext,
  workspaceId: string,
  scopeKey: string,
  text: string,
  parsedFrame: FramePayload,
): boolean {
  const { registry, safeSend, metrics, logger } = context;
  const { backplane } = context;
  const state = registry.getOrCreate(scopeKey, { workspaceId });
  pruneStalePairingRequests(state);
  const requestId = extractPairingRequestId(parsedFrame);
  if (!requestId) {
    metrics.increment('relay_pairing_response_dropped_total');
    return true;
  }
  const owner = state.pairingRequests.get(requestId);
  if (!owner) {
    metrics.increment('relay_pairing_response_dropped_total');
    logger.warn('pairing_response_owner_missing', { workspaceId, requestId });
    return true;
  }
  state.pairingRequests.delete(requestId);

  if (owner.clientWs && owner.clientWs.readyState === WebSocket.OPEN) {
    safeSend(owner.clientWs, text);
    metrics.increment('relay_pairing_response_routed_local_total');
    return true;
  }
  if (owner.sourceRelayId && state.projectMachineBindingId) {
    void backplane.publishDaemonToClients(
      workspaceId,
      state.projectMachineBindingId,
      undefined,
      text,
      owner.sourceRelayId,
    );
    metrics.increment('relay_pairing_response_routed_bus_total');
    return true;
  }
  metrics.increment('relay_pairing_response_dropped_total');
  return true;
}

export function routeBusFrame(context: RelayRoutingContext, frame: RelayBusFrame): void {
  const { registry, safeSend, metrics, logger } = context;
  if (!frame.projectMachineBindingId) {
    metrics.increment('relay_bus_frames_rejected_total');
    logger.warn('bus_frame_rejected', {
      workspaceId: frame.workspaceId,
      direction: frame.direction,
      reason: 'missing_project_machine_binding',
    });
    return;
  }
  const scopeKey = runtimeScopeKey(frame.workspaceId, frame.projectMachineBindingId);
  const state = registry.getOrCreate(scopeKey, {
    workspaceId: frame.workspaceId,
    projectMachineBindingId: frame.projectMachineBindingId,
  });
  registry.touch(scopeKey);
  pruneStalePairingRequests(state);
  pruneStaleKeyExchangeRequests(state);
  pruneStaleSessionOwners(state);
  if (frame.direction === 'client_to_daemon') {
    if (!isAllowedClientFrame(frame.payload)) {
      metrics.increment('relay_bus_frames_rejected_total');
      logger.warn('bus_frame_rejected', {
        workspaceId: frame.workspaceId,
        direction: frame.direction,
        reason: 'invalid_client_frame',
      });
      return;
    }
    const parsed = parseFramePayload(frame.payload);
    if (parsed && isKeyExchangeInitFrame(parsed)) {
      const requestId = typeof parsed['requestId'] === 'string' ? parsed['requestId'].trim() : '';
      if (requestId) {
        trackKeyExchangeRequest(
          state,
          requestId,
          {
            sourceRelayId: frame.sourceRelayId,
            createdAt: Date.now(),
          },
          context.config.maxPairingRequestTrack,
        );
      }
    }
    if (parsed && isPairingClientFrame(parsed)) {
      const requestId = extractPairingRequestId(parsed);
      if (requestId) {
        trackPairingRequest(
          state,
          requestId,
          {
            sourceRelayId: frame.sourceRelayId,
            createdAt: Date.now(),
          },
          context.config.maxPairingRequestTrack,
        );
      }
    }
    if (state.daemon && state.daemon.readyState === WebSocket.OPEN) {
      safeSend(state.daemon, frame.payload);
      metrics.increment('relay_bus_frames_to_daemon_total');
      return;
    }
    metrics.increment('relay_bus_frames_dropped_total');
    return;
  }

  if (!isAllowedDaemonFrame(frame.payload)) {
    metrics.increment('relay_bus_frames_rejected_total');
    logger.warn('bus_frame_rejected', {
      workspaceId: frame.workspaceId,
      direction: frame.direction,
      reason: 'invalid_daemon_frame',
    });
    return;
  }

  const daemonFrameLimiter = resolveDaemonFrameLimiter(context);
  if (!daemonFrameLimiter.allow(frame.workspaceId)) {
    metrics.increment('relay_bus_frames_daemon_rate_limited_total');
    logger.warn('bus_frame_rejected', {
      workspaceId: frame.workspaceId,
      direction: frame.direction,
      reason: 'daemon_rate_limit',
    });
    return;
  }

  const parsed = parseFramePayload(frame.payload);
  if (parsed && isKeyExchangeResponseFrame(parsed)) {
    routeKeyExchangeResponse(context, frame.workspaceId, scopeKey, frame.payload, parsed);
    metrics.increment('relay_bus_frames_to_clients_total');
    return;
  }
  if (parsed && isPairingDaemonFrame(parsed)) {
    routePairingResponse(context, frame.workspaceId, scopeKey, frame.payload, parsed);
    metrics.increment('relay_bus_frames_to_clients_total');
    return;
  }

  if (parsed && isE2eeEnvelope(parsed) && typeof parsed['sessionId'] === 'string') {
    const routed = routeSessionOwnedFrame(context, frame.workspaceId, scopeKey, parsed['sessionId'], frame.payload);
    if (routed) {
      metrics.increment('relay_bus_frames_to_clients_total');
    }
    return;
  }

  if (parsed && isKeyUpdateRequiredFrame(parsed) && typeof parsed['sessionId'] === 'string') {
    const routed = routeSessionOwnedFrame(context, frame.workspaceId, scopeKey, parsed['sessionId'], frame.payload);
    if (routed) {
      metrics.increment('relay_bus_frames_to_clients_total');
    }
    return;
  }

  metrics.increment('relay_bus_frames_rejected_total');
  logger.warn('bus_frame_rejected', {
    workspaceId: frame.workspaceId,
    direction: frame.direction,
    reason: 'unroutable_daemon_frame',
  });
}

export function registerConnection(
  context: RelayRoutingContext,
  ws: WebSocket,
  role: RelayRole,
  workspaceId: string,
  requestedProjectMachineBindingId: string | undefined,
  ip: string,
  claims?: AdmissionClaims,
): void {
  const {
    registry,
    wsIp,
    wsWorkspace,
    wsRole,
    adjustIpConnectionCount,
    setupHeartbeat,
    markWsActivity,
    metrics,
    logger,
    updateGauges,
    closeWithReason,
    safeSend,
    config,
    kexFrameLimiter,
    pairingFrameLimiter,
    runtimeClientLimiter,
    runtimeWorkspaceLimiter,
  } = context;

  const admission = resolveConnectionAdmission({
    role,
    workspaceId,
    requestedProjectMachineBindingId,
    ip,
    claims,
  });
  if (!admission.ok) {
    metrics.increment('relay_ws_connections_rejected_total');
    logger.warn(admission.logEvent, admission.logDetails);
    if (admission.sendMissingRuntimeTarget) {
      safeSend(ws, JSON.stringify(missingRuntimeTargetPayload(workspaceId)));
    }
    closeWithReason(ws, 4008, admission.closeReason);
    return;
  }

  const { clientScopeClaim, projectMachineBindingId, machineId } = admission;
  const scopeKey = runtimeScopeKey(workspaceId, projectMachineBindingId);
  const state = registry.getOrCreate(scopeKey, {
    workspaceId,
    projectMachineBindingId,
  });
  registry.touch(scopeKey);
  pruneStalePairingRequests(state);
  pruneStaleKeyExchangeRequests(state);
  pruneStaleSessionOwners(state);

  if (role === 'workspace-daemon') {
    const daemonExpectedProfile = claims?.e2eeProfile;
    const daemonFrameLimiter = resolveDaemonFrameLimiter(context);
    const daemonIssueGeneration =
      typeof claims?.daemonIssueGeneration === 'number' &&
      Number.isInteger(claims.daemonIssueGeneration) &&
      claims.daemonIssueGeneration >= 0
        ? claims.daemonIssueGeneration
        : null;
    if (
      daemonIssueGeneration !== null &&
      typeof state.daemonIssueGeneration === 'number' &&
      daemonIssueGeneration < state.daemonIssueGeneration
    ) {
      metrics.increment('relay_ws_connections_rejected_total');
      logger.warn('daemon_connection_rejected', {
        workspaceId,
        ip,
        reason: 'stale_daemon_issue_generation',
        claimGeneration: daemonIssueGeneration,
        latestGeneration: state.daemonIssueGeneration,
      });
      closeWithReason(ws, 4008, 'stale daemon generation');
      return;
    }
    if (state.daemon && state.daemon.readyState === WebSocket.OPEN) {
      metrics.increment('relay_ws_connections_rejected_total');
      logger.warn('daemon_connection_rejected', {
        workspaceId,
        ip,
        reason: 'daemon_already_connected',
      });
      closeWithReason(ws, 4008, 'daemon already connected');
      return;
    }
    wsIp.set(ws, ip);
    wsWorkspace.set(ws, workspaceId);
    wsRole.set(ws, role);
    adjustIpConnectionCount(ip, 1);
    setupHeartbeat(ws);
    metrics.increment('relay_ws_connections_opened_total');
    state.daemon = ws;
    if (daemonIssueGeneration !== null) {
      state.daemonIssueGeneration = daemonIssueGeneration;
    }
    state.keyExchangeRequests.clear();
    state.sessionOwners.clear();
    void context.backplane.upsertPresence(workspaceId, true, projectMachineBindingId, machineId);
    logger.info('daemon_connected', {
      workspaceId,
      projectMachineBindingId,
      machineId,
      ip,
    });
    updateGauges();

    ws.on('message', (raw) => {
      markWsActivity(ws);
      const text = raw.toString('utf8');
      const size = Buffer.byteLength(text);
      if (!daemonFrameLimiter.allow(workspaceId)) {
        metrics.increment('relay_frames_daemon_rate_limited_total');
        logger.warn('daemon_frame_rate_limited', { workspaceId, ip });
        closeWithReason(ws, 4008, 'daemon rate limit exceeded');
        return;
      }
      if (size > config.maxFrameBytes) {
        metrics.increment('relay_ws_frame_too_large_total');
        closeWithReason(ws, 1009, 'frame too large');
        return;
      }
      if (!isAllowedDaemonFrame(text)) {
        metrics.increment('relay_frames_daemon_rejected_total');
        logger.warn('daemon_frame_rejected', {
          workspaceId,
          reason: 'invalid_daemon_frame',
        });
        return;
      }
      const parsed = parseFramePayload(text);
      const frameProfile = parsed ? extractFrameProfile(parsed) : null;
      if (
        daemonExpectedProfile &&
        frameProfile &&
        profileStrength(frameProfile) < profileStrength(daemonExpectedProfile)
      ) {
        metrics.increment('relay_frames_daemon_rejected_profile_mismatch_total');
        logger.warn('daemon_frame_rejected', {
          workspaceId,
          reason: 'profile_mismatch',
          expectedProfile: daemonExpectedProfile,
          gotProfile: frameProfile,
        });
        closeWithReason(ws, 4008, 'daemon frame profile mismatch');
        return;
      }
      if (parsed && isPairingDaemonFrame(parsed)) {
        routePairingResponse(context, workspaceId, scopeKey, text, parsed);
        metrics.increment('relay_frames_daemon_to_clients_total');
        metrics.increment('relay_bytes_daemon_to_clients_total', size);
        return;
      }
      if (parsed && isKeyExchangeResponseFrame(parsed)) {
        routeKeyExchangeResponse(context, workspaceId, scopeKey, text, parsed);
        metrics.increment('relay_frames_daemon_to_clients_total');
        metrics.increment('relay_bytes_daemon_to_clients_total', size);
        return;
      }
      if (parsed && isE2eeEnvelope(parsed) && typeof parsed['sessionId'] === 'string') {
        routeSessionOwnedFrame(context, workspaceId, scopeKey, parsed['sessionId'], text);
        metrics.increment('relay_frames_daemon_to_clients_total');
        metrics.increment('relay_bytes_daemon_to_clients_total', size);
        return;
      }
      if (parsed && isKeyUpdateRequiredFrame(parsed) && typeof parsed['sessionId'] === 'string') {
        routeSessionOwnedFrame(context, workspaceId, scopeKey, parsed['sessionId'], text);
        metrics.increment('relay_frames_daemon_to_clients_total');
        metrics.increment('relay_bytes_daemon_to_clients_total', size);
        return;
      }
      metrics.increment('relay_frames_daemon_to_clients_total');
      metrics.increment('relay_bytes_daemon_to_clients_total', size);
      logger.warn('daemon_frame_rejected', {
        workspaceId,
        reason: 'unroutable_daemon_frame',
      });
    });

    ws.on('close', () => {
      const clearedCurrentDaemon = registry.clearDaemon(scopeKey, ws);
      if (clearedCurrentDaemon) {
        void context.backplane.upsertPresence(workspaceId, false, projectMachineBindingId, machineId);
      }
      adjustIpConnectionCount(ip, -1);
      metrics.increment('relay_ws_connections_closed_total');
      logger.info('daemon_disconnected', {
        workspaceId,
        projectMachineBindingId,
        machineId,
        ip,
        clearedCurrentDaemon,
      });
      updateGauges();
    });

    ws.on('error', (error) => {
      logger.warn('daemon_ws_error', {
        workspaceId,
        ip,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  const clientId = typeof claims?.clientId === 'string' ? claims.clientId : 'client_unknown';
  const clientScope: 'runtime' | 'pairing' = clientScopeClaim === 'pairing' ? 'pairing' : 'runtime';
  const clientExpectedProfile = claims?.e2eeProfile;
  wsIp.set(ws, ip);
  wsWorkspace.set(ws, workspaceId);
  wsRole.set(ws, role);
  adjustIpConnectionCount(ip, 1);
  setupHeartbeat(ws);
  metrics.increment('relay_ws_connections_opened_total');
  state.clients.set(ws, {
    clientId,
    connectedAt: Date.now(),
  });
  logger.info('client_connected', { workspaceId, clientId, ip });
  updateGauges();
  const resolvedControlLimiters = resolveControlFrameLimiters(context);
  const kexRateLimiter = kexFrameLimiter ?? resolvedControlLimiters.kex;
  const pairingRateLimiter = pairingFrameLimiter ?? resolvedControlLimiters.pairing;
  const resolvedRuntimeLimiters = resolveRuntimeLimiters(context);
  const runtimeLimiterByClient = runtimeClientLimiter ?? resolvedRuntimeLimiters.byClient;
  const runtimeLimiterByWorkspace = runtimeWorkspaceLimiter ?? resolvedRuntimeLimiters.byWorkspace;
  const kexLimiterKey = `${workspaceId}:${clientId}:${ip}`;
  const pairingLimiterKey = `${workspaceId}:${clientId}:${ip}`;

  ws.on('message', (raw) => {
    markWsActivity(ws);
    const text = raw.toString('utf8');
    const size = Buffer.byteLength(text);
    if (size > config.maxFrameBytes) {
      metrics.increment('relay_ws_frame_too_large_total');
      closeWithReason(ws, 1009, 'frame too large');
      return;
    }
    if (!isAllowedClientFrame(text)) {
      metrics.increment('relay_frames_client_rejected_total');
      logger.warn('client_frame_rejected', {
        workspaceId,
        clientId,
        reason: 'invalid_client_frame',
      });
      safeSend(
        ws,
        JSON.stringify({
          type: 'relay_status',
          code: 'INVALID_FRAME',
          message: 'client frame must be a valid runtime or pairing control frame',
          workspaceId,
        }),
      );
      return;
    }
    const parsed = parseFramePayload(text);
    if (!parsed) {
      metrics.increment('relay_frames_client_rejected_total');
      return;
    }
    pruneStalePairingRequests(state);
    pruneStaleKeyExchangeRequests(state);
    pruneStaleSessionOwners(state);
    const isPairingFrame = isPairingClientFrame(parsed);
    if (clientScope === 'pairing' && !isPairingFrame) {
      metrics.increment('relay_frames_client_rejected_scope_total');
      logger.warn('client_frame_rejected', {
        workspaceId,
        clientId,
        reason: 'scope_mismatch_pairing_only',
      });
      closeWithReason(ws, 4008, 'pairing scope only');
      return;
    }
    if (clientScope === 'runtime' && isPairingFrame) {
      metrics.increment('relay_frames_client_rejected_scope_total');
      logger.warn('client_frame_rejected', {
        workspaceId,
        clientId,
        reason: 'scope_mismatch_runtime_only',
      });
      closeWithReason(ws, 4008, 'runtime scope only');
      return;
    }
    const frameProfile = parsed ? extractFrameProfile(parsed) : null;
    if (clientExpectedProfile && frameProfile && clientExpectedProfile !== frameProfile) {
      metrics.increment('relay_frames_client_rejected_profile_mismatch_total');
      logger.warn('client_frame_rejected', {
        workspaceId,
        clientId,
        reason: 'profile_mismatch',
        expectedProfile: clientExpectedProfile,
        gotProfile: frameProfile,
      });
      closeWithReason(ws, 4008, 'client frame profile mismatch');
      return;
    }
    if (parsed?.['type'] === 'relay_key_exchange_init') {
      if (!kexRateLimiter.allow(kexLimiterKey)) {
        metrics.increment('relay_frames_client_kex_rate_limited_total');
        logger.warn('client_frame_rate_limited', {
          workspaceId,
          clientId,
          reason: 'kex_rate_limit',
        });
        closeWithReason(ws, 4008, 'key exchange rate limit exceeded');
        return;
      }
      const requestId = typeof parsed['requestId'] === 'string' ? parsed['requestId'].trim() : '';
      if (requestId) {
        trackKeyExchangeRequest(
          state,
          requestId,
          {
            clientWs: ws,
            createdAt: Date.now(),
          },
          context.config.maxPairingRequestTrack,
        );
      }
    }
    if (isE2eeEnvelope(parsed)) {
      if (!runtimeLimiterByClient.allow(clientId) || !runtimeLimiterByWorkspace.allow(workspaceId)) {
        metrics.increment('relay_frames_client_runtime_rate_limited_total');
        closeWithReason(ws, 4008, 'runtime rate limit exceeded');
        return;
      }
    }
    if (isPairingFrame) {
      if (!pairingRateLimiter.allow(pairingLimiterKey)) {
        metrics.increment('relay_frames_client_pairing_rate_limited_total');
        closeWithReason(ws, 4008, 'pairing rate limit exceeded');
        return;
      }
      const requestId = extractPairingRequestId(parsed);
      if (requestId) {
        trackPairingRequest(
          state,
          requestId,
          {
            clientWs: ws,
            createdAt: Date.now(),
          },
          context.config.maxPairingRequestTrack,
        );
      }
    }
    if (!state.daemon || state.daemon.readyState !== WebSocket.OPEN) {
      void routeClientMessageWithoutLocalDaemon(
        context,
        ws,
        {
          workspaceId,
          projectMachineBindingId,
          machineId,
          clientId,
          payload: text,
        },
      );
      return;
    }
    metrics.increment('relay_frames_client_to_daemon_total');
    metrics.increment('relay_bytes_client_to_daemon_total', size);
    safeSend(state.daemon, text);
  });

  ws.on('close', () => {
    registry.removeClient(scopeKey, ws);
    adjustIpConnectionCount(ip, -1);
    metrics.increment('relay_ws_connections_closed_total');
    logger.info('client_disconnected', { workspaceId, clientId, ip });
    updateGauges();
  });

  ws.on('error', (error) => {
    logger.warn('client_ws_error', {
      workspaceId,
      clientId,
      ip,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

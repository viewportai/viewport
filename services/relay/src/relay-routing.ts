import { WebSocket } from 'ws';
import type { RelayBusFrame } from './bus.js';
import type { RelayBackplane } from './backplane.js';
import type { RelayConfig } from './config.js';
import type { RelayLogger } from './logger.js';
import type { RelayMetrics } from './metrics.js';
import type { ConnectionRegistry } from './registry.js';
import { FixedWindowRateLimiter, TokenBucketRateLimiter } from './security.js';
import type { AdmissionClaims, RelayRole, RelayStatusPayload } from './types.js';

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

type FramePayload = Record<string, unknown>;
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

function parseFramePayload(text: string): FramePayload | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FramePayload;
  } catch {
    return null;
  }
}

function isE2eeEnvelope(frame: FramePayload): boolean {
  return (
    frame['type'] === 'e2ee' &&
    frame['version'] === 2 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['epoch'] === 'number' &&
    Number.isInteger(frame['epoch']) &&
    (frame['epoch'] as number) >= 1 &&
    typeof frame['seq'] === 'number' &&
    Number.isInteger(frame['seq']) &&
    (frame['seq'] as number) >= 1 &&
    typeof frame['iv'] === 'string' &&
    typeof frame['tag'] === 'string' &&
    typeof frame['ciphertext'] === 'string'
  );
}

function isClientControlFrame(frame: FramePayload): boolean {
  if (
    frame['type'] === 'relay_key_exchange_init' &&
    frame['version'] === 3 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['clientEphemeralPublicKey'] === 'string' &&
    typeof frame['encryptedClientStatic'] === 'string'
  ) {
    if (
      frame['profile'] === 'noise-ikpsk2' &&
      (typeof frame['pairingPeerId'] !== 'string' || frame['pairingPeerId'].trim().length === 0)
    ) {
      return false;
    }
    return true;
  }

  if (
    frame['type'] === 'relay_key_exchange_init' &&
    frame['version'] === 2 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['clientPublicKey'] === 'string' &&
    typeof frame['clientNonce'] === 'string' &&
    typeof frame['clientProof'] === 'string'
  ) {
    if (
      frame['profile'] === 'noise-ikpsk2' &&
      (typeof frame['pairingPeerId'] !== 'string' || frame['pairingPeerId'].trim().length === 0)
    ) {
      return false;
    }
    return true;
  }

  return false;
}

function isDaemonControlFrame(frame: FramePayload): boolean {
  if (
    frame['type'] === 'relay_key_update_required' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['nextEpoch'] === 'number'
  ) {
    return true;
  }
  if (
    frame['type'] === 'relay_key_exchange_response' &&
    frame['version'] === 3 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['daemonPublicKey'] === 'string' &&
    typeof frame['daemonEphemeralPublicKey'] === 'string' &&
    typeof frame['encryptedMetadata'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['epoch'] === 'number' &&
    Number.isInteger(frame['epoch']) &&
    (frame['epoch'] as number) >= 1 &&
    typeof frame['proof'] === 'string'
  ) {
    return true;
  }

  return (
    frame['type'] === 'relay_key_exchange_response' &&
    frame['version'] === 2 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['daemonNonce'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['epoch'] === 'number' &&
    typeof frame['proof'] === 'string'
  );
}

function isPairingOfferRequestFrame(frame: FramePayload): boolean {
  return (
    frame['type'] === 'relay_pairing_offer_request' &&
    typeof frame['requestId'] === 'string' &&
    frame['requestId'].trim().length > 0 &&
    typeof frame['clientChannelPublicKey'] === 'string' &&
    frame['clientChannelPublicKey'].trim().length > 0 &&
    (typeof frame['ttlSeconds'] === 'undefined' ||
      (typeof frame['ttlSeconds'] === 'number' &&
        Number.isInteger(frame['ttlSeconds']) &&
        (frame['ttlSeconds'] as number) >= 30 &&
        (frame['ttlSeconds'] as number) <= 3600))
  );
}

function isPairingRedeemRequestFrame(frame: FramePayload): boolean {
  return (
    frame['type'] === 'relay_pairing_redeem_request' &&
    typeof frame['requestId'] === 'string' &&
    frame['requestId'].trim().length > 0 &&
    typeof frame['offerId'] === 'string' &&
    frame['offerId'].trim().length > 0 &&
    typeof frame['encIv'] === 'string' &&
    frame['encIv'].trim().length > 0 &&
    typeof frame['encTag'] === 'string' &&
    frame['encTag'].trim().length > 0 &&
    typeof frame['encCiphertext'] === 'string' &&
    frame['encCiphertext'].trim().length > 0
  );
}

function isPairingResponseFrame(frame: FramePayload): boolean {
  const type = frame['type'];
  if (type !== 'relay_pairing_offer_response' && type !== 'relay_pairing_redeem_response') {
    return false;
  }
  if (typeof frame['requestId'] !== 'string' || frame['requestId'].trim().length === 0) {
    return false;
  }
  if (typeof frame['ok'] !== 'boolean') return false;
  if (frame['ok'] === false) {
    return typeof frame['errorCode'] === 'string' && frame['errorCode'].trim().length > 0;
  }
  if (type === 'relay_pairing_offer_response') {
    return (
      typeof frame['daemonChannelPublicKey'] === 'string' &&
      frame['daemonChannelPublicKey'].trim().length > 0 &&
      typeof frame['encIv'] === 'string' &&
      frame['encIv'].trim().length > 0 &&
      typeof frame['encTag'] === 'string' &&
      frame['encTag'].trim().length > 0 &&
      typeof frame['encCiphertext'] === 'string' &&
      frame['encCiphertext'].trim().length > 0
    );
  }
  return true;
}

function extractPairingRequestId(frame: FramePayload): string | null {
  if (isPairingOfferRequestFrame(frame) || isPairingRedeemRequestFrame(frame)) {
    return (frame['requestId'] as string).trim();
  }
  if (isPairingResponseFrame(frame)) {
    return (frame['requestId'] as string).trim();
  }
  return null;
}

function isPairingClientFrame(frame: FramePayload): boolean {
  return isPairingOfferRequestFrame(frame) || isPairingRedeemRequestFrame(frame);
}

function isPairingDaemonFrame(frame: FramePayload): boolean {
  return isPairingResponseFrame(frame);
}

function isKeyExchangeInitFrame(frame: FramePayload): boolean {
  return isClientControlFrame(frame) && frame['type'] === 'relay_key_exchange_init';
}

function isKeyExchangeResponseFrame(frame: FramePayload): boolean {
  return isDaemonControlFrame(frame) && frame['type'] === 'relay_key_exchange_response';
}

function isKeyUpdateRequiredFrame(frame: FramePayload): boolean {
  return isDaemonControlFrame(frame) && frame['type'] === 'relay_key_update_required';
}

function isAllowedClientFrame(text: string): boolean {
  const frame = parseFramePayload(text);
  if (!frame) return false;
  return isE2eeEnvelope(frame) || isClientControlFrame(frame) || isPairingClientFrame(frame);
}

function isAllowedDaemonFrame(text: string): boolean {
  const frame = parseFramePayload(text);
  if (!frame) return false;
  return isE2eeEnvelope(frame) || isDaemonControlFrame(frame) || isPairingDaemonFrame(frame);
}

function extractFrameProfile(frame: FramePayload): 'noise-ik' | 'noise-ikpsk2' | null {
  const profile = frame['profile'];
  if (profile === 'noise-ik' || profile === 'noise-ikpsk2') return profile;
  return null;
}

function profileStrength(profile: 'noise-ik' | 'noise-ikpsk2'): number {
  return profile === 'noise-ikpsk2' ? 2 : 1;
}

export function relayStatusPayload(workspaceId: string): RelayStatusPayload {
  return {
    type: 'relay_status',
    code: 'DAEMON_UNAVAILABLE',
    message: 'No workspace-daemon is connected for this workspace',
    workspaceId,
  };
}

export function relayRedirectPayload(workspaceId: string, relayWsBaseUrl: string): RelayStatusPayload {
  return {
    type: 'relay_status',
    code: 'RELAY_REDIRECT',
    message: 'Workspace is assigned to a different relay instance',
    workspaceId,
    relayWsBaseUrl,
  };
}

async function routeClientMessageWithoutLocalDaemon(
  context: RelayRoutingContext,
  ws: WebSocket,
  workspaceId: string,
  clientId: string,
  payload: string,
): Promise<void> {
  const { config, safeSend, metrics, logger } = context;
  const { backplane } = context;
  const preferred = await backplane.resolvePresence(workspaceId);
  if (preferred && preferred.daemonConnected && preferred.relayId !== config.relayId) {
    if (config.clientRedirectEnabled) {
      safeSend(ws, JSON.stringify(relayRedirectPayload(workspaceId, preferred.relayWsBaseUrl)));
    }
    const published = await backplane.publishClientToDaemon(
      workspaceId,
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
  safeSend(ws, JSON.stringify(relayStatusPayload(workspaceId)));
  logger.warn('client_message_dropped', { workspaceId, clientId, reason: 'daemon_unavailable' });
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
  sessionId: string,
  text: string,
): boolean {
  const { registry, safeSend, metrics } = context;
  const { backplane } = context;
  const state = registry.getOrCreate(workspaceId);
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

  if (owner.sourceRelayId) {
    void backplane.publishDaemonToClients(workspaceId, text, owner.sourceRelayId);
    metrics.increment('relay_session_frame_routed_bus_total');
    return true;
  }

  metrics.increment('relay_session_frame_dropped_total');
  return false;
}

function resolveRuntimeLimiters(
  context: RelayRoutingContext,
): { byClient: TokenBucketRateLimiter; byWorkspace: TokenBucketRateLimiter } {
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

function resolveControlFrameLimiters(
  context: RelayRoutingContext,
): { kex: FixedWindowRateLimiter; pairing: FixedWindowRateLimiter } {
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
  text: string,
  parsedFrame: FramePayload,
): boolean {
  const { registry, safeSend, metrics, logger } = context;
  const { backplane } = context;
  const requestId =
    typeof parsedFrame['requestId'] === 'string' ? parsedFrame['requestId'].trim() : '';
  const sessionId =
    typeof parsedFrame['sessionId'] === 'string' ? parsedFrame['sessionId'].trim() : '';
  if (!requestId || !sessionId) {
    metrics.increment('relay_key_exchange_response_dropped_total');
    return true;
  }
  const state = registry.getOrCreate(workspaceId);
  pruneStaleKeyExchangeRequests(state);
  const owner = state.keyExchangeRequests.get(requestId);
  if (!owner) {
    metrics.increment('relay_key_exchange_response_dropped_total');
    logger.warn('key_exchange_response_owner_missing', { workspaceId, requestId, sessionId });
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
  if (owner.sourceRelayId) {
    void backplane.publishDaemonToClients(workspaceId, text, owner.sourceRelayId);
    metrics.increment('relay_key_exchange_response_routed_bus_total');
    return true;
  }
  metrics.increment('relay_key_exchange_response_dropped_total');
  return true;
}

function routePairingResponse(
  context: RelayRoutingContext,
  workspaceId: string,
  text: string,
  parsedFrame: FramePayload,
): boolean {
  const { registry, safeSend, metrics, logger } = context;
  const { backplane } = context;
  const state = registry.getOrCreate(workspaceId);
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
  if (owner.sourceRelayId) {
    void backplane.publishDaemonToClients(workspaceId, text, owner.sourceRelayId);
    metrics.increment('relay_pairing_response_routed_bus_total');
    return true;
  }
  metrics.increment('relay_pairing_response_dropped_total');
  return true;
}

export function routeBusFrame(context: RelayRoutingContext, frame: RelayBusFrame): void {
  const { registry, safeSend, metrics, logger } = context;
  const state = registry.getOrCreate(frame.workspaceId);
  registry.touch(frame.workspaceId);
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
    routeKeyExchangeResponse(context, frame.workspaceId, frame.payload, parsed);
    metrics.increment('relay_bus_frames_to_clients_total');
    return;
  }
  if (parsed && isPairingDaemonFrame(parsed)) {
    routePairingResponse(context, frame.workspaceId, frame.payload, parsed);
    metrics.increment('relay_bus_frames_to_clients_total');
    return;
  }

  if (parsed && isE2eeEnvelope(parsed) && typeof parsed['sessionId'] === 'string') {
    const routed = routeSessionOwnedFrame(
      context,
      frame.workspaceId,
      parsed['sessionId'],
      frame.payload,
    );
    if (routed) {
      metrics.increment('relay_bus_frames_to_clients_total');
    }
    return;
  }

  if (parsed && isKeyUpdateRequiredFrame(parsed) && typeof parsed['sessionId'] === 'string') {
    const routed = routeSessionOwnedFrame(
      context,
      frame.workspaceId,
      parsed['sessionId'],
      frame.payload,
    );
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

  const clientScopeClaim = claims?.scope;
  const claimedWorkspaceId =
    typeof claims?.workspaceId === 'string' ? claims.workspaceId.trim() : '';
  if (claimedWorkspaceId === '') {
    metrics.increment('relay_ws_connections_rejected_total');
    logger.warn('connection_rejected', {
      workspaceId,
      role,
      ip,
      reason: 'missing_workspace_claim',
    });
    closeWithReason(ws, 4008, 'missing workspace claim');
    return;
  }
  if (claimedWorkspaceId !== workspaceId) {
    metrics.increment('relay_ws_connections_rejected_total');
    logger.warn('connection_rejected', {
      workspaceId,
      claimedWorkspaceId,
      role,
      ip,
      reason: 'workspace_claim_mismatch',
    });
    closeWithReason(ws, 4008, 'workspace claim mismatch');
    return;
  }
  if (role === 'client' && clientScopeClaim !== 'runtime' && clientScopeClaim !== 'pairing') {
    metrics.increment('relay_ws_connections_rejected_total');
    logger.warn('client_connection_rejected', {
      workspaceId,
      ip,
      reason: 'invalid_scope_claim',
      scope: clientScopeClaim,
    });
    closeWithReason(ws, 4008, 'invalid scope claim');
    return;
  }

  const state = registry.getOrCreate(workspaceId);
  registry.touch(workspaceId);
  pruneStalePairingRequests(state);
  pruneStaleKeyExchangeRequests(state);
  pruneStaleSessionOwners(state);
  wsIp.set(ws, ip);
  wsWorkspace.set(ws, workspaceId);
  wsRole.set(ws, role);
  adjustIpConnectionCount(ip, 1);
  setupHeartbeat(ws);
  metrics.increment('relay_ws_connections_opened_total');

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
    state.daemon = ws;
    if (daemonIssueGeneration !== null) {
      state.daemonIssueGeneration = daemonIssueGeneration;
    }
    state.keyExchangeRequests.clear();
    state.sessionOwners.clear();
    void context.backplane.upsertPresence(workspaceId, true);
    logger.info('daemon_connected', { workspaceId, ip });
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
        logger.warn('daemon_frame_rejected', { workspaceId, reason: 'invalid_daemon_frame' });
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
        routePairingResponse(context, workspaceId, text, parsed);
        metrics.increment('relay_frames_daemon_to_clients_total');
        metrics.increment('relay_bytes_daemon_to_clients_total', size);
        return;
      }
      if (parsed && isKeyExchangeResponseFrame(parsed)) {
        routeKeyExchangeResponse(context, workspaceId, text, parsed);
        metrics.increment('relay_frames_daemon_to_clients_total');
        metrics.increment('relay_bytes_daemon_to_clients_total', size);
        return;
      }
      if (parsed && isE2eeEnvelope(parsed) && typeof parsed['sessionId'] === 'string') {
        routeSessionOwnedFrame(context, workspaceId, parsed['sessionId'], text);
        metrics.increment('relay_frames_daemon_to_clients_total');
        metrics.increment('relay_bytes_daemon_to_clients_total', size);
        return;
      }
      if (parsed && isKeyUpdateRequiredFrame(parsed) && typeof parsed['sessionId'] === 'string') {
        routeSessionOwnedFrame(context, workspaceId, parsed['sessionId'], text);
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
      registry.clearDaemon(workspaceId, ws);
      void context.backplane.upsertPresence(workspaceId, false);
      adjustIpConnectionCount(ip, -1);
      metrics.increment('relay_ws_connections_closed_total');
      logger.info('daemon_disconnected', { workspaceId, ip });
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
  const clientScope: 'runtime' | 'pairing' =
    clientScopeClaim === 'pairing' ? 'pairing' : 'runtime';
  const clientExpectedProfile = claims?.e2eeProfile;
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
  const runtimeLimiterByWorkspace =
    runtimeWorkspaceLimiter ?? resolvedRuntimeLimiters.byWorkspace;
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
      logger.warn('client_frame_rejected', { workspaceId, clientId, reason: 'invalid_client_frame' });
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
    if (
      clientExpectedProfile &&
      frameProfile &&
      clientExpectedProfile !== frameProfile
    ) {
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
      if (
        !runtimeLimiterByClient.allow(clientId) ||
        !runtimeLimiterByWorkspace.allow(workspaceId)
      ) {
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
      void routeClientMessageWithoutLocalDaemon(context, ws, workspaceId, clientId, text);
      return;
    }
    metrics.increment('relay_frames_client_to_daemon_total');
    metrics.increment('relay_bytes_client_to_daemon_total', size);
    safeSend(state.daemon, text);
  });

  ws.on('close', () => {
    registry.removeClient(workspaceId, ws);
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

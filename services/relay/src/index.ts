import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { validateAdmission } from './admission.js';
import { createRelayBackplane } from './backplane.js';
import { loadConfig } from './config.js';
import { RelayLogger } from './logger.js';
import { RelayMetrics } from './metrics.js';
import { registerConnection, routeBusFrame } from './relay-routing.js';
import { relayRedirectPayload } from './relay-status-payloads.js';
import { ConnectionRegistry } from './registry.js';
import { resolveUpgradeAuth } from './upgrade-auth.js';
import {
  extractIpAddressWithTrustedProxies,
  FixedWindowRateLimiter,
  isAdminAuthorized,
  TokenBucketRateLimiter,
} from './security.js';
import type { RelayRole } from './types.js';

const cliArgs = new Set(process.argv.slice(2));
if (cliArgs.has('--help') || cliArgs.has('-h')) {
  console.log('Viewport relay');
  console.log('');
  console.log('Environment-driven WebSocket relay for remote daemon access.');
  console.log('');
  console.log('Key variables: HOST, PORT, SERVER_URL, RELAY_PUBLIC_WS_BASE_URL, RELAY_MODE');
  process.exit(0);
}
if (cliArgs.has('--version') || cliArgs.has('-v')) {
  console.log(packageJson.version);
  process.exit(0);
}

const config = loadConfig();
const logger = new RelayLogger(config.maxLogs);
const metrics = new RelayMetrics();
const registry = new ConnectionRegistry();
const backplane = createRelayBackplane(config, logger, metrics);
const upgradeLimiter = new FixedWindowRateLimiter(config.maxUpgradeRatePerMinute, 60_000, config.maxUpgradeRateBuckets);
const kexFrameLimiter = new FixedWindowRateLimiter(
  config.maxKeyExchangeInitPerMinute,
  60_000,
  config.kexRateLimiterMaxKeys,
);
const pairingFrameLimiter = new FixedWindowRateLimiter(
  config.maxPairingFramesPerMinute,
  60_000,
  config.pairingRateLimiterMaxKeys,
);
const runtimeClientLimiter = new TokenBucketRateLimiter(
  config.maxRuntimeFramesPerMinute,
  60_000,
  config.runtimeRateLimiterMaxKeys,
);
const runtimeWorkspaceLimiter = new TokenBucketRateLimiter(
  config.maxRuntimeFramesPerMinuteWorkspace,
  60_000,
  config.runtimeWorkspaceRateLimiterMaxKeys,
);
const daemonFrameLimiter = new TokenBucketRateLimiter(
  config.maxDaemonRuntimeFramesPerMinute,
  60_000,
  config.daemonRateLimiterMaxKeys,
);
const ipConnectionCounts = new Map<string, number>();
const wsIp = new WeakMap<WebSocket, string>();
const wsWorkspace = new WeakMap<WebSocket, string>();
const wsRole = new WeakMap<WebSocket, RelayRole>();
const wsHeartbeatState = new WeakMap<
  WebSocket,
  {
    awaitingPong: boolean;
    lastPongAt: number;
    pingSentAt: number;
    lastActivityAt: number;
  }
>();

const UpgradeQuerySchema = z.object({
  role: z.enum(['workspace-daemon', 'client', 'worker']),
  workspaceId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  runtimeTargetId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
});

function closeWithReason(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore
  }
}

function terminateWithReason(ws: WebSocket, reason: string): void {
  logger.warn('ws_terminated', { reason });
  try {
    ws.terminate();
  } catch {
    // ignore
  }
}

function adjustIpConnectionCount(ip: string, delta: number): void {
  const next = (ipConnectionCounts.get(ip) ?? 0) + delta;
  if (next <= 0) {
    ipConnectionCounts.delete(ip);
    return;
  }
  ipConnectionCounts.set(ip, next);
}

function updateGauges(): void {
  metrics.setGauge('relay_connections_total', registry.totalConnectionCount());
  metrics.setGauge('relay_workspaces_total', registry.workspaceEntries().length);
}

function safeSend(ws: WebSocket, payload: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > config.maxPendingBytes) {
    metrics.increment('relay_ws_slow_client_terminated_total');
    closeWithReason(ws, 4008, 'buffer overflow');
    return false;
  }
  ws.send(payload);
  return true;
}

function buildStatePayload(): Record<string, unknown> {
  return {
    ok: true,
    service: 'relay',
    relayMode: config.relayMode,
    serverUrl: config.healthVerbose ? config.serverUrl : undefined,
    tlsEnabled: config.healthVerbose ? config.tlsEnabled : undefined,
    tlsHost: config.healthVerbose ? config.tlsHost : undefined,
    wsBaseUrl: config.healthVerbose ? config.publicWsBaseUrl : undefined,
    relayId: config.relayId,
    backplaneMode: config.backplaneMode,
    busEnabled: config.busEnabled,
    clientRedirectEnabled: config.clientRedirectEnabled,
    workspaces: registry.workspaceEntries().map(([, state]) => ({
      workspaceId: state.workspaceId,
      runtimeTargetId: state.runtimeTargetId,
      daemonConnected: !!(state.daemon && state.daemon.readyState === WebSocket.OPEN),
      clientCount: [...state.clients.keys()].filter((ws) => ws.readyState === WebSocket.OPEN).length,
      clientIds: config.stateIncludeClientIds ? [...state.clients.values()].map((item) => item.clientId) : undefined,
      lastActivityAt: new Date(state.lastActivityAt).toISOString(),
    })),
  };
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function requireAdmin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!config.enableAdminHttp) {
    writeJson(res, 404, { ok: false, reason: 'ADMIN_ENDPOINTS_DISABLED' });
    return false;
  }
  const authorized = isAdminAuthorized(req, config.relayAdminTokenHash, config.enableAdminHttp);
  if (!authorized) {
    writeJson(res, 401, { ok: false, reason: 'ADMIN_UNAUTHORIZED' });
    metrics.increment('relay_admin_unauthorized_total');
    return false;
  }
  return true;
}

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!req.url) {
    writeJson(res, 400, { ok: false, reason: 'MISSING_URL' });
    return;
  }
  const parsed = new URL(
    req.url,
    `${config.tlsEnabled ? 'https' : 'http'}://${req.headers.host || `${config.host}:${config.port}`}`,
  );

  if (req.method === 'GET' && parsed.pathname === '/health') {
    const payload: Record<string, unknown> = {
      ok: true,
      service: 'relay',
      uptimeMs: Math.round(process.uptime() * 1000),
    };
    if (config.healthVerbose) {
      payload['tlsEnabled'] = config.tlsEnabled;
      payload['relayMode'] = config.relayMode;
      payload['relayId'] = config.relayId;
    }
    writeJson(res, 200, payload);
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/state') {
    if (!requireAdmin(req, res)) return;
    writeJson(res, 200, buildStatePayload());
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/logs') {
    if (!requireAdmin(req, res)) return;
    writeJson(res, 200, {
      ok: true,
      logs: config.healthVerbose ? logger.recent() : logger.recentSummaries(),
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/metrics') {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    res.end(metrics.toPrometheus());
    return;
  }

  writeJson(res, 404, { ok: false, reason: 'NOT_FOUND' });
}

const server = config.tlsEnabled
  ? https.createServer(
      {
        cert: fs.readFileSync(config.tlsCertPath),
        key: fs.readFileSync(config.tlsKeyPath),
      },
      requestHandler,
    )
  : http.createServer(requestHandler);

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: config.maxFrameBytes,
});

function setupHeartbeat(ws: WebSocket): void {
  const now = Date.now();
  wsHeartbeatState.set(ws, {
    awaitingPong: false,
    lastPongAt: now,
    pingSentAt: 0,
    lastActivityAt: now,
  });
  ws.on('pong', () => {
    const state = wsHeartbeatState.get(ws);
    if (!state) return;
    state.awaitingPong = false;
    state.lastPongAt = Date.now();
    state.lastActivityAt = Date.now();
  });
}

function markWsActivity(ws: WebSocket): void {
  const state = wsHeartbeatState.get(ws);
  if (!state) return;
  state.lastActivityAt = Date.now();
}

const routingContext = {
  config,
  logger,
  metrics,
  registry,
  backplane,
  wsIp,
  wsWorkspace,
  wsRole,
  setupHeartbeat,
  markWsActivity,
  adjustIpConnectionCount,
  updateGauges,
  safeSend,
  closeWithReason,
  kexFrameLimiter,
  pairingFrameLimiter,
  runtimeClientLimiter,
  runtimeWorkspaceLimiter,
  daemonFrameLimiter,
};

server.on('upgrade', async (req, socket, head) => {
  const ip = extractIpAddressWithTrustedProxies(req, config.trustedProxies);
  try {
    if (!upgradeLimiter.allow(ip)) {
      metrics.increment('relay_upgrade_rate_limited_total');
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    const totalConnections = registry.totalConnectionCount();
    if (totalConnections >= config.maxTotalConnections) {
      metrics.increment('relay_upgrade_rejected_total_connections_total');
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    if ((ipConnectionCounts.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
      metrics.increment('relay_upgrade_rejected_ip_connections_total');
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsed = new URL(
      req.url || '/',
      `${config.tlsEnabled ? 'https' : 'http'}://${req.headers.host || `${config.host}:${config.port}`}`,
    );

    if (parsed.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const validated = UpgradeQuerySchema.safeParse({
      role: parsed.searchParams.get('role') ?? '',
      workspaceId: parsed.searchParams.get('workspaceId') ?? '',
      runtimeTargetId: parsed.searchParams.get('runtimeTargetId') ?? undefined,
    });
    if (!validated.success) {
      metrics.increment('relay_upgrade_invalid_query_total');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const { role, workspaceId } = validated.data;
    const runtimeTargetId = validated.data.runtimeTargetId;
    const auth = resolveUpgradeAuth({
      relayMode: config.relayMode,
      authorizationHeader: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      protocolHeader:
        typeof req.headers['sec-websocket-protocol'] === 'string' ? req.headers['sec-websocket-protocol'] : undefined,
      queryToken: parsed.searchParams.get('token') ?? undefined,
    });
    if (!auth.ok) {
      metrics.increment('relay_upgrade_missing_auth_total');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = auth.token;

    if (role === 'client') {
      const workspaceState = registry.getOrCreate(
        runtimeTargetId ? `${workspaceId}:${runtimeTargetId}` : workspaceId,
      );
      if (workspaceState.clients.size >= config.maxClientsPerWorkspace) {
        metrics.increment('relay_upgrade_rejected_workspace_clients_total');
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const admission = await validateAdmission(config, {
      token,
      role,
      workspaceId,
      runtimeTargetId,
    });
    if (!admission.ok) {
      metrics.increment('relay_admission_denied_total');
      logger.warn('admission_denied', {
        role,
        workspaceId,
        reason: admission.reason,
        status: admission.status,
        ip,
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    metrics.increment('relay_admission_ok_total');
    let redirectWsBaseUrl: string | null = null;
    if (role === 'client' && config.clientRedirectEnabled && runtimeTargetId) {
      const preferred = await backplane.resolvePresence(workspaceId, runtimeTargetId);
      if (preferred && preferred.daemonConnected && preferred.relayWsBaseUrl !== config.publicWsBaseUrl) {
        redirectWsBaseUrl = preferred.relayWsBaseUrl;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      registerConnection(routingContext, ws, role, workspaceId, runtimeTargetId, ip, admission.claims);
      if (redirectWsBaseUrl) {
        metrics.increment('relay_client_redirect_total');
        safeSend(ws, JSON.stringify(relayRedirectPayload(workspaceId, redirectWsBaseUrl)));
      }
    });
  } catch (error) {
    metrics.increment('relay_upgrade_errors_total');
    logger.error('upgrade_error', {
      ip,
      error: error instanceof Error ? error.message : String(error),
    });
    socket.destroy();
  }
});

const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const state = wsHeartbeatState.get(ws);
    if (!state) continue;
    if (now - state.lastActivityAt > config.idleTimeoutMs) {
      metrics.increment('relay_ws_idle_terminated_total');
      terminateWithReason(ws, 'idle timeout');
      continue;
    }
    if (state.awaitingPong && now - state.pingSentAt > config.pongTimeoutMs) {
      metrics.increment('relay_ws_stale_terminated_total');
      terminateWithReason(ws, 'heartbeat timeout');
      continue;
    }
    state.awaitingPong = true;
    state.pingSentAt = now;
    try {
      ws.ping();
    } catch {
      terminateWithReason(ws, 'ping failed');
    }
  }
  upgradeLimiter.sweepStale(now);
  kexFrameLimiter.sweepStale(now);
  pairingFrameLimiter.sweepStale(now);
  runtimeClientLimiter.sweepStale(now);
  runtimeWorkspaceLimiter.sweepStale(now);
  daemonFrameLimiter.sweepStale(now);
}, config.pingIntervalMs);

const cleanupInterval = setInterval(() => {
  const removed = registry.pruneEmpty(config.emptyWorkspaceTtlMs);
  for (const workspaceId of removed) {
    logger.info('workspace_evicted', { workspaceId });
    metrics.increment('relay_workspace_evictions_total');
  }
  updateGauges();
}, config.cleanupIntervalMs);

const presenceSyncInterval = setInterval(async () => {
  if (!config.presenceSyncEnabled) return;
  for (const [, state] of registry.workspaceEntries()) {
    if (state.daemon && state.daemon.readyState === WebSocket.OPEN) {
      await backplane.upsertPresence(state.workspaceId, true, state.runtimeTargetId);
    }
  }
}, config.presenceSyncIntervalMs);

let busPollInFlight = false;
const busPollInterval = setInterval(async () => {
  if (!config.busEnabled || !backplane.crossRelayEnabled || busPollInFlight) return;
  if (registry.totalConnectionCount() === 0) return;
  busPollInFlight = true;
  try {
    const frames = await backplane.pullFrames();
    for (const frame of frames) {
      routeBusFrame(routingContext, frame);
    }
  } finally {
    busPollInFlight = false;
  }
}, config.busPollIntervalMs);

const shutdown = (): void => {
  clearInterval(heartbeatInterval);
  clearInterval(cleanupInterval);
  clearInterval(presenceSyncInterval);
  clearInterval(busPollInterval);
  void backplane.close?.();
  for (const ws of wss.clients) {
    closeWithReason(ws, 1001, 'relay shutting down');
  }
  server.close();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(config.port, config.host, () => {
  logger.info('relay_started', {
    host: config.host,
    port: config.port,
    serverUrl: config.serverUrl,
    relayId: config.relayId,
    publicWsBaseUrl: config.publicWsBaseUrl,
    clientRedirectEnabled: config.clientRedirectEnabled,
    backplaneMode: config.backplaneMode,
    busEnabled: config.busEnabled,
    busPollIntervalMs: config.busPollIntervalMs,
    busPullLimit: config.busPullLimit,
    busPullWaitMs: config.busPullWaitMs,
    tlsEnabled: config.tlsEnabled,
    tlsCertPath: config.tlsEnabled ? config.tlsCertPath : null,
    tlsKeyPath: config.tlsEnabled ? config.tlsKeyPath : null,
    maxTotalConnections: config.maxTotalConnections,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    maxClientsPerWorkspace: config.maxClientsPerWorkspace,
    maxFrameBytes: config.maxFrameBytes,
    maxKeyExchangeInitPerMinute: config.maxKeyExchangeInitPerMinute,
    idleTimeoutMs: config.idleTimeoutMs,
    adminHttpEnabled: config.enableAdminHttp,
  });

  console.log(
    `[relay] listening on ${config.tlsEnabled ? 'https' : 'http'}://${config.host}:${config.port} ` +
      `(ws=${config.publicWsBaseUrl}, server=${config.serverUrl})`,
  );
});

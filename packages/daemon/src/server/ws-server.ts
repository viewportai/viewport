/**
 * WebSocket server — real-time protocol for monitoring and controlling sessions.
 *
 * Implements the Viewport wire protocol (plan/03_protocol.md):
 * - hello, launch, kill, prompt, respond-permission
 * - subscribe/unsubscribe with reconnect replay via ring buffer
 * - session-update with sequence numbers
 * - rollback, branch-retry, squash-merge
 * - ack responses for all client commands
 */

import type { FastifyInstance } from 'fastify';
import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import { logger } from '../core/logger.js';
import type { HookRouter } from '../hooks/router.js';
import type { SupervisionManager } from '../hooks/supervision.js';
import { RingBuffer } from './ring-buffer.js';
import { RateLimiter } from './rate-limiter.js';
import { IncomingMessageSchema, type IncomingMessage } from './ws-protocol.js';
import { sendHello } from './hello-builder.js';
import type { ConnectedClient } from './hello-builder.js';
import { ViewportError } from '../core/errors.js';
import { createWsCommandHandlers } from './ws-command-handlers.js';
import { metrics } from '../core/metrics.js';
import { registerWsDaemonEventBridge } from './ws-daemon-event-bridge.js';
import type { AuthProvider } from './auth.js';
import { extractTokenFromRequest } from './auth.js';
import type { SecurityProfile } from './security.js';
import { isHostAllowed, isOriginAllowed } from './security.js';
import { ErrorCodes } from '../core/error-codes.js';
import { resolveMaxWsClients } from './ws-limits.js';

const log = logger.child({ module: 'ws-server' });
const MAX_WS_MESSAGE_BYTES = 1_048_576;
const MAX_CLIENT_PENDING_BYTES = 4 * 1_048_576;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_RING_BUFFERS = 2048;

export interface WsServerOptions {
  hookRouter?: HookRouter;
  supervision?: SupervisionManager;
  auth?: AuthProvider;
  securityProfile?: SecurityProfile;
  maxClients?: number;
}

interface WsSocketLike {
  send: (data: string, cb?: (err?: Error) => void) => void;
  terminate: () => void;
  ping: () => void;
  on: (
    event: 'pong' | 'message' | 'close',
    cb: ((raw: Buffer | string) => void) | (() => void),
  ) => void;
}

export function registerWsServer(
  app: FastifyInstance,
  daemon: Daemon,
  registry?: AgentRegistry,
  wsOptions?: WsServerOptions,
): void {
  const hookRouter = wsOptions?.hookRouter;
  const supervision = wsOptions?.supervision;
  const auth = wsOptions?.auth;
  const securityProfile = wsOptions?.securityProfile;
  const ringBuffers = new Map<string, RingBuffer>();
  const clients = new Set<ConnectedClient>();
  const rateLimiter = new RateLimiter();
  let clientIdCounter = 0;
  const maxWsClients = resolveMaxWsClients(wsOptions?.maxClients);

  // Streaming state tracking: per-session flag for whether chunks are flowing
  const sessionStreaming = new Map<string, boolean>();

  // Backpressure: drop non-critical updates for slow clients
  const HIGH_WATERMARK_BYTES = 1024 * 1024;

  function enforceRingBufferCapacity(): void {
    while (ringBuffers.size > MAX_RING_BUFFERS) {
      const oldest = ringBuffers.keys().next();
      if (oldest.done) break;
      ringBuffers.delete(oldest.value);
    }
  }

  function getOrCreateBuffer(sessionId: string): RingBuffer {
    let buffer = ringBuffers.get(sessionId);
    if (!buffer) {
      enforceRingBufferCapacity();
      let directoryId: string | undefined;
      try {
        directoryId = daemon.getSessionInfo(sessionId).directoryId;
      } catch {
        directoryId = undefined;
      }
      buffer = new RingBuffer({ sessionId });
      if (directoryId) {
        buffer.setDirectoryId(directoryId);
      }
      ringBuffers.set(sessionId, buffer);
      enforceRingBufferCapacity();
    }
    return buffer;
  }

  function broadcastUpdate(sessionId: string, update: Record<string, unknown>): void {
    const buffer = getOrCreateBuffer(sessionId);
    const entry = buffer.push(sessionId, update);

    const msg = JSON.stringify({
      type: 'session-update',
      sessionId,
      seq: entry.seq,
      update,
    });

    const isDroppable =
      update.updateType === 'agent-thought-chunk' || update.updateType === 'agent-message-chunk';

    for (const client of clients) {
      if (client.subscriptions.has(sessionId)) {
        if (isDroppable && client.pendingBytes > HIGH_WATERMARK_BYTES) {
          log.debug(
            { sessionId, pendingBytes: client.pendingBytes },
            'Dropping chunk for slow client',
          );
          continue;
        }
        client.send(msg);
      }
    }
    metrics.increment('ws.updates.broadcast');
  }

  function sendAck(
    client: ConnectedClient,
    requestId: string | undefined,
    status: 'ok' | 'error',
    error?: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!requestId) return;
    const msg: Record<string, unknown> = { type: 'ack', requestId, status };
    if (error) msg.error = error;
    if (extra) Object.assign(msg, extra);
    client.send(JSON.stringify(msg));
  }

  const cleanupBridge = registerWsDaemonEventBridge({
    daemon,
    registry,
    clients,
    ringBuffers,
    sessionStreaming,
    broadcastUpdate,
    hookRouter,
    supervision,
  });

  // ---------------------------------------------------------------------------
  // Message handlers + dispatch
  // ---------------------------------------------------------------------------

  const handlers = createWsCommandHandlers({
    daemon,
    registry,
    hookRouter,
    supervision,
    sendAck,
    getOrCreateBuffer,
  });

  async function handleMessage(client: ConnectedClient, msg: IncomingMessage): Promise<void> {
    try {
      const handler = handlers[msg.type];
      await withTimeout(handler(client, msg as never), COMMAND_TIMEOUT_MS);
    } catch (err) {
      log.error({ type: msg.type, err }, 'WS handler error');
      if (isTimeoutError(err)) {
        metrics.increment('ws.messages.handler_timeout');
      }
      const errorCode = err instanceof ViewportError ? err.code : 'INTERNAL_ERROR';
      const effectiveErrorCode = isTimeoutError(err) ? ErrorCodes.COMMAND_TIMEOUT : errorCode;
      sendAck(
        client,
        msg.requestId,
        'error',
        err instanceof Error ? err.message : 'Unknown error',
        { errorCode: effectiveErrorCode },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket route
  // ---------------------------------------------------------------------------

  app.get('/ws', { websocket: true }, async (socketRaw, request) => {
    const socket = socketRaw as unknown as WsSocketLike;
    if (clients.size >= maxWsClients) {
      metrics.increment('ws.connections.rejected.max_clients');
      socket.terminate();
      return;
    }
    if (securityProfile) {
      const hostHeader = request.headers.host;
      const originHeader =
        typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      const hostAllowed = isHostAllowed(hostHeader, securityProfile);
      const originAllowed = isOriginAllowed(originHeader, securityProfile);
      if (!hostAllowed || !originAllowed) {
        metrics.increment('ws.connections.rejected.security_profile');
        socket.terminate();
        return;
      }
    }
    if (auth) {
      const allowQueryToken = securityProfile ? securityProfile.profile === 'local' : true;
      const token = extractTokenFromRequest({
        authorization:
          typeof request.headers.authorization === 'string'
            ? request.headers.authorization
            : undefined,
        url: request.url,
        allowQueryToken,
      });
      if (!token || !(await auth.validate(token))) {
        metrics.increment('ws.connections.rejected.unauthorized');
        socket.terminate();
        return;
      }
    }
    const clientId = String(++clientIdCounter);
    const client: ConnectedClient = {
      send: (data: string) => {
        try {
          if (client.pendingBytes > MAX_CLIENT_PENDING_BYTES) {
            log.warn(
              { clientId, pendingBytes: client.pendingBytes },
              'Terminating slow client due to sustained backpressure',
            );
            socket.terminate();
            return;
          }
          const bytes = Buffer.byteLength(data);
          if (bytes > MAX_WS_MESSAGE_BYTES) {
            metrics.increment('ws.messages.rejected_outbound_too_large');
            log.warn(
              { clientId, bytes, limit: MAX_WS_MESSAGE_BYTES },
              'Dropping oversized outbound WS payload',
            );
            return;
          }
          client.pendingBytes += bytes;
          socket.send(data, () => {
            client.pendingBytes -= bytes;
          });
        } catch (err) {
          log.debug({ clientId, err }, 'WS send failed (client may have disconnected)');
        }
      },
      subscriptions: new Set(),
      watchedDiscoveredSessions: new Set(),
      pendingBytes: 0,
    };

    clients.add(client);
    metrics.increment('ws.connections.total');
    metrics.gauge('ws.clients.connected', clients.size);
    sendHello(client, daemon, registry);

    // Keepalive: ping every 30s, terminate if pong not received
    let alive = true;
    const pingInterval = setInterval(() => {
      if (!alive) {
        log.debug({ clientId }, 'Client failed pong — terminating');
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on('pong', () => {
      alive = true;
    });

    socket.on('message', async (raw: Buffer | string) => {
      const rawSize = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
      metrics.increment('ws.messages.received');
      metrics.gauge('ws.last_message_bytes', rawSize);
      if (rawSize > MAX_WS_MESSAGE_BYTES) {
        metrics.increment('ws.messages.rejected_too_large');
        client.send(
          JSON.stringify({
            type: 'ack',
            status: 'error',
            error: `Payload exceeds ${MAX_WS_MESSAGE_BYTES} byte limit`,
            errorCode: ErrorCodes.PAYLOAD_TOO_LARGE,
          }),
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      } catch {
        metrics.increment('ws.messages.invalid_json');
        client.send(
          JSON.stringify({
            type: 'ack',
            status: 'error',
            error: 'Invalid JSON',
            errorCode: ErrorCodes.INVALID_JSON,
          }),
        );
        return;
      }

      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>)['type'] === 'string' &&
        typeof (parsed as Record<string, unknown>)['requestId'] !== 'string'
      ) {
        metrics.increment('ws.messages.missing_request_id');
        client.send(
          JSON.stringify({
            type: 'ack',
            status: 'error',
            error: 'Missing required requestId',
            errorCode: ErrorCodes.MISSING_REQUEST_ID,
          }),
        );
        return;
      }

      const result = IncomingMessageSchema.safeParse(parsed);
      if (!result.success) {
        metrics.increment('ws.messages.invalid_schema');
        const reqId = (parsed as Record<string, unknown>)?.requestId;
        sendAck(
          client,
          typeof reqId === 'string' ? reqId : undefined,
          'error',
          `Invalid message: ${result.error.issues[0]?.message ?? 'validation failed'}`,
          { errorCode: ErrorCodes.INVALID_MESSAGE },
        );
        return;
      }

      // Rate limit check
      if (!rateLimiter.check(clientId, result.data.type)) {
        metrics.increment('ws.messages.rate_limited');
        sendAck(
          client,
          result.data.requestId,
          'error',
          `Rate limited: too many ${result.data.type} requests`,
          { errorCode: ErrorCodes.RATE_LIMITED },
        );
        return;
      }

      await handleMessage(client, result.data);
    });

    socket.on('close', () => {
      clearInterval(pingInterval);
      clients.delete(client);
      metrics.gauge('ws.clients.connected', clients.size);
      rateLimiter.removeClient(clientId);

      // Release supervision — if this was the last supervisor for a session,
      // any pending hook permission requests will fall through to the terminal.
      if (supervision) {
        const released = supervision.removeClient(client);
        for (const sessionId of released) {
          hookRouter?.releaseSession(sessionId);
        }
      }
    });
  });

  // Clean up intervals when Fastify shuts down
  app.addHook('onClose', async () => {
    cleanupBridge();
    await Promise.all([...ringBuffers.values()].map((buffer) => buffer.flushPersistence()));
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Command timed out after ');
}

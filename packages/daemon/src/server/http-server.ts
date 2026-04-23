/**
 * HTTP server — REST endpoints for health, directories, diffs, files, and lifecycle control.
 *
 * Mounted on the same Fastify instance as the WebSocket server.
 */

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import type { HookRouter } from '../hooks/router.js';
import { HookBaseInputSchema } from '../hooks/types.js';
import type { AuthProvider } from './auth.js';
import { extractBearerToken } from './auth.js';
import type { SecurityProfile } from './security.js';
import { isHostAllowed, isLoopbackHost, isOriginAllowed, isPathWithin } from './security.js';
import { metrics } from '../core/metrics.js';
import { encodeProjectDir, readSessionMessagesRich } from '../discovery/jsonl-reader.js';
import { readCodexSessionMessagesRich } from '../discovery/codex.js';
import { issuePairingOffer, redeemPairingOffer } from './pairing-offers.js';
import { readPersistedReplayMeta, readPersistedSessionMessagesRich } from './ring-buffer.js';
import type { DaemonRelayBridgeStatus } from '../relay/daemon-relay-bridge.js';
import { resolveDaemonRuntimeIdentity } from '../core/runtime-identity.js';

const startTime = Date.now();

const SessionModeBodySchema = z.object({ mode: z.enum(['detect', 'bypass']) }).strict();
const WorktreeRollbackBodySchema = z.object({ toSha: z.string().trim().min(1) }).strict();
const WorktreeRetryBodySchema = z.object({ fromSha: z.string().trim().min(1) }).strict();
const WorktreeSquashBodySchema = z
  .object({
    targetBranch: z.string().trim().min(1).optional(),
    commitMessage: z.string().trim().min(1).optional(),
  })
  .strict();
const PermissionRespondBodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    requestId: z.string().trim().min(1),
    behavior: z.enum(['allow', 'deny']),
    message: z.string().trim().min(1).optional(),
    allowAlways: z.boolean().optional(),
  })
  .strict();
const DirectoryRegisterBodySchema = z
  .object({
    path: z.string().trim().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const PairRedeemBodySchema = z
  .object({
    offerId: z.string().trim().min(1),
    proof: z.string().trim().min(1),
    trustAnchor: z.string().trim().min(1),
    clientPublicKey: z.string().trim().min(1),
    clientProof: z.string().trim().min(1),
  })
  .strict();
const PairOfferBodySchema = z
  .object({
    ttlSeconds: z.number().int().min(30).max(3600).optional(),
  })
  .strict();
const HookBodySchema = HookBaseInputSchema.extend({
  adapter: z.string().trim().min(1).max(64).optional(),
}).passthrough();

const REDEEM_WINDOW_MS = 60_000;
const REDEEM_MAX_ATTEMPTS = 12;
const REDEEM_ATTEMPT_IP_MAP_MAX = 2_048;

interface RedeemAttemptEntry {
  attempts: number[];
  updatedAt: number;
}

function invalidPayloadError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid payload';
  const field = first.path.join('.') || '<root>';
  return `Invalid payload at ${field}: ${first.message}`;
}

export interface DaemonRuntimeInfo {
  pid: number;
  host: string;
  port: number;
  listen?: string;
  socketPath?: string;
  startedAt: number;
  version: string;
  relayEnabled?: boolean;
}

export interface HttpServerOptions {
  auth?: AuthProvider;
  hookRouter?: HookRouter;
  runtime?: DaemonRuntimeInfo;
  securityProfile?: SecurityProfile;
  onLifecycleShutdown?: () => Promise<void>;
  onLifecycleRestart?: () => Promise<void>;
  getRelayStatus?: () => DaemonRelayBridgeStatus | null;
}

function isHookAuthBypassAllowed(securityProfile?: SecurityProfile): boolean {
  if (!securityProfile) return true;
  return securityProfile.profile === 'local' && isLoopbackHost(securityProfile.host);
}

function isPairAuthBypassAllowed(securityProfile?: SecurityProfile): boolean {
  if (!securityProfile) return false;
  return securityProfile.profile === 'local' && isLoopbackHost(securityProfile.host);
}

export function recordRedeemAttempt(
  attemptsByIp: Map<string, RedeemAttemptEntry>,
  ip: string,
  nowMs: number,
): number {
  const staleBefore = nowMs - REDEEM_WINDOW_MS;
  const previous = attemptsByIp.get(ip);
  const freshAttempts = (previous?.attempts ?? []).filter((timestamp) => timestamp >= staleBefore);
  freshAttempts.push(nowMs);
  attemptsByIp.set(ip, {
    attempts: freshAttempts,
    updatedAt: nowMs,
  });

  if (attemptsByIp.size > REDEEM_ATTEMPT_IP_MAP_MAX) {
    for (const [candidateIp, entry] of attemptsByIp.entries()) {
      const newestAttempt = entry.attempts.at(-1);
      if (typeof newestAttempt !== 'number' || newestAttempt < staleBefore) {
        attemptsByIp.delete(candidateIp);
      }
    }
  }

  while (attemptsByIp.size > REDEEM_ATTEMPT_IP_MAP_MAX) {
    const oldest = attemptsByIp.entries().next();
    if (oldest.done) {
      break;
    }
    attemptsByIp.delete(oldest.value[0]);
  }

  return freshAttempts.length;
}

export function registerHttpRoutes(
  app: FastifyInstance,
  daemon: Daemon,
  registry?: AgentRegistry,
  options?: HttpServerOptions,
): void {
  const hookRouter = options?.hookRouter;
  const auth = options?.auth;
  const runtime = options?.runtime;
  const securityProfile = options?.securityProfile;
  const mustRequireAuth = !!auth || securityProfile?.requireAuth === true;
  const redeemAttemptTimestamps = new Map<string, RedeemAttemptEntry>();

  // Security/auth hook for protected routes.
  app.addHook('onRequest', async (request, reply) => {
    const rawUrl = request.url ?? '';
    const qIdx = rawUrl.indexOf('?');
    const url = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;

    if (securityProfile) {
      const hostAllowed = isHostAllowed(request.headers.host, securityProfile);
      const originHeader =
        typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      const originAllowed = isOriginAllowed(originHeader, securityProfile);
      if (!hostAllowed || !originAllowed) {
        return reply.status(403).send({ error: 'Host/origin not allowed by security profile' });
      }
    }

    if (url === '/health') return;
    if (!url.startsWith('/api/')) return;
    const isLifecycleUrl = url === '/api/lifecycle/shutdown' || url === '/api/lifecycle/restart';

    if (isLifecycleUrl) {
      if (!mustRequireAuth) {
        return;
      }
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const token = extractBearerToken(request.headers.authorization);
      if (!token || !(await auth.validate(token))) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      return;
    }

    if (url === '/api/hook' && isHookAuthBypassAllowed(securityProfile)) {
      return;
    }
    if (
      (url === '/api/pair/redeem' || url === '/api/pair/offer') &&
      isPairAuthBypassAllowed(securityProfile)
    ) {
      return;
    }

    if (!mustRequireAuth) {
      return;
    }

    if (!auth) {
      return reply.status(401).send({ error: 'Unauthorized: auth is required for this profile' });
    }

    const token = extractBearerToken(request.headers.authorization);
    if (!token || !(await auth.validate(token))) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  app.get('/health', async () => {
    const memory = process.memoryUsage();
    const relayEnabled = options?.runtime?.relayEnabled ?? false;
    const relayStatus = options?.getRelayStatus?.() ?? null;
    const machine = resolveDaemonRuntimeIdentity({
      daemonConfig: daemon.configManager.getDaemonConfig(),
      machineId: daemon.configManager.getMachineId(),
      daemonVersion: runtime?.version ?? 'unknown',
    });
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - (runtime?.startedAt ?? startTime)) / 1000),
      pid: process.pid,
      startedAt: runtime?.startedAt ?? startTime,
      now: Date.now(),
      host: runtime?.host ?? '127.0.0.1',
      port: runtime?.port ?? Number(process.env['PORT'] ?? 7070),
      listen: runtime?.listen ?? `${runtime?.host ?? '127.0.0.1'}:${runtime?.port ?? 7070}`,
      socketPath: runtime?.socketPath,
      sessions: daemon.getActiveSessions().length,
      directories: daemon.directoryManager.list().length,
      agents: daemon.getAvailableAgents().join(', ') || 'none',
      version: runtime?.version ?? '0.1.0',
      machine,
      process: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryRss: memory.rss,
        memoryHeapUsed: memory.heapUsed,
        memoryHeapTotal: memory.heapTotal,
      },
      relay:
        relayEnabled || relayStatus
          ? {
              enabled: relayEnabled || !!relayStatus,
              state: relayStatus?.state ?? (relayEnabled ? 'connecting' : 'stopped'),
              reconnectAttempt: relayStatus?.reconnectAttempt ?? 0,
              lastErrorCode: relayStatus?.lastErrorCode,
              lastErrorMessage: relayStatus?.lastErrorMessage,
              lastErrorAt: relayStatus?.lastErrorAt,
              circuitOpenUntil: relayStatus?.circuitOpenUntil,
            }
          : undefined,
    };
  });

  // ---------------------------------------------------------------------------
  // Directories
  // ---------------------------------------------------------------------------

  app.get('/api/directories', async () => daemon.directoryManager.list());

  // ---------------------------------------------------------------------------
  // Session/operator surfaces
  // ---------------------------------------------------------------------------

  app.get<{
    Querystring: {
      scope?: 'all' | 'active' | 'discovered';
      directoryId?: string;
      agent?: string;
    };
  }>('/api/sessions', async (request) => {
    const scope = request.query.scope ?? 'all';
    const directoryIdFilter =
      typeof request.query.directoryId === 'string' ? request.query.directoryId : undefined;
    const agentFilter =
      typeof request.query.agent === 'string' ? request.query.agent.trim() : undefined;

    const active = daemon
      .listActiveSessions()
      .map((session) => {
        const dir = daemon.directoryManager.get(session.directoryId);
        return {
          source: 'active' as const,
          id: session.sessionId,
          sessionId: session.sessionId,
          directoryId: session.directoryId,
          directoryPath: dir?.path ?? null,
          agentId: session.agent,
          state: session.state,
          mode: session.mode,
          resumable: true,
          lastActivity: null,
          summary: null,
          messageCount: null,
        };
      })
      .filter((session) => {
        if (directoryIdFilter && session.directoryId !== directoryIdFilter) return false;
        if (agentFilter && session.agentId !== agentFilter) return false;
        return true;
      });

    const discovered = [...daemon.getDiscoveredSessions().entries()]
      .flatMap(([directoryId, sessions]) =>
        sessions.map((session) => {
          const dir = daemon.directoryManager.get(directoryId);
          return {
            source: 'discovered' as const,
            id: session.sessionId,
            sessionId: session.sessionId,
            directoryId,
            directoryPath: dir?.path ?? null,
            agentId: session.agentId,
            state: 'idle',
            mode: 'detect',
            resumable: session.resumable,
            lastActivity: session.lastModified,
            summary: session.summary,
            messageCount: session.messageCount ?? null,
          };
        }),
      )
      .filter((session) => {
        if (directoryIdFilter && session.directoryId !== directoryIdFilter) return false;
        if (agentFilter && session.agentId !== agentFilter) return false;
        return true;
      });

    const sessions =
      scope === 'active'
        ? active
        : scope === 'discovered'
          ? discovered
          : [...active, ...discovered];

    sessions.sort((a, b) => {
      const aTime = a.lastActivity ?? 0;
      const bTime = b.lastActivity ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.sessionId.localeCompare(b.sessionId);
    });

    return {
      sessions,
      counts: {
        active: active.length,
        discovered: discovered.length,
        total: sessions.length,
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (request, reply) => {
    try {
      await daemon.killSession(request.params.id);
      return { ok: true, sessionId: request.params.id };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/mode', async (request, reply) => {
    try {
      const info = daemon.getSessionInfo(request.params.id);
      return {
        sessionId: request.params.id,
        mode: info.mode,
      };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.put<{
    Params: { id: string };
    Body: { mode?: 'detect' | 'bypass' };
  }>('/api/sessions/:id/mode', async (request, reply) => {
    const parsedBody = SessionModeBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }
    const { mode } = parsedBody.data;
    try {
      daemon.setSessionMode(request.params.id, mode);
      return {
        ok: true,
        sessionId: request.params.id,
        mode,
      };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.get<{ Querystring: { sessionId?: string } }>('/api/worktrees', async (request, reply) => {
    try {
      const worktrees = daemon.listWorktrees(request.query.sessionId);
      return {
        worktrees,
        count: worktrees.length,
      };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { toSha?: string };
  }>('/api/worktrees/:id/rollback', async (request, reply) => {
    const parsedBody = WorktreeRollbackBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }
    const { toSha } = parsedBody.data;
    try {
      await daemon.rollback(request.params.id, toSha);
      return { ok: true, sessionId: request.params.id, toSha };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { fromSha?: string };
  }>('/api/worktrees/:id/retry', async (request, reply) => {
    const parsedBody = WorktreeRetryBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }
    const { fromSha } = parsedBody.data;
    try {
      const retryPath = await daemon.branchRetry(request.params.id, fromSha);
      return { ok: true, sessionId: request.params.id, fromSha, retryPath };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { targetBranch?: string; commitMessage?: string };
  }>('/api/worktrees/:id/squash', async (request, reply) => {
    const parsedBody = WorktreeSquashBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }
    const targetBranch = parsedBody.data.targetBranch ?? 'main';
    const commitMessage =
      parsedBody.data.commitMessage ?? `chore: squash merge viewport session ${request.params.id}`;
    try {
      await daemon.squashMerge(request.params.id, targetBranch, commitMessage);
      return { ok: true, sessionId: request.params.id, targetBranch };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.get<{ Querystring: { sessionId?: string } }>('/api/permissions/pending', async (request) => {
    const sessionId = request.query.sessionId;
    const pending = daemon.listPendingPermissions(sessionId);
    return {
      pending,
      count: pending.length,
    };
  });

  app.post<{
    Body: {
      sessionId?: string;
      requestId?: string;
      behavior?: 'allow' | 'deny';
      message?: string;
      allowAlways?: boolean;
    };
  }>('/api/permissions/respond', async (request, reply) => {
    const parsedBody = PermissionRespondBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }
    const { sessionId, requestId, behavior, allowAlways, message } = parsedBody.data;

    try {
      if (behavior === 'allow' && allowAlways) {
        const toolName = daemon.getRequestToolName(requestId);
        if (toolName) {
          daemon.addAutoApprove(sessionId, toolName);
        }
      }

      await daemon.respondPermission(sessionId, requestId, {
        behavior,
        ...(behavior === 'deny' && message ? { message } : {}),
      });
      return {
        ok: true,
        sessionId,
        requestId,
        behavior,
        allowAlways: behavior === 'allow' ? allowAlways === true : false,
      };
    } catch {
      return reply.status(404).send({ error: 'Session or permission request not found' });
    }
  });

  app.post<{ Body: { path: string; config?: Record<string, unknown> } }>(
    '/api/directories',
    async (request, reply) => {
      const parsedBody = DirectoryRegisterBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
      }
      const { path: dirPath, config } = parsedBody.data;

      try {
        const info = await daemon.directoryManager.register(
          dirPath,
          config as Parameters<typeof daemon.directoryManager.register>[1],
        );
        daemon.emit('directory:registered', { directoryId: info.id, path: info.path });
        return reply.status(201).send(info);
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to register directory',
        });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/directories/:id', async (request, reply) => {
    const dir = daemon.directoryManager.get(request.params.id);
    if (!dir) {
      return reply.status(404).send({ error: 'Directory not found' });
    }

    await daemon.directoryManager.unregister(request.params.id);
    daemon.emit('directory:unregistered', { directoryId: request.params.id });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Session diffs
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/sessions/:id/diffs', async (request, reply) => {
    try {
      const diffs = await daemon.getSessionDiffs(request.params.id);
      return diffs;
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/summary-diff', async (request, reply) => {
    try {
      const diff = await daemon.getSessionSummaryDiff(request.params.id);
      return { diff };
    } catch {
      return reply.status(404).send({ error: 'Session not found' });
    }
  });

  // ---------------------------------------------------------------------------
  // Session messages (from JSONL files — discovered sessions)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { directoryId: string; sessionId: string } }>(
    '/api/directories/:directoryId/sessions/:sessionId/messages',
    async (request, reply) => {
      const dir = daemon.directoryManager.get(request.params.directoryId);
      if (!dir) {
        return reply.status(404).send({ error: 'Directory not found' });
      }

      const activeHistoryMeta = readPersistedReplayMeta(request.params.sessionId);
      if (activeHistoryMeta?.directoryId === request.params.directoryId) {
        return { messages: readPersistedSessionMessagesRich(request.params.sessionId) };
      }

      const discovered =
        daemon.getDiscoveredSessions(request.params.directoryId).get(request.params.directoryId) ??
        [];
      const discoveredSession = discovered.find((s) => s.sessionId === request.params.sessionId);
      if (!discoveredSession) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      try {
        if (discoveredSession.agentId === 'codex') {
          const messages = await readCodexSessionMessagesRich(
            request.params.sessionId,
            discoveredSession.sourcePath,
          );
          return { messages };
        }

        const projectDirName = encodeProjectDir(dir.path);
        const messages = await readSessionMessagesRich(projectDirName, request.params.sessionId);
        return { messages };
      } catch {
        return reply.status(404).send({ error: 'Session not found' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Models (from agent SDKs)
  // ---------------------------------------------------------------------------

  app.get('/api/models', async () => {
    if (!registry) return { models: [] };
    const models = await registry.fetchAllModels();
    return { models };
  });

  // ---------------------------------------------------------------------------
  // File access (read-only)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { directoryId: string; '*': string } }>(
    '/api/files/:directoryId/*',
    async (request, reply) => {
      const dir = daemon.directoryManager.get(request.params.directoryId);
      if (!dir) {
        return reply.status(404).send({ error: 'Directory not found' });
      }

      const relativePath = request.params['*'];
      if (!relativePath) {
        return reply.status(400).send({ error: 'File path required' });
      }

      const baseResolved = path.resolve(dir.path);
      const candidate = path.resolve(baseResolved, relativePath);
      if (!isPathWithin(baseResolved, candidate)) {
        return reply.status(403).send({ error: 'Path traversal not allowed' });
      }

      try {
        const [realBase, realTarget] = await Promise.all([
          fs.realpath(baseResolved).catch(() => baseResolved),
          fs.realpath(candidate),
        ]);
        if (!isPathWithin(realBase, realTarget)) {
          return reply.status(403).send({ error: 'Path traversal not allowed' });
        }
        const content = await fs.readFile(realTarget, 'utf-8');
        return reply.type('text/plain').send(content);
      } catch {
        return reply.status(404).send({ error: 'File not found' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Metrics / observability
  // ---------------------------------------------------------------------------

  app.get('/api/metrics', async () => {
    const snapshot = metrics.snapshot();

    // Add live gauges
    snapshot.gauges['sessions.active'] = daemon.getActiveSessions().length;
    snapshot.gauges['directories.registered'] = daemon.directoryManager.list().length;
    snapshot.gauges['uptime.seconds'] = Math.floor((Date.now() - startTime) / 1000);

    return snapshot;
  });

  // ---------------------------------------------------------------------------
  // Config (read-only — layered config for a directory)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { directoryId: string } }>(
    '/api/directories/:directoryId/config',
    async (request, reply) => {
      const dir = daemon.directoryManager.get(request.params.directoryId);
      if (!dir) {
        return reply.status(404).send({ error: 'Directory not found' });
      }
      const resolved = daemon.configManager.resolveSessionConfig(request.params.directoryId);
      return { directoryId: request.params.directoryId, config: resolved };
    },
  );

  // ---------------------------------------------------------------------------
  // Lifecycle control (used by supervisor / CLI)
  // ---------------------------------------------------------------------------

  app.post('/api/lifecycle/shutdown', async (_request, reply) => {
    if (!options?.onLifecycleShutdown) {
      return reply.status(404).send({ error: 'Lifecycle control unavailable' });
    }
    void options.onLifecycleShutdown();
    return { status: 'shutdown_requested' };
  });

  app.post('/api/lifecycle/restart', async (_request, reply) => {
    if (!options?.onLifecycleRestart) {
      return reply.status(404).send({ error: 'Lifecycle control unavailable' });
    }
    void options.onLifecycleRestart();
    return { status: 'restart_requested' };
  });

  // ---------------------------------------------------------------------------
  // Hook endpoint — receives events from agent CLI hooks (vpd hook notify)
  // ---------------------------------------------------------------------------

  app.post<{
    Body: {
      ttlSeconds?: number;
    };
  }>('/api/pair/offer', async (request, reply) => {
    const parsed = PairOfferBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      metrics.increment('pair.offer.invalid_payload');
      return reply.status(400).send({ error: invalidPayloadError(parsed.error) });
    }
    const ttlSeconds = parsed.data.ttlSeconds ?? 600;
    const host = runtime?.host ?? '127.0.0.1';
    const port = runtime?.port ?? Number(process.env['PORT'] ?? 7070);
    const listen = runtime?.listen ?? `${host}:${port}`;
    const profile = securityProfile?.profile ?? 'local';
    const issued = await issuePairingOffer({
      ttlSeconds,
      connection: {
        host,
        port,
        listen,
        socketPath: runtime?.socketPath,
        profile,
      },
    });
    metrics.increment('pair.offer.success');
    return {
      offerId: issued.offerId,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      redeemSecret: issued.redeemSecret,
      trustAnchor: issued.trustAnchor,
      daemonDeviceId: issued.daemonDeviceId,
      daemonPublicKey: issued.daemonPublicKey,
      host: issued.host,
      port: issued.port,
      listen: issued.listen,
      socketPath: issued.socketPath,
      profile: issued.profile,
    };
  });

  app.post<{
    Body: {
      offerId?: string;
      proof?: string;
      trustAnchor?: string;
      clientPublicKey?: string;
      clientProof?: string;
    };
  }>('/api/pair/redeem', async (request, reply) => {
    const ip = request.ip ?? 'unknown';
    const attemptCount = recordRedeemAttempt(redeemAttemptTimestamps, ip, Date.now());
    if (attemptCount > REDEEM_MAX_ATTEMPTS) {
      metrics.increment('pair.redeem.rate_limited');
      return reply.status(429).send({ error: 'Too many redeem attempts. Try again later.' });
    }

    const parsedBody = PairRedeemBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      metrics.increment('pair.redeem.invalid_payload');
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }
    const { offerId, proof, trustAnchor, clientPublicKey, clientProof } = parsedBody.data;

    const redeemed = await redeemPairingOffer(
      offerId,
      proof,
      trustAnchor,
      clientPublicKey,
      clientProof,
    );
    if (!redeemed) {
      metrics.increment('pair.redeem.failed');
      return reply.status(404).send({ error: 'Offer not found or no longer valid' });
    }
    metrics.increment('pair.redeem.success');

    return {
      offerId: redeemed.offerId,
      createdAt: redeemed.createdAt,
      expiresAt: redeemed.expiresAt,
      peerId: redeemed.peerId,
      daemonDeviceId: redeemed.daemonDeviceId,
      daemonPublicKey: redeemed.daemonPublicKey,
      relayPairingPeerId: redeemed.relayPairingPeerId,
      serverSignature: redeemed.serverSignature,
      host: redeemed.connection.host,
      port: redeemed.connection.port,
      listen: redeemed.connection.listen,
      socketPath: redeemed.connection.socketPath,
      profile: redeemed.connection.profile,
    };
  });

  if (hookRouter) {
    app.post<{ Body: Record<string, unknown> }>('/api/hook', async (request, reply) => {
      const parsed = HookBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid hook payload' });
      }
      const body = parsed.data;

      // Determine adapter from payload or default to 'claude'
      const adapter = typeof body.adapter === 'string' ? body.adapter : 'claude';

      const response = await hookRouter.handleEvent(body, adapter);
      return response;
    });
  }
}

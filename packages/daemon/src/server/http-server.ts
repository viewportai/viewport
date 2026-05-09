/**
 * HTTP server — REST endpoints for health, directories, diffs, files, and lifecycle control.
 *
 * Mounted on the same Fastify instance as the WebSocket server.
 */

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import type { HookRouter } from '../hooks/router.js';
import type { AuthProvider } from './auth.js';
import { extractBearerToken } from './auth.js';
import type { SecurityProfile } from './security.js';
import { isHostAllowed, isLoopbackHost, isOriginAllowed, isPathWithin } from './security.js';
import type { DaemonRelayBridgeStatus } from '../relay/daemon-relay-bridge.js';
import type { WorkflowInputValue } from '../workflows/types.js';
import { registerHealthRoutes } from './http-health-routes.js';
import { registerContextRoutes } from './http-context-routes.js';
import { registerLifecycleRoutes } from './http-lifecycle-routes.js';
import { registerPairingRoutes } from './http-pairing-routes.js';
import { registerSessionRoutes } from './http-session-routes.js';
import type { DaemonRuntimeInfo } from './http-route-types.js';
import {
  DirectoryRegisterBodySchema,
  HookBodySchema,
  WorkflowApprovalBodySchema,
  WorkflowCancelBodySchema,
  WorkflowRunBodySchema,
  WorkflowValidateBodySchema,
  invalidPayloadError,
} from './http-request-schemas.js';
import { parseSessionMessageLimit, readDaemonSessionMessages } from './session-message-reader.js';
import { ViewportError } from '../core/errors.js';

const startTime = Date.now();

export { recordRedeemAttempt } from './http-pairing-routes.js';

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

  registerHealthRoutes(app, daemon, {
    getRelayStatus: options?.getRelayStatus,
    runtime,
    startedAtFallback: startTime,
  });

  // ---------------------------------------------------------------------------
  // Directories
  // ---------------------------------------------------------------------------

  app.get('/api/directories', async () => daemon.directoryManager.list());

  // ---------------------------------------------------------------------------
  // Session/operator surfaces
  // ---------------------------------------------------------------------------

  registerSessionRoutes(app, daemon);
  registerContextRoutes(app);

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
  // Workflows
  // ---------------------------------------------------------------------------

  app.post<{ Body: { workflowPath?: string } }>(
    '/api/workflows/validate',
    async (request, reply) => {
      const parsedBody = WorkflowValidateBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
      }

      try {
        const workflow = parsedBody.data.workflowYaml
          ? daemon.workflowRunner.validateText(
              parsedBody.data.workflowYaml,
              parsedBody.data.workflowSourceRef,
            )
          : await daemon.workflowRunner.validateFile(parsedBody.data.workflowPath!);
        return {
          workflow: {
            name: workflow.definition.name,
            title: workflow.definition.title,
            description: workflow.definition.description,
            digest: workflow.digest,
            sourcePath: workflow.sourcePath,
            nodeCount: Object.keys(workflow.definition.nodes).length,
          },
        };
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : 'Workflow validation failed',
        });
      }
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/api/workflows/runs', async (request) => {
    const limit = Number.parseInt(request.query.limit ?? '50', 10);
    const runs = await daemon.workflowRunner.listRuns(Number.isFinite(limit) ? limit : 50);
    return { runs };
  });

  app.post<{
    Body: {
      workflowPath?: string;
      workflowYaml?: string;
      workflowSourceRef?: string;
      directoryId?: string;
      inputs?: Record<string, WorkflowInputValue>;
      resourceId?: string;
      runtimeTargetId?: string;
      executionPolicy?: {
        mode: 'current_tree' | 'isolated_worktree' | 'named_branch';
        branch?: string;
      };
      initiation?: 'cli' | 'browser' | 'agent_skill';
    };
  }>('/api/workflows/runs', async (request, reply) => {
    const parsedBody = WorkflowRunBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }

    try {
      const run = await daemon.workflowRunner.startRun({
        workflowPath: parsedBody.data.workflowPath,
        workflowYaml: parsedBody.data.workflowYaml,
        workflowSourceRef: parsedBody.data.workflowSourceRef,
        directoryId: parsedBody.data.directoryId,
        inputs: parsedBody.data.inputs,
        resourceId: parsedBody.data.resourceId,
        runtimeTargetId: parsedBody.data.runtimeTargetId,
        platformRunId: parsedBody.data.platformRunId,
        rerunOfWorkflowRunId: parsedBody.data.rerunOfWorkflowRunId,
        executionPolicy: parsedBody.data.executionPolicy,
        initiation: parsedBody.data.initiation ?? 'browser',
      });
      return reply.status(201).send({ run });
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Failed to start workflow run',
      });
    }
  });

  app.post<{ Params: { id: string } }>('/api/workflows/runs/:id/rerun', async (request, reply) => {
    try {
      const run = await daemon.workflowRunner.rerunRun(request.params.id);
      return reply.status(201).send({ run });
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Failed to rerun workflow',
      });
    }
  });

  app.get<{ Params: { id: string } }>('/api/workflows/runs/:id', async (request, reply) => {
    const run = await daemon.workflowRunner.getRun(request.params.id);
    if (!run) {
      return reply.status(404).send({ error: 'Workflow run not found' });
    }
    return { run };
  });

  app.post<{
    Params: { id: string; nodeId: string };
    Body: { approved?: boolean; message?: string };
  }>('/api/workflows/runs/:id/approvals/:nodeId', async (request, reply) => {
    const parsedBody = WorkflowApprovalBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }

    try {
      const run = await daemon.workflowRunner.decideApproval(
        request.params.id,
        request.params.nodeId,
        parsedBody.data,
      );
      return { run };
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Failed to resolve workflow approval',
      });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { message?: string; actor?: { name?: string; source?: string } };
  }>('/api/workflows/runs/:id/cancel', async (request, reply) => {
    const parsedBody = WorkflowCancelBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: invalidPayloadError(parsedBody.error) });
    }

    try {
      const run = await daemon.workflowRunner.cancelRun(request.params.id, parsedBody.data);
      return { run };
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Failed to cancel workflow run',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Session diffs
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/sessions/:id/diffs', async (request, reply) => {
    try {
      const diffs = await daemon.getSessionDiffs(request.params.id);
      return diffs;
    } catch (error) {
      if (error instanceof ViewportError) {
        return reply.status(error.statusCode).send({ error: error.message, errorCode: error.code });
      }
      return reply.status(500).send({ error: 'Failed to read session messages' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/summary-diff', async (request, reply) => {
    try {
      const diff = await daemon.getSessionSummaryDiff(request.params.id);
      return { diff };
    } catch (error) {
      if (error instanceof ViewportError) {
        return reply.status(error.statusCode).send({ error: error.message, errorCode: error.code });
      }
      return reply.status(500).send({ error: 'Failed to read session messages' });
    }
  });

  // ---------------------------------------------------------------------------
  // Session messages (from JSONL files — discovered sessions)
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { directoryId: string; sessionId: string };
    Querystring: { limit?: string | number };
  }>('/api/directories/:directoryId/sessions/:sessionId/messages', async (request, reply) => {
    try {
      const messages = await readDaemonSessionMessages(
        daemon,
        request.params.directoryId,
        request.params.sessionId,
        {
          limit:
            request.query.limit === undefined
              ? undefined
              : parseSessionMessageLimit(request.query.limit),
        },
      );
      return { messages };
    } catch (error) {
      if (error instanceof ViewportError) {
        return reply.status(error.statusCode).send({ error: error.message, errorCode: error.code });
      }
      return reply.status(500).send({ error: 'Failed to read session messages' });
    }
  });

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

  registerLifecycleRoutes(app, {
    onLifecycleRestart: options?.onLifecycleRestart,
    onLifecycleShutdown: options?.onLifecycleShutdown,
  });

  registerPairingRoutes(app, { runtime, securityProfile });

  // ---------------------------------------------------------------------------
  // Hook endpoint — receives events from agent CLI hooks (vpd hook notify)
  // ---------------------------------------------------------------------------

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

import type { FastifyInstance } from 'fastify';
import type { Daemon } from '../core/daemon.js';
import {
  PermissionRespondBodySchema,
  SessionModeBodySchema,
  WorktreeRetryBodySchema,
  WorktreeRollbackBodySchema,
  WorktreeSquashBodySchema,
  invalidPayloadError,
} from './http-request-schemas.js';
import { createGitMetadataResolver } from '../session-enrichment/git.js';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';

export function registerSessionRoutes(app: FastifyInstance, daemon: Daemon): void {
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
    const gitMetadataFor = createGitMetadataResolver();

    const active = daemon
      .listActiveSessions()
      .map((session) => {
        const dir = daemon.directoryManager.get(session.directoryId);
        const workingDirectory = dir?.path ?? null;
        const git = gitMetadataFor(workingDirectory);
        return {
          source: 'active' as const,
          id: session.sessionId,
          sessionId: session.sessionId,
          directoryId: session.directoryId,
          directoryPath: dir?.path ?? null,
          workingDirectory,
          repoRoot: git.repoRoot,
          repoRemoteUrl: git.repoRemoteUrl,
          repoBranch: git.repoBranch,
          repoSha: git.repoSha,
          resourceManifest: resolveSessionResourceManifestSync({
            workingDirectory: workingDirectory ?? process.cwd(),
          }),
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
          const workingDirectory = session.cwd ?? session.worktreePath ?? dir?.path ?? null;
          const git = gitMetadataFor(workingDirectory);
          return {
            source: 'discovered' as const,
            id: session.sessionId,
            sessionId: session.sessionId,
            directoryId,
            directoryPath: dir?.path ?? null,
            workingDirectory,
            repoRoot: git.repoRoot,
            repoRemoteUrl: git.repoRemoteUrl,
            repoBranch: git.repoBranch,
            repoSha: git.repoSha,
            resourceManifest: resolveSessionResourceManifestSync({
              workingDirectory: workingDirectory ?? process.cwd(),
            }),
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
}

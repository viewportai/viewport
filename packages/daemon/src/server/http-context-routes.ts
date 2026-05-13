import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addContextEntry,
  initContextResource,
  readContextStatus,
  resolveContextBundle,
} from '../context/local-edge-store.js';
import { proposeContextEntry } from '../context/local-edge-candidates.js';
import { pushContextEvents } from '../context/local-edge-sync.js';
import { resolveConfiguredContextSyncTarget } from '../cli/context-sync-target.js';
import { ConfigManager } from '../core/config.js';
import { previewContextCandidateForTrustedEdge } from './context-preview-service.js';

const CredentialsSchema = z.object({
  passphrase: z.string().min(1),
  recoveryCode: z.string().min(1),
});

const InitBodySchema = CredentialsSchema.extend({
  contextResourceId: z.string().min(1).optional(),
  userName: z.string().min(1),
  deviceName: z.string().min(1),
  keyStore: z.enum(['file', 'macos-keychain']).optional(),
});

const AddBodySchema = CredentialsSchema.extend({
  contextResourceId: z.string().min(1).optional(),
  actorName: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  source: z.string().optional(),
  scope: z.enum(['private', 'resource', 'team', 'organization']).optional(),
});

const ResolveBodySchema = z.object({
  contextResourceId: z.string().min(1).optional(),
  actorName: z.string().min(1),
  query: z.string().default(''),
  maxItems: z.number().int().min(1).max(500).optional(),
  includePrivate: z.boolean().optional(),
  profile: z.string().min(1).optional(),
  profilePin: z
    .object({
      path: z.string().min(1).optional(),
      digest: z.string().min(1).optional(),
    })
    .optional(),
  passphrase: z.string().optional(),
  recoveryCode: z.string().optional(),
});

const CandidatePreviewBodySchema = z.object({
  contextResourceId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  actorName: z.string().min(1),
  candidateEventId: z.string().min(1).optional(),
  payloadDigest: z.string().min(1).optional(),
  passphrase: z.string().optional(),
  recoveryCode: z.string().optional(),
});

const CandidateProposeBodySchema = z.object({
  contextResourceId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  actorName: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  source: z.string().optional(),
  sourceKind: z.enum(['workflow', 'plan', 'integration']).optional(),
  passphrase: z.string().optional(),
  recoveryCode: z.string().optional(),
  sync: z.boolean().optional(),
});

export function registerContextRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { context?: string } }>('/api/context/status', async (request) => {
    return readContextStatus({
      contextResourceId: request.query.context,
    });
  });

  app.post('/api/context/init', async (request, reply) => {
    const parsed = InitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const contextResourceId = contextResourceIdFrom(parsed.data);
    if (!contextResourceId) {
      return reply.status(400).send({ error: 'contextResourceId is required' });
    }
    const context = await initContextResource({
      contextResourceId,
      userName: parsed.data.userName,
      deviceName: parsed.data.deviceName,
      credentials: {
        passphrase: parsed.data.passphrase,
        recoveryCode: parsed.data.recoveryCode,
      },
      keyStore: parsed.data.keyStore,
    });
    return reply.status(201).send({ context });
  });

  app.post('/api/context/entries', async (request, reply) => {
    const parsed = AddBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const contextResourceId = contextResourceIdFrom(parsed.data);
    if (!contextResourceId) {
      return reply.status(400).send({ error: 'contextResourceId is required' });
    }
    const entry = await addContextEntry({
      contextResourceId,
      actorName: parsed.data.actorName,
      title: parsed.data.title,
      body: parsed.data.body,
      source: parsed.data.source,
      scope: parsed.data.scope,
      credentials: {
        passphrase: parsed.data.passphrase,
        recoveryCode: parsed.data.recoveryCode,
      },
    });
    return reply.status(201).send({ entry });
  });

  app.post('/api/context/resolve', async (request, reply) => {
    const parsed = ResolveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const contextResourceId = contextResourceIdFrom(parsed.data);
    if (!contextResourceId) {
      return reply.status(400).send({ error: 'contextResourceId is required' });
    }
    const bundle = await resolveContextBundle({
      contextResourceId,
      actorName: parsed.data.actorName,
      query: parsed.data.query,
      maxItems: parsed.data.maxItems,
      includePrivate: parsed.data.includePrivate,
      profile: parsed.data.profile,
      profilePin: parsed.data.profilePin,
      credentials: {
        passphrase: parsed.data.passphrase ?? '',
        recoveryCode: parsed.data.recoveryCode ?? '',
      },
    });
    return { bundle };
  });

  app.post('/api/context/candidates/preview', async (request, reply) => {
    const parsed = CandidatePreviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const contextResourceId = contextResourceIdFrom(parsed.data);
    if (!contextResourceId) {
      return reply.status(400).send({ error: 'contextResourceId is required' });
    }
    try {
      return await previewContextCandidateForTrustedEdge({
        contextResourceId,
        workspaceId: parsed.data.workspaceId,
        actorName: parsed.data.actorName,
        candidateEventId: parsed.data.candidateEventId,
        payloadDigest: parsed.data.payloadDigest,
        passphrase: parsed.data.passphrase,
        recoveryCode: parsed.data.recoveryCode,
      });
    } catch (error) {
      return reply
        .status(400)
        .send({ error: error instanceof Error ? error.message : 'Context preview failed' });
    }
  });

  app.post('/api/context/candidates', async (request, reply) => {
    const parsed = CandidateProposeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const contextResourceId = contextResourceIdFrom(parsed.data);
    if (!contextResourceId) {
      return reply.status(400).send({ error: 'contextResourceId is required' });
    }

    const candidate = await proposeContextEntry({
      contextResourceId,
      actorName: parsed.data.actorName,
      title: parsed.data.title,
      body: parsed.data.body,
      source: parsed.data.source ?? 'web://vault-detail',
      sourceKind: parsed.data.sourceKind ?? 'integration',
      credentials: {
        passphrase: parsed.data.passphrase ?? '',
        recoveryCode: parsed.data.recoveryCode ?? '',
      },
    });

    let sync:
      | { ok: true; accepted: number; pushed: number; repoId: string; workspaceId: string }
      | { ok: false; error: string }
      | null = null;
    if (parsed.data.sync !== false) {
      try {
        const target = await resolveSavedSyncTarget(contextResourceId, parsed.data.workspaceId);
        if (!target) {
          sync = {
            ok: false,
            error: parsed.data.workspaceId
              ? `No saved remote credentials are available for workspace ${parsed.data.workspaceId}.`
              : 'Context sync requires an explicit workspace when this daemon has multiple remote bindings.',
          };
        } else {
          const result = await pushContextEvents({
            contextResourceId,
            workspaceId: target.workspaceId,
            serverUrl: target.serverUrl,
            credential: target.credential,
            tlsVerify: target.tlsVerify,
            caCertPath: target.caCertPath,
            tlsPins: target.tlsPins,
          });
          sync = { ok: true, workspaceId: target.workspaceId, ...result };
        }
      } catch (error) {
        sync = {
          ok: false,
          error: error instanceof Error ? error.message : 'Context sync failed',
        };
      }
    }

    return reply.status(201).send({ candidate, sync });
  });
}

function contextResourceIdFrom(input: { contextResourceId?: string }): string | null {
  return input.contextResourceId ?? null;
}

async function resolveSavedSyncTarget(
  contextResourceId: string,
  workspaceId?: string,
): Promise<{
  workspaceId: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
} | null> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  return resolveConfiguredContextSyncTarget(daemon, {
    contextResourceId,
    requestedWorkspaceId: workspaceId,
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addContextEntry,
  initContextResource,
  readContextStatus,
  resolveContextBundle,
} from '../context/local-edge-store.js';

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

const ResolveBodySchema = CredentialsSchema.extend({
  contextResourceId: z.string().min(1).optional(),
  actorName: z.string().min(1),
  query: z.string().default(''),
  includePrivate: z.boolean().optional(),
  profile: z.string().min(1).optional(),
  profilePin: z
    .object({
      path: z.string().min(1).optional(),
      digest: z.string().min(1).optional(),
    })
    .optional(),
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
      includePrivate: parsed.data.includePrivate,
      profile: parsed.data.profile,
      profilePin: parsed.data.profilePin,
      credentials: {
        passphrase: parsed.data.passphrase,
        recoveryCode: parsed.data.recoveryCode,
      },
    });
    return { bundle };
  });
}

function contextResourceIdFrom(input: { contextResourceId?: string }): string | null {
  return input.contextResourceId ?? null;
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addContextEntry,
  initContextProject,
  readContextStatus,
  resolveContextBundle,
} from '../context/local-edge-store.js';

const CredentialsSchema = z.object({
  passphrase: z.string().min(1),
  recoveryCode: z.string().min(1),
});

const InitBodySchema = CredentialsSchema.extend({
  projectId: z.string().min(1),
  userName: z.string().min(1),
  deviceName: z.string().min(1),
});

const AddBodySchema = CredentialsSchema.extend({
  projectId: z.string().min(1),
  actorName: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  source: z.string().optional(),
  scope: z.enum(['private', 'project', 'team', 'organization']).optional(),
});

const ResolveBodySchema = CredentialsSchema.extend({
  projectId: z.string().min(1),
  actorName: z.string().min(1),
  query: z.string().default(''),
  includePrivate: z.boolean().optional(),
});

export function registerContextRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { project?: string } }>('/api/context/status', async (request) => {
    return readContextStatus({ projectId: request.query.project });
  });

  app.post('/api/context/init', async (request, reply) => {
    const parsed = InitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const project = await initContextProject({
      projectId: parsed.data.projectId,
      userName: parsed.data.userName,
      deviceName: parsed.data.deviceName,
      credentials: {
        passphrase: parsed.data.passphrase,
        recoveryCode: parsed.data.recoveryCode,
      },
    });
    return reply.status(201).send({ project });
  });

  app.post('/api/context/entries', async (request, reply) => {
    const parsed = AddBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    }
    const entry = await addContextEntry({
      projectId: parsed.data.projectId,
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
    const bundle = await resolveContextBundle({
      projectId: parsed.data.projectId,
      actorName: parsed.data.actorName,
      query: parsed.data.query,
      includePrivate: parsed.data.includePrivate,
      credentials: {
        passphrase: parsed.data.passphrase,
        recoveryCode: parsed.data.recoveryCode,
      },
    });
    return { bundle };
  });
}

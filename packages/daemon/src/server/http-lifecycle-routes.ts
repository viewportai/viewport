import type { FastifyInstance } from 'fastify';

export function registerLifecycleRoutes(
  app: FastifyInstance,
  options: {
    onLifecycleRestart?: () => Promise<void>;
    onLifecycleShutdown?: () => Promise<void>;
  },
): void {
  app.post('/api/lifecycle/shutdown', async (_request, reply) => {
    if (!options.onLifecycleShutdown) {
      return reply.status(404).send({ error: 'Lifecycle control unavailable' });
    }
    void options.onLifecycleShutdown();
    return { status: 'shutdown_requested' };
  });

  app.post('/api/lifecycle/restart', async (_request, reply) => {
    if (!options.onLifecycleRestart) {
      return reply.status(404).send({ error: 'Lifecycle control unavailable' });
    }
    void options.onLifecycleRestart();
    return { status: 'restart_requested' };
  });
}

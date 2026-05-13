import Fastify from 'fastify';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Daemon } from '../../src/core/daemon.js';
import { registerHttpRoutes } from '../../src/server/http-server.js';

describe('HTTP context routes', () => {
  let app: ReturnType<typeof Fastify>;
  let daemon: Daemon;
  let tempHome: string;
  let originalViewportHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-http-context-'));
    originalViewportHome = process.env['VIEWPORT_HOME'];
    process.env['VIEWPORT_HOME'] = tempHome;
    daemon = new Daemon();
    await daemon.initialize();
    app = Fastify();
    registerHttpRoutes(app, daemon);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalViewportHome === undefined) {
      delete process.env['VIEWPORT_HOME'];
    } else {
      process.env['VIEWPORT_HOME'] = originalViewportHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('initializes, adds, statuses, and resolves local context over HTTP', async () => {
    const init = await app.inject({
      method: 'POST',
      url: '/api/context/init',
      payload: credentials({
        contextResourceId: 'context-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        keyStore: 'file',
      }),
    });
    expect(init.statusCode).toBe(201);

    const add = await app.inject({
      method: 'POST',
      url: '/api/context/entries',
      payload: credentials({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Review standard',
        body: 'Every risky change needs regression proof.',
      }),
    });
    expect(add.statusCode).toBe(201);
    expect(JSON.parse(add.payload).entry).toMatchObject({
      scope: 'resource',
    });

    const raw = await readTree(tempHome);
    expect(raw).toContain('viewport.context_event/v1');
    expect(raw).not.toContain('Review standard');
    expect(raw).not.toContain('Every risky change');

    const status = await app.inject({
      method: 'GET',
      url: '/api/context/status?context=context-alpha',
    });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.payload).contexts[0]).toMatchObject({
      schemaVersion: 'viewport.context_event/v1',
      contextResourceId: 'context-alpha',
      entryCount: 1,
      serverSync: 'disabled',
      keyStore: 'file',
    });

    const resolved = await app.inject({
      method: 'POST',
      url: '/api/context/resolve',
      payload: credentials({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        query: 'regression',
      }),
    });
    expect(resolved.statusCode).toBe(200);
    const body = JSON.parse(resolved.payload);
    expect(body.bundle.manifest.serverSync).toBe('disabled');
    expect(body.bundle.manifest.schemaVersion).toBe('viewport.context_bundle_manifest/v1');
    expect(body.bundle.items[0]).toMatchObject({
      title: 'Review standard',
      body: 'Every risky change needs regression proof.',
    });

    const resolvedFromApprovedDevice = await app.inject({
      method: 'POST',
      url: '/api/context/resolve',
      payload: {
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        query: 'regression',
      },
    });
    expect(resolvedFromApprovedDevice.statusCode).toBe(200);
    expect(JSON.parse(resolvedFromApprovedDevice.payload).bundle.items[0]).toMatchObject({
      title: 'Review standard',
      body: 'Every risky change needs regression proof.',
    });

    const proposal = await app.inject({
      method: 'POST',
      url: '/api/context/candidates',
      payload: {
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Candidate standard',
        body: 'Retry flaky browser paths with trace proof before merge.',
        sync: false,
      },
    });
    expect(proposal.statusCode).toBe(201);
    expect(JSON.parse(proposal.payload)).toMatchObject({
      candidate: {
        trustState: 'candidate',
        actorName: 'alice-laptop',
      },
      sync: null,
    });
  });

  it('rejects context writes without a context resource id', async () => {
    const init = await app.inject({
      method: 'POST',
      url: '/api/context/init',
      payload: credentials({
        userName: 'alice',
        deviceName: 'alice-laptop',
      }),
    });

    expect(init.statusCode).toBe(400);
    expect(JSON.parse(init.payload)).toMatchObject({
      error: 'contextResourceId is required',
    });
  });

  it('syncs web-originated context candidates to the requested workspace binding', async () => {
    const received: Array<{ workspaceId: string; body: Record<string, unknown> }> = [];
    const controlPlane = Fastify();
    controlPlane.post<{ Params: { workspaceId: string } }>(
      '/api/runtime/workspaces/:workspaceId/context-vault/events/push',
      async (request, reply) => {
        received.push({
          workspaceId: request.params.workspaceId,
          body: request.body as Record<string, unknown>,
        });
        return reply.status(202).send({ ok: true, accepted: 1, events: [] });
      },
    );
    await controlPlane.listen({ host: '127.0.0.1', port: 0 });
    const address = controlPlane.server.address() as AddressInfo;
    const serverUrl = `http://127.0.0.1:${address.port}`;

    await fs.writeFile(
      path.join(tempHome, 'config.json'),
      JSON.stringify(
        {
          daemon: {
            relay: {
              workspaceId: 'org-personal',
              serverUrl,
              issueToken: 'token-personal',
              bindings: [
                {
                  workspaceId: 'org-personal',
                  serverUrl,
                  issueToken: 'token-personal',
                },
                {
                  workspaceId: 'org-new',
                  serverUrl,
                  issueToken: 'token-new',
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    try {
      await app.inject({
        method: 'POST',
        url: '/api/context/init',
        payload: credentials({
          contextResourceId: 'context-alpha',
          userName: 'alice',
          deviceName: 'alice-laptop',
          keyStore: 'file',
        }),
      });

      const proposal = await app.inject({
        method: 'POST',
        url: '/api/context/candidates',
        payload: {
          contextResourceId: 'context-alpha',
          workspaceId: 'org-new',
          actorName: 'alice-laptop',
          title: 'Candidate standard',
          body: 'Retry flaky browser paths with trace proof before merge.',
        },
      });

      expect(proposal.statusCode).toBe(201);
      expect(JSON.parse(proposal.payload).sync).toMatchObject({
        ok: true,
        workspaceId: 'org-new',
        accepted: 1,
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        workspaceId: 'org-new',
        body: {
          credential: 'token-new',
          target_workspace_id: 'org-new',
        },
      });
    } finally {
      await controlPlane.close();
    }
  });

  it('refuses context candidate sync instead of guessing when multiple workspaces are configured', async () => {
    await fs.writeFile(
      path.join(tempHome, 'config.json'),
      JSON.stringify(
        {
          daemon: {
            relay: {
              workspaceId: 'org-personal',
              serverUrl: 'http://127.0.0.1:9',
              issueToken: 'token-personal',
              bindings: [
                {
                  workspaceId: 'org-personal',
                  serverUrl: 'http://127.0.0.1:9',
                  issueToken: 'token-personal',
                },
                {
                  workspaceId: 'org-new',
                  serverUrl: 'http://127.0.0.1:9',
                  issueToken: 'token-new',
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    await app.inject({
      method: 'POST',
      url: '/api/context/init',
      payload: credentials({
        contextResourceId: 'context-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        keyStore: 'file',
      }),
    });

    const proposal = await app.inject({
      method: 'POST',
      url: '/api/context/candidates',
      payload: {
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Candidate standard',
        body: 'Retry flaky browser paths with trace proof before merge.',
      },
    });

    expect(proposal.statusCode).toBe(201);
    expect(JSON.parse(proposal.payload).sync).toMatchObject({
      ok: false,
      error:
        'Context sync requires an explicit workspace when this daemon has multiple remote bindings.',
    });
  });

  function credentials<T extends Record<string, unknown>>(
    payload: T,
  ): T & {
    passphrase: string;
    recoveryCode: string;
  } {
    return {
      ...payload,
      passphrase: 'alice-passphrase',
      recoveryCode: 'alice-recovery',
    };
  }

  async function readTree(dir: string): Promise<string> {
    let output = '';
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        output += await readTree(fullPath);
      } else {
        output += await fs.readFile(fullPath, 'utf8');
      }
    }
    return output;
  }
});

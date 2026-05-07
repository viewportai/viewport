import Fastify from 'fastify';
import fs from 'node:fs/promises';
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
        projectId: 'project-alpha',
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
        projectId: 'project-alpha',
        actorName: 'alice-laptop',
        title: 'Review standard',
        body: 'Every risky change needs regression proof.',
      }),
    });
    expect(add.statusCode).toBe(201);

    const raw = await readTree(tempHome);
    expect(raw).toContain('viewport.context_event/v1');
    expect(raw).not.toContain('Review standard');
    expect(raw).not.toContain('Every risky change');

    const status = await app.inject({
      method: 'GET',
      url: '/api/context/status?project=project-alpha',
    });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.payload).projects[0]).toMatchObject({
      schemaVersion: 'viewport.context_event/v1',
      projectId: 'project-alpha',
      entryCount: 1,
      serverSync: 'disabled',
      keyStore: 'file',
    });

    const resolved = await app.inject({
      method: 'POST',
      url: '/api/context/resolve',
      payload: credentials({
        projectId: 'project-alpha',
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

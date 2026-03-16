import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type WebSocket from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { registerWsServer } from '../../src/server/ws-server.js';
import type { SecurityProfile } from '../../src/server/security.js';

class BufferedWs {
  readonly ws: WebSocket;
  private readonly buffer: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<(msg: Record<string, unknown>) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        this.buffer.push(parsed);
      }
    });
  }

  waitForOpen(timeoutMs = 2000): Promise<void> {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for open')), timeoutMs);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  nextMessage(timeoutMs = 500): Promise<Record<string, unknown>> {
    const buffered = this.buffer.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  close(): void {
    this.ws.terminate();
  }
}

describe('WebSocket security', () => {
  let tempHome: string;
  let originalHome: string;
  let daemon: Daemon;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-ws-sec-test-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;

    daemon = new Daemon();
    await daemon.initialize();

    app = Fastify();
    await app.register(fastifyWebsocket);
  });

  afterEach(async () => {
    await daemon.shutdown();
    await app.close();
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  async function connect(
    pathname: string,
    upgradeContext?: Record<string, unknown>,
    options?: { waitForOpen?: boolean },
  ): Promise<BufferedWs> {
    let client: BufferedWs | null = null;
    const ws = (await app.injectWS(pathname, upgradeContext ?? {}, {
      onInit: (raw) => {
        client = new BufferedWs(raw as unknown as WebSocket);
      },
    })) as unknown as WebSocket;
    const resolved = client ?? new BufferedWs(ws);
    if (options?.waitForOpen !== false) {
      await resolved.waitForOpen();
    }
    return resolved;
  }

  it('rejects ws connection without token when auth is enabled', async () => {
    registerWsServer(app, daemon, undefined, {
      auth: {
        validate: async () => false,
        getDisplayToken: () => null,
      },
    });
    await app.ready();

    const client = await connect('/ws', {}, { waitForOpen: false });
    await expect(client.waitForOpen(300)).rejects.toThrow('Timeout waiting for open');
    client.close();
  });

  it('accepts ws token from query parameter', async () => {
    const profile: SecurityProfile = {
      profile: 'local',
      host: '127.0.0.1',
      allowedHosts: [],
      requireAuth: false,
    };
    registerWsServer(app, daemon, undefined, {
      auth: {
        validate: async (token: string) => token === 'good-token',
        getDisplayToken: () => null,
      },
      securityProfile: profile,
    });
    await app.ready();

    const client = await connect('/ws?token=good-token', {
      headers: {
        host: '127.0.0.1:7070',
      },
    });
    const hello = await client.nextMessage(1000);
    expect(hello.type).toBe('hello');
    client.close();
  });

  it('rejects query token for non-local profiles and accepts Authorization header', async () => {
    const profile: SecurityProfile = {
      profile: 'relay',
      host: '127.0.0.1',
      allowedHosts: true,
      requireAuth: true,
    };
    registerWsServer(app, daemon, undefined, {
      auth: {
        validate: async (token: string) => token === 'good-token',
        getDisplayToken: () => null,
      },
      securityProfile: profile,
    });
    await app.ready();

    const rejected = await connect(
      '/ws?token=good-token',
      {
        headers: {
          host: '127.0.0.1:7070',
        },
      },
      { waitForOpen: false },
    );
    await expect(rejected.waitForOpen(300)).rejects.toThrow('Timeout waiting for open');
    rejected.close();

    const accepted = await connect('/ws', {
      headers: {
        host: '127.0.0.1:7070',
        authorization: 'Bearer good-token',
      },
    });
    const hello = await accepted.nextMessage(1000);
    expect(hello.type).toBe('hello');
    accepted.close();
  });

  it('does not allow query token in non-local profiles even when override env is set', async () => {
    const previous = process.env['VIEWPORT_ALLOW_QUERY_TOKEN_NON_LOCAL'];
    process.env['VIEWPORT_ALLOW_QUERY_TOKEN_NON_LOCAL'] = '1';
    try {
      const profile: SecurityProfile = {
        profile: 'relay',
        host: '127.0.0.1',
        allowedHosts: true,
        requireAuth: true,
      };
      registerWsServer(app, daemon, undefined, {
        auth: {
          validate: async (token: string) => token === 'good-token',
          getDisplayToken: () => null,
        },
        securityProfile: profile,
      });
      await app.ready();

      const rejected = await connect(
        '/ws?token=good-token',
        {
          headers: {
            host: '127.0.0.1:7070',
          },
        },
        { waitForOpen: false },
      );
      await expect(rejected.waitForOpen(300)).rejects.toThrow('Timeout waiting for open');
      rejected.close();
    } finally {
      if (previous === undefined) {
        delete process.env['VIEWPORT_ALLOW_QUERY_TOKEN_NON_LOCAL'];
      } else {
        process.env['VIEWPORT_ALLOW_QUERY_TOKEN_NON_LOCAL'] = previous;
      }
    }
  });

  it('rejects disallowed host/origin by security profile before hello', async () => {
    const profile: SecurityProfile = {
      profile: 'local',
      host: '127.0.0.1',
      allowedHosts: [],
      requireAuth: false,
    };
    registerWsServer(app, daemon, undefined, { securityProfile: profile });
    await app.ready();

    const client = await connect(
      '/ws',
      {
        headers: {
          host: 'evil.test',
          origin: 'https://evil.test',
        },
      },
      { waitForOpen: false },
    );
    await expect(client.waitForOpen(300)).rejects.toThrow('Timeout waiting for open');
    client.close();
  });

  it('enforces max websocket clients when configured', async () => {
    registerWsServer(app, daemon, undefined, { maxClients: 1 });
    await app.ready();

    const clientA = await connect('/ws');
    const helloA = await clientA.nextMessage(1000);
    expect(helloA.type).toBe('hello');

    const clientB = await connect('/ws', {}, { waitForOpen: false });
    const opened = await clientB
      .waitForOpen(300)
      .then(() => true)
      .catch(() => false);
    if (opened) {
      await expect(clientB.nextMessage(300)).rejects.toThrow('Timeout waiting for message');
    }

    clientA.close();
    clientB.close();
  });
});

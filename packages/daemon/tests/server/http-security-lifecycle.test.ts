import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerHttpRoutes } from '../../src/server/http-server.js';
import { Daemon } from '../../src/core/daemon.js';
import type { SecurityProfile } from '../../src/server/security.js';
import {
  createPairingClientIdentity,
  createPairingRedeemProof,
  issuePairingOffer,
  rotateAuthToken,
} from '../../src/server/pairing-offers.js';

describe('HTTP security and lifecycle routes', () => {
  let tempHome: string;
  let originalHome: string;
  let testDir: string;
  let daemon: Daemon;
  let app: ReturnType<typeof Fastify> | null = null;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-http-sec-test-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-http-sec-project-'));
    daemon = new Daemon();
    await daemon.initialize();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    await daemon.shutdown();
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function setup(options?: Parameters<typeof registerHttpRoutes>[3]): Promise<void> {
    app = Fastify();
    registerHttpRoutes(app, daemon, undefined, options);
    await app.ready();
  }

  const lanProfile: SecurityProfile = {
    profile: 'lan',
    host: '0.0.0.0',
    allowedHosts: ['example.test'],
    requireAuth: true,
  };

  it('rejects protected API requests without auth when profile requires it', async () => {
    await setup({
      securityProfile: lanProfile,
      auth: {
        validate: async (token: string) => token === 'good-token',
        getDisplayToken: () => null,
      },
    });

    const res = await app!.inject({
      method: 'GET',
      url: '/api/directories',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows protected API requests with valid auth and allowed host/origin', async () => {
    await setup({
      securityProfile: lanProfile,
      auth: {
        validate: async (token: string) => token === 'good-token',
        getDisplayToken: () => null,
      },
    });

    const createRes = await app!.inject({
      method: 'POST',
      url: '/api/directories',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
        authorization: 'Bearer good-token',
      },
      payload: { path: testDir },
    });
    expect(createRes.statusCode).toBe(201);
  });

  it('rejects requests with disallowed host header', async () => {
    await setup({
      securityProfile: lanProfile,
      auth: {
        validate: async () => true,
        getDisplayToken: () => null,
      },
    });

    const res = await app!.inject({
      method: 'GET',
      url: '/health',
      headers: {
        host: 'evil.test',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reports relay bridge status in health payload when relay is enabled', async () => {
    await setup({
      runtime: {
        pid: process.pid,
        host: '127.0.0.1',
        port: 7070,
        startedAt: Date.now(),
        version: '0.3.0',
        relayEnabled: true,
      },
      getRelayStatus: () => ({
        state: 'waiting_retry',
        reconnectAttempt: 2,
        lastErrorCode: 'WEBSOCKET_ERROR',
        lastErrorMessage: 'relay disconnected',
        lastErrorAt: Date.now(),
      }),
    });

    const res = await app!.inject({
      method: 'GET',
      url: '/health',
      headers: {
        host: '127.0.0.1',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as {
      relay?: {
        enabled: boolean;
        state: string;
        reconnectAttempt: number;
        lastErrorCode: string;
      };
    };
    expect(body.relay).toMatchObject({
      enabled: true,
      state: 'waiting_retry',
      reconnectAttempt: 2,
      lastErrorCode: 'WEBSOCKET_ERROR',
    });
  });

  it('allows hook auth bypass in local loopback profile only', async () => {
    await setup({
      securityProfile: {
        profile: 'local',
        host: '127.0.0.1',
        allowedHosts: [],
        requireAuth: false,
      },
      hookRouter: {
        handleEvent: async () => ({ ok: true }),
      } as never,
    });

    const res = await app!.inject({
      method: 'POST',
      url: '/api/hook',
      headers: {
        host: '127.0.0.1',
      },
      payload: {
        hook_event_name: 'Notification',
        session_id: 'session-local',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not bypass hook auth in lan profile', async () => {
    await setup({
      securityProfile: lanProfile,
      auth: {
        validate: async () => false,
        getDisplayToken: () => null,
      },
      hookRouter: {
        handleEvent: async () => ({ ok: true }),
      } as never,
    });

    const res = await app!.inject({
      method: 'POST',
      url: '/api/hook',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
      },
      payload: {
        hook_event_name: 'Notification',
        session_id: 'session-lan',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows pair redeem auth bypass in local loopback profile only', async () => {
    await rotateAuthToken();
    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const clientIdentity = createPairingClientIdentity();
    const clientProof = createPairingRedeemProof({
      offerId: offer.offerId,
      redeemSecret: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientIdentity,
    });

    await setup({
      securityProfile: {
        profile: 'local',
        host: '127.0.0.1',
        allowedHosts: [],
        requireAuth: false,
      },
    });

    const res = await app!.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      headers: {
        host: '127.0.0.1',
      },
      payload: {
        offerId: offer.offerId,
        proof: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientPublicKey: clientProof.clientPublicKey,
        clientProof: clientProof.clientProof,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not bypass pair redeem auth in lan profile', async () => {
    await rotateAuthToken();
    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const clientIdentity = createPairingClientIdentity();
    const clientProof = createPairingRedeemProof({
      offerId: offer.offerId,
      redeemSecret: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientIdentity,
    });

    await setup({
      securityProfile: lanProfile,
      auth: {
        validate: async (token: string) => token === 'good-token',
        getDisplayToken: () => null,
      },
    });

    const unauthorized = await app!.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
      },
      payload: {
        offerId: offer.offerId,
        proof: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientPublicKey: clientProof.clientPublicKey,
        clientProof: clientProof.clientProof,
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app!.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
        authorization: 'Bearer good-token',
      },
      payload: {
        offerId: offer.offerId,
        proof: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientPublicKey: clientProof.clientPublicKey,
        clientProof: clientProof.clientProof,
      },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it('requires auth for lifecycle endpoints and invokes handlers when authorized', async () => {
    let shutdownCalled = 0;
    let restartCalled = 0;
    await setup({
      auth: {
        validate: async (token: string) => token === 'good-token',
        getDisplayToken: () => null,
      },
      onLifecycleShutdown: async () => {
        shutdownCalled += 1;
      },
      onLifecycleRestart: async () => {
        restartCalled += 1;
      },
    });

    const unauthorized = await app!.inject({
      method: 'POST',
      url: '/api/lifecycle/shutdown',
    });
    expect(unauthorized.statusCode).toBe(401);

    const shutdownRes = await app!.inject({
      method: 'POST',
      url: '/api/lifecycle/shutdown',
      headers: {
        authorization: 'Bearer good-token',
      },
    });
    expect(shutdownRes.statusCode).toBe(200);
    expect(JSON.parse(shutdownRes.payload).status).toBe('shutdown_requested');

    const restartRes = await app!.inject({
      method: 'POST',
      url: '/api/lifecycle/restart',
      headers: {
        authorization: 'Bearer good-token',
      },
    });
    expect(restartRes.statusCode).toBe(200);
    expect(JSON.parse(restartRes.payload).status).toBe('restart_requested');

    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownCalled).toBe(1);
    expect(restartCalled).toBe(1);
  });

  it('allows lifecycle endpoints without auth when the daemon is running in local no-auth mode', async () => {
    let restartCalled = 0;
    await setup({
      auth: undefined,
      securityProfile: {
        profile: 'local',
        host: '127.0.0.1',
        allowedHosts: ['127.0.0.1'],
        allowedOrigins: [],
        requireAuth: false,
      },
      onLifecycleRestart: async () => {
        restartCalled += 1;
      },
    });

    const restartRes = await app!.inject({
      method: 'POST',
      url: '/api/lifecycle/restart',
    });

    expect(restartRes.statusCode).toBe(200);
    expect(JSON.parse(restartRes.payload).status).toBe('restart_requested');

    await new Promise((resolve) => setImmediate(resolve));
    expect(restartCalled).toBe(1);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { recordRedeemAttempt, registerHttpRoutes } from '../../src/server/http-server.js';
import { Daemon } from '../../src/core/daemon.js';
import type { DiscoveredSession, SessionDiscovery } from '../../src/core/interfaces.js';
import { RingBuffer } from '../../src/server/ring-buffer.js';
import {
  createPairingClientIdentity,
  createPairingRedeemProof,
  issuePairingOffer,
  rotateAuthToken,
} from '../../src/server/pairing-offers.js';

describe('HTTP Server', () => {
  let tempHome: string;
  let originalHome: string;
  let testDir: string;
  let daemon: Daemon;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-http-test-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;

    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-project-'));
    await fs.writeFile(path.join(testDir, 'hello.ts'), 'console.log("hello");\n');

    daemon = new Daemon();
    await daemon.initialize();

    app = Fastify();
    registerHttpRoutes(app, daemon);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  it('GET /health returns status', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
    expect(typeof body.uptime).toBe('number');
    expect(body.sessions).toBe(0);
    expect(body.pid).toBe(process.pid);
    expect(body.process?.node).toBeTypeOf('string');
    expect(body.process?.memoryRss).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Directories
  // ---------------------------------------------------------------------------

  it('GET /api/directories returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/directories' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual([]);
  });

  it('GET /api/sessions returns active and discovered sessions', async () => {
    const now = Date.now();
    (daemon as unknown as { listActiveSessions: () => unknown[] }).listActiveSessions = () => [
      {
        sessionId: 'active-1',
        directoryId: 'dir-1',
        agent: 'claude',
        state: 'running',
        mode: 'detect',
      },
    ];
    (
      daemon as unknown as { getDiscoveredSessions: () => Map<string, unknown[]> }
    ).getDiscoveredSessions = () =>
      new Map([
        [
          'dir-1',
          [
            {
              sessionId: 'disc-1',
              agentId: 'codex',
              summary: 'hello',
              lastModified: now,
              resumable: true,
              messageCount: 3,
            },
          ],
        ],
      ]);
    (
      daemon as unknown as { directoryManager: { get: (id: string) => { path: string } } }
    ).directoryManager.get = () => ({ path: testDir });

    const res = await app.inject({ method: 'GET', url: '/api/sessions?scope=all' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { sessions: Array<{ source: string }> };
    expect(body.sessions.some((session) => session.source === 'active')).toBe(true);
    expect(body.sessions.some((session) => session.source === 'discovered')).toBe(true);
  });

  it('POST /api/directories registers a directory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: { path: testDir },
    });
    expect(res.statusCode).toBe(201);

    const body = JSON.parse(res.payload);
    expect(body.id).toBeTruthy();
    expect(body.path).toBe(path.resolve(testDir));

    // Verify it appears in the list
    const listRes = await app.inject({ method: 'GET', url: '/api/directories' });
    expect(JSON.parse(listRes.payload)).toHaveLength(1);
  });

  it('POST /api/directories rejects missing path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/directories rejects nonexistent path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: { path: '/nonexistent/path' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/directories/:id unregisters', async () => {
    // Register first
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: { path: testDir },
    });
    const { id } = JSON.parse(createRes.payload);

    // Delete
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/directories/${id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    // Verify gone
    const listRes = await app.inject({ method: 'GET', url: '/api/directories' });
    expect(JSON.parse(listRes.payload)).toHaveLength(0);
  });

  it('DELETE /api/directories/:id returns 404 for unknown', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/directories/unknown',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/directories/:directoryId/sessions/:sessionId/messages returns journal-backed active history', async () => {
    const directory = await daemon.directoryManager.register(testDir);
    const buffer = new RingBuffer({ sessionId: 'active-history-session' });
    buffer.setDirectoryId(directory.id);
    buffer.push('active-history-session', {
      updateType: 'user-message',
      messageId: 'active-user-1',
      text: 'offline prompt',
      timestamp: Date.now(),
    });
    buffer.push('active-history-session', {
      updateType: 'agent-message',
      messageId: 'active-agent-1',
      text: 'offline reply',
      timestamp: Date.now(),
    });
    await buffer.flushPersistence();

    const res = await app.inject({
      method: 'GET',
      url: `/api/directories/${directory.id}/sessions/active-history-session/messages`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as {
      messages: Array<{ kind: string; text?: string }>;
    };
    expect(body.messages.map((message) => message.text).filter(Boolean)).toEqual([
      'offline prompt',
      'offline reply',
    ]);
  });

  it('POST /api/sessions/:id/stop stops active session', async () => {
    (daemon as unknown as { killSession: (id: string) => Promise<void> }).killSession = vi
      .fn()
      .mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/sess-1/stop',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
  });

  it('POST /api/pair/redeem redeems a short-lived offer', async () => {
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

    const res = await app.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      payload: {
        offerId: offer.offerId,
        proof: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientPublicKey: clientProof.clientPublicKey,
        clientProof: clientProof.clientProof,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as {
      offerId?: string;
      daemonDeviceId?: string;
      daemonPublicKey?: string;
      peerId?: string;
      serverSignature?: string;
      relayPairingSecret?: string;
    };
    expect(body.offerId).toBe(offer.offerId);
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('trustAnchor');
    expect(body.relayPairingSecret).toBeUndefined();
    expect(body.daemonDeviceId).toBe(offer.daemonDeviceId);
    expect(body.daemonPublicKey).toBe(offer.daemonPublicKey);
    expect(body.peerId).toBe(clientIdentity.peerId);
    expect(body.serverSignature).toBeTruthy();
  });

  it('POST /api/pair/redeem requires offerId, proof, and trustAnchor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      payload: { offerId: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/pair/redeem rate limiting ignores spoofed x-forwarded-for', async () => {
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

    let finalStatus = 0;
    for (let i = 0; i < 13; i += 1) {
      const wrongProof = createPairingRedeemProof({
        offerId: offer.offerId,
        redeemSecret: `wrong-proof-${i}`,
        trustAnchor: offer.trustAnchor,
        clientIdentity,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/pair/redeem',
        headers: {
          'x-forwarded-for': `203.0.113.${i + 1}`,
        },
        payload: {
          offerId: offer.offerId,
          proof: `wrong-proof-${i}`,
          trustAnchor: offer.trustAnchor,
          clientPublicKey: wrongProof.clientPublicKey,
          clientProof: wrongProof.clientProof,
        },
      });
      finalStatus = res.statusCode;
    }

    expect(finalStatus).toBe(429);
  });

  it('POST /api/hook validates payload shape when hook router is enabled', async () => {
    const localApp = Fastify();
    const hookRouter = {
      handleEvent: vi.fn().mockResolvedValue({ allowFallback: false }),
    };
    registerHttpRoutes(localApp, daemon, undefined, { hookRouter: hookRouter as never });
    await localApp.ready();

    try {
      const invalid = await localApp.inject({
        method: 'POST',
        url: '/api/hook',
        payload: { adapter: 'claude' },
      });
      expect(invalid.statusCode).toBe(400);

      const valid = await localApp.inject({
        method: 'POST',
        url: '/api/hook',
        payload: {
          adapter: 'claude',
          hook_event_name: 'SessionStart',
          session_id: 'session-1',
        },
      });
      expect(valid.statusCode).toBe(200);
      expect(hookRouter.handleEvent).toHaveBeenCalledTimes(1);
    } finally {
      await localApp.close();
    }
  });

  it('recordRedeemAttempt prunes stale entries and caps tracked IP cardinality', () => {
    const attempts = new Map<
      string,
      {
        attempts: number[];
        updatedAt: number;
      }
    >();
    const now = Date.now();
    for (let i = 0; i < 2_300; i += 1) {
      const ip = `198.51.100.${i}`;
      recordRedeemAttempt(attempts, ip, now - 120_000);
    }
    expect(attempts.size).toBe(2_048);

    const recentCount = recordRedeemAttempt(attempts, '203.0.113.10', now);
    expect(recentCount).toBe(1);
    expect(attempts.size).toBeLessThanOrEqual(2_048);
  });

  it('GET /api/sessions/:id/mode returns current session mode', async () => {
    (daemon as unknown as { getSessionInfo: (id: string) => { mode: string } }).getSessionInfo =
      () => ({
        mode: 'bypass',
      });

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-1/mode',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('bypass');
  });

  it('GET /api/worktrees lists active session worktrees', async () => {
    (daemon as unknown as { listWorktrees: () => unknown[] }).listWorktrees = () => [
      {
        sessionId: 'sess-1',
        directoryId: 'dir-1',
        agent: 'claude',
        state: 'running',
        mode: 'detect',
        worktreePath: '/tmp/worktree',
        stepCount: 4,
        lastStepSha: 'abc123',
        lastStepAt: Date.now(),
      },
    ];

    const res = await app.inject({ method: 'GET', url: '/api/worktrees' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { count: number; worktrees: unknown[] };
    expect(body.count).toBe(1);
    expect(body.worktrees).toHaveLength(1);
  });

  it('POST /api/worktrees/:id/retry returns retry path', async () => {
    (
      daemon as unknown as { branchRetry: (id: string, sha: string) => Promise<string> }
    ).branchRetry = vi.fn().mockResolvedValue('/tmp/retry');

    const res = await app.inject({
      method: 'POST',
      url: '/api/worktrees/sess-1/retry',
      payload: { fromSha: 'abc123' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { retryPath?: string };
    expect(body.retryPath).toBe('/tmp/retry');
  });

  it('PUT /api/sessions/:id/mode validates invalid mode', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sessions/sess-1/mode',
      payload: { mode: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/sessions/:id/mode rejects extra payload fields', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sessions/sess-1/mode',
      payload: { mode: 'detect', unexpected: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/permissions/pending returns pending requests', async () => {
    (daemon as unknown as { listPendingPermissions: () => unknown[] }).listPendingPermissions =
      () => [
        {
          sessionId: 'sess-1',
          requestId: 'perm-1',
          toolName: 'Bash',
        },
      ];
    const res = await app.inject({ method: 'GET', url: '/api/permissions/pending' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { count: number };
    expect(body.count).toBe(1);
  });

  it('POST /api/worktrees/:id/rollback rejects non-string toSha', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/worktrees/sess-1/rollback',
      payload: { toSha: 1234 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/permissions/respond rejects invalid payload types', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/permissions/respond',
      payload: {
        sessionId: 'sess-1',
        requestId: 'req-1',
        behavior: 'allow',
        allowAlways: 'yes',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/directories rejects unknown body fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: { path: testDir, unknown: true },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Session diffs
  // ---------------------------------------------------------------------------

  it('GET /api/sessions/:id/diffs returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/diffs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/sessions/:id/summary-diff returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/summary-diff',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/directories/:directoryId/sessions/:sessionId/messages supports codex discovered sessions', async () => {
    const codexRoot = path.join(tempHome, '.codex', 'sessions', '2026', '03', '02');
    await fs.mkdir(codexRoot, { recursive: true });
    const codexFilePath = path.join(codexRoot, 'rollout-codex-1.jsonl');
    await fs.writeFile(
      codexFilePath,
      [
        JSON.stringify({
          timestamp: '2026-03-02T17:07:37.196Z',
          type: 'session_meta',
          payload: {
            id: 'codex-session-1',
            cwd: testDir,
            timestamp: '2026-03-02T17:06:51.086Z',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-02T17:07:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello codex' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-02T17:07:38.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello user' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const dir = await daemon.directoryManager.register(testDir);
    const codexDiscovery: SessionDiscovery = {
      agentId: 'codex',
      discoverSessions: async (projectPath: string): Promise<DiscoveredSession[]> => {
        if (path.resolve(projectPath) !== path.resolve(testDir)) return [];
        return [
          {
            agentId: 'codex',
            sessionId: 'codex-session-1',
            summary: 'hello codex',
            lastModified: Date.now(),
            cwd: testDir,
            resumable: true,
            sourcePath: codexFilePath,
          },
        ];
      },
    };
    daemon.registerDiscovery(codexDiscovery);
    await daemon.runDiscovery();

    const res = await app.inject({
      method: 'GET',
      url: `/api/directories/${dir.id}/sessions/codex-session-1/messages`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { messages: Array<{ kind: string; text?: string }> };
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.some((msg) => msg.kind === 'text' && msg.text === 'hello codex')).toBe(
      true,
    );
    expect(body.messages.some((msg) => msg.kind === 'text' && msg.text === 'hello user')).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // File access
  // ---------------------------------------------------------------------------

  it('GET /api/files/:directoryId/* reads a file', async () => {
    // Register directory
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: { path: testDir },
    });
    const { id } = JSON.parse(createRes.payload);

    // Read file
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${id}/hello.ts`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('console.log');
  });

  it('GET /api/files/:directoryId/* returns 404 for unknown directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/files/unknown/file.ts',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/files/:directoryId/* returns 404 for missing file', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: { path: testDir },
    });
    const { id } = JSON.parse(createRes.payload);

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${id}/nonexistent.ts`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/files/:directoryId/* returns 404 for path traversal attempts', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/directories',
      payload: { path: testDir },
    });
    const { id } = JSON.parse(createRes.payload);

    // Fastify normalizes ../  out of URLs before they reach the handler,
    // so path traversal resolves to a nonexistent file → 404
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${id}/../../../etc/passwd`,
    });
    expect(res.statusCode).toBe(404);
  });
});

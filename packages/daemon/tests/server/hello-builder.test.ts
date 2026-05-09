import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  buildSnapshotPayload,
  sendHello,
  sendSyncSnapshot,
} from '../../src/server/hello-builder.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';
import { Daemon } from '../../src/core/daemon.js';

describe('daemon snapshot builder', () => {
  let tempHome: string;
  let originalHome: string;
  let daemon: Daemon;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-test-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;
    daemon = new Daemon();
    await daemon.initialize();
  });

  afterAll(async () => {
    await daemon.shutdown();
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  function createMockClient(): { client: ConnectedClient; messages: string[] } {
    const messages: string[] = [];
    const client: ConnectedClient = {
      send: (data: string) => messages.push(data),
      subscriptions: new Set(),
      watchedDiscoveredSessions: new Set(),
      pendingBytes: 0,
    };
    return { client, messages };
  }

  it('builds a snapshot payload with required fields', () => {
    const payload = buildSnapshotPayload(daemon);

    expect(payload.protocolVersion).toBe(2);
    expect(payload.machine).toBeDefined();
    expect(payload.directories).toEqual([]);
    expect(payload.activeSessions).toEqual([]);
    expect(payload.discoveredSessions).toEqual([]);
    expect(payload.discoveredSessionsTruncated).toBe(false);
    expect(payload.availableAgents).toEqual([]);
  });

  it('includes directories when registered', async () => {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-dir-'));
    await daemon.directoryManager.register(testDir);

    const { client, messages } = createMockClient();
    sendHello(client, daemon);

    const msg = JSON.parse(messages[0]!);
    expect(msg.directories.length).toBeGreaterThan(0);
    expect(msg.directories[0].path).toBe(testDir);

    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('sends hello without registry (fallback agent info)', () => {
    const { client, messages } = createMockClient();
    sendHello(client, daemon, undefined);

    const msg = JSON.parse(messages[0]!);
    expect(msg.type).toBe('hello');
    expect(msg.agents).toEqual([]);
    expect(msg.models).toEqual([]);
  });

  it('sends hello with registry (rich agent info)', () => {
    // Create a mock registry
    const mockRegistry = {
      toHelloPayload: () => [{ id: 'claude', displayName: 'Claude', tier: 'sdk', available: true }],
      getCachedModels: () => [{ id: 'claude-sonnet-4-20250514', displayName: 'Sonnet 4' }],
    };

    const { client, messages } = createMockClient();
    sendHello(client, daemon, mockRegistry as any);

    const msg = JSON.parse(messages[0]!);
    expect(msg.type).toBe('hello');
    expect(msg.agents).toHaveLength(1);
    expect(msg.agents[0].id).toBe('claude');
    expect(msg.models).toHaveLength(1);
    expect(msg.models[0].displayName).toBe('Sonnet 4');
  });

  it('dedupes discovered sessions with the same id within a directory', async () => {
    const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-dedupe-home-'));
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-dedupe-dir-'));
    const previousHome = process.env['HOME']!;
    process.env['HOME'] = isolatedHome;

    const isolatedDaemon = new Daemon();
    await isolatedDaemon.initialize();

    try {
      const directory = await isolatedDaemon.directoryManager.register(isolatedDir);
      const now = Date.now();
      isolatedDaemon.registerDiscovery({
        agentId: 'dup-test',
        discoverSessions: async () => [
          {
            agentId: 'dup-test',
            sessionId: 'sess-1',
            summary: '',
            lastModified: now - 1_000,
            messageCount: 0,
            resumable: true,
          },
          {
            agentId: 'dup-test',
            sessionId: 'sess-1',
            summary: 'what agent are you',
            lastModified: now,
            messageCount: 3,
            resumable: true,
          },
        ],
      });
      await isolatedDaemon.runDiscovery();

      const { client, messages } = createMockClient();
      sendHello(client, isolatedDaemon);

      const msg = JSON.parse(messages[0]!);
      const sameSession = msg.discoveredSessions.filter(
        (entry: { directoryId: string; id: string }) =>
          entry.directoryId === directory.id && entry.id === 'sess-1',
      );

      expect(sameSession).toHaveLength(1);
      expect(sameSession[0]).toMatchObject({
        summary: 'what agent are you',
        messageCount: 3,
        lastActivity: now,
      });
    } finally {
      await isolatedDaemon.shutdown();
      process.env['HOME'] = previousHome;
      await fs.rm(isolatedDir, { recursive: true, force: true });
      await fs.rm(isolatedHome, { recursive: true, force: true });
    }
  });

  it('keeps discovered sessions unbound while exposing repo-local resource manifests', async () => {
    const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-binding-home-'));
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-binding-dir-'));
    const previousHome = process.env['HOME']!;
    process.env['HOME'] = isolatedHome;

    const isolatedDaemon = new Daemon();
    await isolatedDaemon.initialize();

    try {
      const directory = await isolatedDaemon.directoryManager.register(isolatedDir);
      await fs.mkdir(path.join(isolatedDir, '.viewport'), { recursive: true });
      await fs.writeFile(
        path.join(isolatedDir, '.viewport', 'config.json'),
        JSON.stringify({
          version: 1,
          resources: { contexts: ['ctx-auth'], workflows: ['wf-review'] },
        }),
      );
      isolatedDaemon.registerDiscovery({
        agentId: 'binding-test',
        discoverSessions: async () => [
          {
            agentId: 'binding-test',
            sessionId: 'sess-claimed',
            summary: 'claimed work',
            lastModified: Date.now(),
            messageCount: 1,
            resumable: true,
            cwd: isolatedDir,
          },
        ],
      });
      await isolatedDaemon.runDiscovery();

      const payload = buildSnapshotPayload(isolatedDaemon);
      const session = payload.discoveredSessions.find((entry) => entry.id === 'sess-claimed');

      expect(session).toMatchObject({
        directoryId: directory.id,
        workingDirectory: isolatedDir,
        resourceManifest: expect.objectContaining({
          schema: 'viewport.session_resource_manifest/v1',
          resources: expect.objectContaining({
            contexts: [expect.objectContaining({ id: 'ctx-auth' })],
            workflows: [expect.objectContaining({ id: 'wf-review' })],
          }),
        }),
      });
      expect(session).not.toHaveProperty('projectId');
      expect(session).not.toHaveProperty('projectBindingSource');
    } finally {
      await isolatedDaemon.shutdown();
      process.env['HOME'] = previousHome;
      await fs.rm(isolatedDir, { recursive: true, force: true });
      await fs.rm(isolatedHome, { recursive: true, force: true });
    }
  });

  it('only announces recent discovered sessions in bootstrap snapshots', async () => {
    const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-recent-home-'));
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hello-recent-dir-'));
    const previousHome = process.env['HOME']!;
    process.env['HOME'] = isolatedHome;

    const isolatedDaemon = new Daemon();
    await isolatedDaemon.initialize();

    try {
      const directory = await isolatedDaemon.directoryManager.register(isolatedDir);
      isolatedDaemon.registerDiscovery({
        agentId: 'recent-window-test',
        discoverSessions: async () => [
          {
            agentId: 'recent-window-test',
            sessionId: 'recent-session',
            summary: 'recent work',
            lastModified: Date.now() - 60_000,
            messageCount: 2,
            resumable: true,
          },
          {
            agentId: 'recent-window-test',
            sessionId: 'older-session',
            summary: 'older local history',
            lastModified: Date.now() - 25 * 60 * 60 * 1000,
            messageCount: 8,
            resumable: true,
          },
        ],
      });
      await isolatedDaemon.runDiscovery();

      const payload = buildSnapshotPayload(isolatedDaemon);

      expect(payload.discoveredSessions).toEqual([
        expect.objectContaining({ id: 'recent-session', directoryId: directory.id }),
      ]);
      expect(isolatedDaemon.getDiscoveredSessions(directory.id).get(directory.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionId: 'older-session' })]),
      );
    } finally {
      await isolatedDaemon.shutdown();
      process.env['HOME'] = previousHome;
      await fs.rm(isolatedDir, { recursive: true, force: true });
      await fs.rm(isolatedHome, { recursive: true, force: true });
    }
  });

  it('sends a fresh sync snapshot with required fields', () => {
    const { client, messages } = createMockClient();
    const expected = buildSnapshotPayload(daemon);
    sendSyncSnapshot(client, daemon);

    expect(messages).toHaveLength(1);
    const msg = JSON.parse(messages[0]!);
    expect(msg.type).toBe('sync-snapshot');
    expect(msg.protocolVersion).toBe(2);
    expect(msg.machine).toBeDefined();
    expect(msg.directories).toEqual(expected.directories);
    expect(msg.activeSessions).toEqual(expected.activeSessions);
    expect(msg.discoveredSessions).toEqual(expected.discoveredSessions);
    expect(msg.discoveredSessionsTruncated).toBe(expected.discoveredSessionsTruncated);
    expect(msg.availableAgents).toEqual(expected.availableAgents);
  });
});

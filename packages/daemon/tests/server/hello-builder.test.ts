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
      isolatedDaemon.registerDiscovery({
        agentId: 'dup-test',
        discoverSessions: async () => [
          {
            agentId: 'dup-test',
            sessionId: 'sess-1',
            summary: '',
            lastModified: 100,
            messageCount: 0,
            resumable: true,
          },
          {
            agentId: 'dup-test',
            sessionId: 'sess-1',
            summary: 'what agent are you',
            lastModified: 200,
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
        lastActivity: 200,
      });
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisRelayBackplane } from '../src/redis-backplane.js';
import { loadConfig } from '../src/config.js';
import { RelayLogger } from '../src/logger.js';
import { RelayMetrics } from '../src/metrics.js';

type PresenceRecord = { value: string; expiresAt: number | null };

const presenceStore = new Map<string, PresenceRecord>();
const queueStore = new Map<string, string[]>();

function trimExpiredPresence(): void {
  const now = Date.now();
  for (const [key, entry] of presenceStore.entries()) {
    if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) {
      presenceStore.delete(key);
    }
  }
}

function fakeRedisClient() {
  return {
    isOpen: false,
    on: vi.fn(),
    connect: vi.fn(async function connect(this: { isOpen: boolean }) {
      this.isOpen = true;
    }),
    quit: vi.fn(async function quit(this: { isOpen: boolean }) {
      this.isOpen = false;
      return 'OK';
    }),
    get: vi.fn(async (key: string) => {
      trimExpiredPresence();
      return presenceStore.get(key)?.value ?? null;
    }),
    set: vi.fn(async (key: string, value: string, options?: { PX?: number }) => {
      presenceStore.set(key, {
        value,
        expiresAt:
          typeof options?.PX === 'number' && options.PX > 0 ? Date.now() + options.PX : null,
      });
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      return presenceStore.delete(key) ? 1 : 0;
    }),
    rPush: vi.fn(async (key: string, value: string) => {
      const queue = queueStore.get(key) ?? [];
      queue.push(value);
      queueStore.set(key, queue);
      return queue.length;
    }),
    lTrim: vi.fn(async (key: string, start: number, stop: number) => {
      const queue = queueStore.get(key) ?? [];
      const normalizedStart = start < 0 ? Math.max(queue.length + start, 0) : start;
      const normalizedStop = stop < 0 ? queue.length + stop : stop;
      queueStore.set(key, queue.slice(normalizedStart, normalizedStop + 1));
      return 'OK';
    }),
    sendCommand: vi.fn(async (command: string[]) => {
      const [name, key, arg] = command;
      if (name === 'BLPOP') {
        const queue = queueStore.get(key) ?? [];
        if (queue.length === 0) return null;
        const value = queue.shift() ?? null;
        queueStore.set(key, queue);
        return value ? [key, value] : null;
      }
      if (name === 'LPOP') {
        const queue = queueStore.get(key) ?? [];
        const count = Number(arg ?? '1');
        if (queue.length === 0) return null;
        if (count <= 1) {
          const value = queue.shift() ?? null;
          queueStore.set(key, queue);
          return value;
        }
        const values = queue.splice(0, count);
        queueStore.set(key, queue);
        return values;
      }
      throw new Error(`unsupported command in test fake: ${command.join(' ')}`);
    }),
  };
}

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => fakeRedisClient()),
}));

vi.mock('redis', () => ({
  createClient,
}));

describe('redis relay backplane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    presenceStore.clear();
    queueStore.clear();
  });

  function createBackplane(overrides: NodeJS.ProcessEnv = {}) {
    const config = loadConfig({
      RELAY_BACKPLANE_MODE: 'redis',
      RELAY_REDIS_URL: 'redis://127.0.0.1:6379',
      RELAY_REDIS_KEY_PREFIX: 'test:relay',
      RELAY_REDIS_PRESENCE_TTL_MS: '30000',
      RELAY_REDIS_QUEUE_MAX: '8',
      RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-signing-key',
      RELAY_ID: 'relay-a',
      RELAY_PUBLIC_WS_BASE_URL: 'ws://relay-a.test/ws',
      RELAY_TLS: '0',
      ...overrides,
    });
    return new RedisRelayBackplane(config, new RelayLogger(5), new RelayMetrics());
  }

  it('stores and resolves daemon presence via redis with redirect validation', async () => {
    const backplane = createBackplane();

    await backplane.upsertPresence('workspace_demo', true);
    await expect(backplane.resolvePresence('workspace_demo')).resolves.toEqual({
      relayId: 'relay-a',
      relayWsBaseUrl: 'ws://relay-a.test/ws',
      daemonConnected: true,
      expiresAt: expect.any(Number),
    });

    await backplane.upsertPresence('workspace_demo', false);
    await expect(backplane.resolvePresence('workspace_demo')).resolves.toBeNull();

    await backplane.close();
  });

  it('publishes targeted bus frames and pulls them with signature verification', async () => {
    const source = createBackplane({ RELAY_ID: 'relay-a', RELAY_PUBLIC_WS_BASE_URL: 'ws://relay-a.test/ws' });
    const target = createBackplane({ RELAY_ID: 'relay-b', RELAY_PUBLIC_WS_BASE_URL: 'ws://relay-b.test/ws' });

    await expect(
      source.publishClientToDaemon('workspace_demo', '{"type":"e2ee"}', 'relay-b'),
    ).resolves.toBe(true);

    const frames = await target.pullFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      workspaceId: 'workspace_demo',
      sourceRelayId: 'relay-a',
      targetRelayId: 'relay-b',
      direction: 'client_to_daemon',
      payload: '{"type":"e2ee"}',
    });

    await source.close();
    await target.close();
  });

  it('drops tampered redis queue frames and refuses untargeted daemon fanout', async () => {
    const backplane = createBackplane({ RELAY_ID: 'relay-b' });
    queueStore.set('test:relay:queue:relay-b', [
      JSON.stringify({
        workspaceId: 'workspace_demo',
        sourceRelayId: 'relay-a',
        targetRelayId: 'relay-b',
        direction: 'client_to_daemon',
        payload: '{"type":"e2ee"}',
        issuedAtMs: Date.now(),
        signature: 'tampered',
      }),
    ]);

    await expect(backplane.pullFrames()).resolves.toEqual([]);
    await expect(
      backplane.publishDaemonToClients('workspace_demo', '{"type":"e2ee"}', null),
    ).resolves.toBe(false);

    await backplane.close();
  });
});

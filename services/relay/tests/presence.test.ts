import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { RelayLogger } from '../src/logger.js';
import { RelayMetrics } from '../src/metrics.js';
import { isAllowedRedirectWsBaseUrl, RelayPresenceClient } from '../src/presence.js';

describe('relay presence client', () => {
  it('bounds resolve cache with LRU eviction', async () => {
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
      RELAY_INTERNAL_KEY: 'internal-key',
      RELAY_PRESENCE_SYNC_ENABLED: '1',
      RELAY_PRESENCE_RESOLVE_CACHE_MAX: '2',
    });
    const presence = new RelayPresenceClient(config, new RelayLogger(10), new RelayMetrics()) as {
      resolveCache: Map<string, unknown>;
      touchCache: (workspaceId: string, entry: unknown) => void;
      trimCache: () => void;
    };

    presence.touchCache('w1', { relayId: 'relay-w1', expiresAt: Date.now() + 1000 });
    presence.trimCache();
    presence.touchCache('w2', { relayId: 'relay-w2', expiresAt: Date.now() + 1000 });
    presence.trimCache();
    presence.touchCache('w3', { relayId: 'relay-w3', expiresAt: Date.now() + 1000 });
    presence.trimCache();

    expect(presence.resolveCache.size).toBe(2);
    expect(presence.resolveCache.has('w1')).toBe(false);
    expect(presence.resolveCache.has('w2')).toBe(true);
    expect(presence.resolveCache.has('w3')).toBe(true);
  });

  it('validates redirect websocket URL policy by mode and host allowlist', async () => {
    const devConfig = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
      RELAY_INTERNAL_KEY: 'internal-key',
      RELAY_PRESENCE_SYNC_ENABLED: '1',
    });
    expect(isAllowedRedirectWsBaseUrl('ws://relay-b.test:7781/ws', devConfig)).toBe(true);
    expect(isAllowedRedirectWsBaseUrl('https://relay-b.test/ws', devConfig)).toBe(false);
    expect(isAllowedRedirectWsBaseUrl('wss://user:pass@relay-b.test/ws', devConfig)).toBe(false);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-presence-config-'));
    const relayCertPath = path.join(tmp, 'relay.crt');
    const relayKeyPath = path.join(tmp, 'relay.key');
    const serverCertPath = path.join(tmp, 'server.crt');
    const serverKeyPath = path.join(tmp, 'server.key');
    await fs.writeFile(relayCertPath, 'relay-cert');
    await fs.writeFile(relayKeyPath, 'relay-key');
    await fs.writeFile(serverCertPath, 'server-cert');
    await fs.writeFile(serverKeyPath, 'server-key');

    const prodConfig = loadConfig({
      RELAY_MODE: 'prod',
      RELAY_TLS: '1',
      RELAY_TLS_CERT_PATH: relayCertPath,
      RELAY_TLS_KEY_PATH: relayKeyPath,
      RELAY_SERVER_MTLS: '1',
      RELAY_SERVER_CLIENT_CERT_PATH: serverCertPath,
      RELAY_SERVER_CLIENT_KEY_PATH: serverKeyPath,
      RELAY_SERVER_TLS_VERIFY: '1',
      RELAY_INTERNAL_KEY: 'relay_internal_prod_secret_1234567890',
      RELAY_REDIRECT_ALLOWED_HOSTS: 'relay-a.example.com,relay-b.example.com',
      RELAY_PUBLIC_WS_BASE_URL: 'wss://relay-a.example.com/ws',
      RELAY_TLS_HOST: 'relay-a.example.com',
    });
    expect(isAllowedRedirectWsBaseUrl('wss://relay-b.example.com/ws', prodConfig)).toBe(true);
    expect(isAllowedRedirectWsBaseUrl('wss://attacker.example.com/ws', prodConfig)).toBe(false);
    expect(isAllowedRedirectWsBaseUrl('ws://relay-b.example.com/ws', prodConfig)).toBe(false);
  });
});

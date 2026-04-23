import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, resolveServerTlsRejectUnauthorized } from '../src/config.js';

describe('relay config', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config.backplaneMode).toBe('single');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(7781);
    expect(config.serverUrl).toBe('https://app.getviewport.com');
    expect(config.publicWsBaseUrl).toBe('wss://relay.getviewport.com/ws');
    expect(config.maxFrameBytes).toBe(1_048_576);
    expect(config.maxTotalConnections).toBeGreaterThan(0);
    expect(config.admissionTimeoutMs).toBe(2_000);
    expect(config.admissionMaxResponseBytes).toBe(262_144);
    expect(config.internalApiTimeoutMs).toBe(2_000);
    expect(config.internalApiMaxResponseBytes).toBe(262_144);
    expect(config.busSignatureMaxSkewMs).toBe(15_000);
    expect(config.maxUpgradeRateBuckets).toBe(50_000);
    expect(config.maxRuntimeFramesPerMinute).toBe(240);
    expect(config.kexRateLimiterMaxKeys).toBe(20_000);
    expect(config.maxRuntimeFramesPerMinuteWorkspace).toBe(1_200);
    expect(config.runtimeRateLimiterMaxKeys).toBe(20_000);
    expect(config.runtimeWorkspaceRateLimiterMaxKeys).toBe(10_000);
    expect(config.maxDaemonRuntimeFramesPerMinute).toBe(2_400);
    expect(config.daemonRateLimiterMaxKeys).toBe(10_000);
    expect(config.pairingRateLimiterMaxKeys).toBe(20_000);
    expect(config.maxPairingRequestTrack).toBe(2048);
    expect(config.maxSessionOwnerTrack).toBe(4096);
    expect(config.presenceResolveCacheMax).toBe(10_000);
    expect(config.presenceSyncEnabled).toBe(false);
    expect(config.enableAdminHttp).toBe(false);
    expect(config.healthVerbose).toBe(true);
    expect(config.stateIncludeClientIds).toBe(true);
    expect(config.busFreshnessTrackMax).toBe(20_000);
    expect(config.clientRedirectEnabled).toBe(false);
    expect(config.redirectAllowedHosts).toEqual([]);
  });

  it('parses numeric knobs from env', () => {
    const config = loadConfig({
      PORT: '8899',
      RELAY_MAX_TOTAL_CONNECTIONS: '123',
      RELAY_MAX_CONNECTIONS_PER_IP: '9',
      RELAY_MAX_FRAME_BYTES: '777',
      RELAY_MAX_PENDING_BYTES: '888',
      RELAY_MAX_CLIENTS_PER_WORKSPACE: '12',
      RELAY_UPGRADE_RATE_PER_MINUTE: '42',
      RELAY_UPGRADE_BUCKET_MAX: '333',
      RELAY_KEX_INIT_RATE_PER_MINUTE: '33',
      RELAY_KEX_RATE_LIMITER_MAX_KEYS: '2222',
      RELAY_RUNTIME_RATE_PER_MINUTE: '77',
      RELAY_RUNTIME_RATE_PER_MINUTE_WORKSPACE: '88',
      RELAY_RUNTIME_RATE_LIMITER_MAX_KEYS: '4444',
      RELAY_RUNTIME_WORKSPACE_RATE_LIMITER_MAX_KEYS: '5555',
      RELAY_DAEMON_RUNTIME_RATE_PER_MINUTE: '999',
      RELAY_DAEMON_RATE_LIMITER_MAX_KEYS: '7777',
      RELAY_PAIRING_RATE_LIMITER_MAX_KEYS: '6666',
      RELAY_PAIRING_REQUEST_TRACK_MAX: '444',
      RELAY_SESSION_OWNER_TRACK_MAX: '222',
      RELAY_PING_INTERVAL_MS: '4000',
      RELAY_PONG_TIMEOUT_MS: '1500',
      RELAY_IDLE_TIMEOUT_MS: '25000',
      RELAY_EMPTY_WORKSPACE_TTL_MS: '9999',
      RELAY_CLEANUP_INTERVAL_MS: '2222',
      RELAY_ENABLE_ADMIN_HTTP: 'true',
      RELAY_HEALTH_VERBOSE: 'false',
      RELAY_STATE_INCLUDE_CLIENT_IDS: 'false',
      RELAY_ADMISSION_TIMEOUT_MS: '1700',
      RELAY_ADMISSION_MAX_RESPONSE_BYTES: '2048',
      RELAY_INTERNAL_API_TIMEOUT_MS: '1900',
      RELAY_INTERNAL_API_MAX_RESPONSE_BYTES: '3072',
      RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      RELAY_ADMIN_TOKEN: 'relay-admin',
      RELAY_BUS_ENABLED: 'true',
      RELAY_BUS_HMAC_KEY: 'bus-signing-key',
      RELAY_BUS_POLL_INTERVAL_MS: '333',
      RELAY_BUS_PULL_LIMIT: '77',
      RELAY_BUS_PULL_WAIT_MS: '999',
      RELAY_BUS_SIGNATURE_MAX_SKEW_MS: '8888',
      RELAY_BUS_FRESHNESS_TRACK_MAX: '4321',
      RELAY_CLIENT_REDIRECT_ENABLED: 'false',
      RELAY_REDIRECT_ALLOWED_HOSTS: 'relay-a.example.com,relay-b.example.com',
      RELAY_PRESENCE_RESOLVE_CACHE_MAX: '321',
      RELAY_TRUSTED_PROXIES: '127.0.0.1,::1',
    });

    expect(config.port).toBe(8899);
    expect(config.maxTotalConnections).toBe(123);
    expect(config.maxConnectionsPerIp).toBe(9);
    expect(config.maxFrameBytes).toBe(777);
    expect(config.maxPendingBytes).toBe(888);
    expect(config.maxClientsPerWorkspace).toBe(12);
    expect(config.maxUpgradeRatePerMinute).toBe(42);
    expect(config.maxUpgradeRateBuckets).toBe(333);
    expect(config.maxKeyExchangeInitPerMinute).toBe(33);
    expect(config.kexRateLimiterMaxKeys).toBe(2222);
    expect(config.maxRuntimeFramesPerMinute).toBe(77);
    expect(config.maxRuntimeFramesPerMinuteWorkspace).toBe(88);
    expect(config.runtimeRateLimiterMaxKeys).toBe(4444);
    expect(config.runtimeWorkspaceRateLimiterMaxKeys).toBe(5555);
    expect(config.maxDaemonRuntimeFramesPerMinute).toBe(999);
    expect(config.daemonRateLimiterMaxKeys).toBe(7777);
    expect(config.pairingRateLimiterMaxKeys).toBe(6666);
    expect(config.maxPairingRequestTrack).toBe(444);
    expect(config.maxSessionOwnerTrack).toBe(222);
    expect(config.pingIntervalMs).toBe(4000);
    expect(config.pongTimeoutMs).toBe(1500);
    expect(config.idleTimeoutMs).toBe(25000);
    expect(config.emptyWorkspaceTtlMs).toBe(9999);
    expect(config.cleanupIntervalMs).toBe(2222);
    expect(config.enableAdminHttp).toBe(true);
    expect(config.healthVerbose).toBe(false);
    expect(config.stateIncludeClientIds).toBe(false);
    expect(config.admissionTimeoutMs).toBe(1700);
    expect(config.admissionMaxResponseBytes).toBe(2048);
    expect(config.internalApiTimeoutMs).toBe(1900);
    expect(config.internalApiMaxResponseBytes).toBe(3072);
    expect(config.relayAdminTokenHash).toBe(
      crypto.createHash('sha256').update('relay-admin', 'utf8').digest('hex'),
    );
    expect(config.backplaneMode).toBe('server');
    expect(config.busEnabled).toBe(true);
    expect(config.busHmacKey).toBe('bus-signing-key');
    expect(config.busPollIntervalMs).toBe(333);
    expect(config.busPullLimit).toBe(77);
    expect(config.busPullWaitMs).toBe(999);
    expect(config.busSignatureMaxSkewMs).toBe(8888);
    expect(config.busFreshnessTrackMax).toBe(4321);
    expect(config.clientRedirectEnabled).toBe(false);
    expect(config.redirectAllowedHosts).toEqual(['relay-a.example.com', 'relay-b.example.com']);
    expect(config.presenceResolveCacheMax).toBe(321);
    expect(config.trustedProxies).toEqual(['127.0.0.1', '::1']);
  });

  it('resolves server TLS verification in auto mode', () => {
    expect(resolveServerTlsRejectUnauthorized('https://getviewport.test', 'auto')).toBe(false);
    expect(resolveServerTlsRejectUnauthorized('https://api.example.com', 'auto')).toBe(true);
    expect(resolveServerTlsRejectUnauthorized('http://127.0.0.1:7780', 'auto')).toBe(true);
  });

  it('requires explicit public server URLs outside loopback development', () => {
    expect(() =>
      loadConfig({
        HOST: '0.0.0.0',
        SERVER_URL: 'http://127.0.0.1:24780',
      }),
    ).toThrow(
      'SERVER_URL and RELAY_PUBLIC_WS_BASE_URL must be set explicitly outside local loopback development',
    );

    expect(() =>
      loadConfig({
        HOST: '0.0.0.0',
      }),
    ).not.toThrow();

    expect(() =>
      loadConfig({
        HOST: '0.0.0.0',
        SERVER_URL: 'https://api.example.com',
        RELAY_PUBLIC_WS_BASE_URL: 'wss://relay.example.com/ws',
      }),
    ).toThrow('RELAY_TLS must be enabled when RELAY_MODE=prod');

  });

  it('defaults external topology URLs to prod hardening', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-config-external-'));
    const relayCertPath = path.join(tmp, 'relay.crt');
    const relayKeyPath = path.join(tmp, 'relay.key');
    const serverCertPath = path.join(tmp, 'server.crt');
    const serverKeyPath = path.join(tmp, 'server.key');
    await fs.writeFile(relayCertPath, 'relay-cert');
    await fs.writeFile(relayKeyPath, 'relay-key');
    await fs.writeFile(serverCertPath, 'server-cert');
    await fs.writeFile(serverKeyPath, 'server-key');

    const config = loadConfig({
      HOST: '0.0.0.0',
      SERVER_URL: 'https://api.example.com',
      RELAY_PUBLIC_WS_BASE_URL: 'wss://relay.example.com/ws',
      RELAY_TLS: '1',
      RELAY_TLS_CERT_PATH: relayCertPath,
      RELAY_TLS_KEY_PATH: relayKeyPath,
      RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      RELAY_SERVER_MTLS: '1',
      RELAY_SERVER_CLIENT_CERT_PATH: serverCertPath,
      RELAY_SERVER_CLIENT_KEY_PATH: serverKeyPath,
      RELAY_SERVER_TLS_VERIFY: '1',
    });

    expect(config.serverUrl).toBe('https://api.example.com');
    expect(config.publicWsBaseUrl).toBe('wss://relay.example.com/ws');
    expect(config.relayMode).toBe('prod');
  });

  it('requires RELAY_BUS_HMAC_KEY whenever bus is enabled', () => {
    expect(() =>
      loadConfig({
        RELAY_MODE: 'dev',
        RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
        RELAY_BUS_ENABLED: '1',
      }),
    ).toThrow('RELAY_BUS_HMAC_KEY');
  });

  it('allows bus mode when RELAY_BUS_HMAC_KEY is configured', () => {
    const config = loadConfig({
      RELAY_MODE: 'dev',
      RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'prod-bus-signing-key',
    });
    expect(config.backplaneMode).toBe('server');
    expect(config.busEnabled).toBe(true);
    expect(config.busHmacKey).toBe('prod-bus-signing-key');
  });

  it('requires redis url when redis backplane mode is enabled', () => {
    expect(() =>
      loadConfig({
        RELAY_BACKPLANE_MODE: 'redis',
        RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      }),
    ).toThrow('RELAY_REDIS_URL');
  });

  it('accepts explicit redis backplane configuration', () => {
    const config = loadConfig({
      RELAY_BACKPLANE_MODE: 'redis',
      RELAY_INTERNAL_KEY: 'relay-internal-key-1234567890',
      RELAY_REDIS_URL: 'redis://127.0.0.1:6379',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'redis-bus-signing-key',
    });
    expect(config.backplaneMode).toBe('redis');
    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.busEnabled).toBe(true);
    expect(config.busHmacKey).toBe('redis-bus-signing-key');
  });

  it('requires client cert and key files when RELAY_SERVER_MTLS is enabled', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-config-mtls-'));
    const certPath = path.join(tmp, 'client.crt');
    const keyPath = path.join(tmp, 'client.key');
    await fs.writeFile(certPath, 'cert');
    await fs.writeFile(keyPath, 'key');

    const ok = loadConfig({
      RELAY_SERVER_MTLS: '1',
      RELAY_SERVER_CLIENT_CERT_PATH: certPath,
      RELAY_SERVER_CLIENT_KEY_PATH: keyPath,
    });
    expect(ok.serverMtlsEnabled).toBe(true);
    expect(ok.serverClientCertPath).toBe(certPath);
    expect(ok.serverClientKeyPath).toBe(keyPath);

    expect(() =>
      loadConfig({
        RELAY_SERVER_MTLS: '1',
        RELAY_SERVER_CLIENT_CERT_PATH: certPath,
      }),
    ).toThrow('RELAY_SERVER_CLIENT_CERT_PATH or RELAY_SERVER_CLIENT_KEY_PATH');
  });

  it('enforces strict production security defaults', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-config-prod-'));
    const relayCertPath = path.join(tmp, 'relay.crt');
    const relayKeyPath = path.join(tmp, 'relay.key');
    const serverCertPath = path.join(tmp, 'server.crt');
    const serverKeyPath = path.join(tmp, 'server.key');
    await fs.writeFile(relayCertPath, 'relay-cert');
    await fs.writeFile(relayKeyPath, 'relay-key');
    await fs.writeFile(serverCertPath, 'server-cert');
    await fs.writeFile(serverKeyPath, 'server-key');

    expect(() =>
      loadConfig({
        RELAY_MODE: 'prod',
        RELAY_TLS: '1',
        RELAY_TLS_CERT_PATH: relayCertPath,
        RELAY_TLS_KEY_PATH: relayKeyPath,
        RELAY_SERVER_MTLS: '1',
        RELAY_SERVER_CLIENT_CERT_PATH: serverCertPath,
        RELAY_SERVER_CLIENT_KEY_PATH: serverKeyPath,
        RELAY_SERVER_TLS_VERIFY: '1',
      }),
    ).toThrow('RELAY_INTERNAL_KEY');

    const config = loadConfig({
      RELAY_MODE: 'prod',
      RELAY_TLS: '1',
      RELAY_TLS_CERT_PATH: relayCertPath,
      RELAY_TLS_KEY_PATH: relayKeyPath,
      RELAY_SERVER_MTLS: '1',
      RELAY_SERVER_CLIENT_CERT_PATH: serverCertPath,
      RELAY_SERVER_CLIENT_KEY_PATH: serverKeyPath,
      RELAY_SERVER_TLS_VERIFY: '1',
      RELAY_INTERNAL_KEY: 'relay_internal_prod_secret_1234567890',
      RELAY_BUS_ENABLED: '0',
    });
    expect(config.relayMode).toBe('prod');
    expect(config.serverMtlsEnabled).toBe(true);
    expect(config.serverTlsVerify).toBe('1');
    expect(config.healthVerbose).toBe(false);
    expect(config.stateIncludeClientIds).toBe(false);
  });
});

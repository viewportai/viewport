import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { z } from 'zod';

const BoolishSchema = z.enum(['0', '1', 'false', 'true', 'no', 'yes', 'off', 'on']).optional();
const TlsModeSchema = z.enum(['auto', '0', '1']);
const BackplaneModeSchema = z.enum(['single', 'server', 'redis']);

const EnvSchema = z.object({
  HOST: z.string().optional(),
  PORT: z.string().optional(),
  SERVER_URL: z.string().optional(),
  MAX_LOGS: z.string().optional(),
  RELAY_TLS: z.string().optional(),
  RELAY_TLS_HOST: z.string().optional(),
  RELAY_TLS_CERT_PATH: z.string().optional(),
  RELAY_TLS_KEY_PATH: z.string().optional(),
  RELAY_ADMIN_TOKEN: z.string().optional(),
  RELAY_ENABLE_ADMIN_HTTP: BoolishSchema,
  RELAY_HEALTH_VERBOSE: BoolishSchema,
  RELAY_STATE_INCLUDE_CLIENT_IDS: BoolishSchema,
  RELAY_ADMISSION_TIMEOUT_MS: z.string().optional(),
  RELAY_ADMISSION_MAX_RESPONSE_BYTES: z.string().optional(),
  RELAY_INTERNAL_API_TIMEOUT_MS: z.string().optional(),
  RELAY_INTERNAL_API_MAX_RESPONSE_BYTES: z.string().optional(),
  RELAY_SERVER_TLS_VERIFY: z.enum(['auto', '0', '1']).optional(),
  RELAY_SERVER_CA_CERT_PATH: z.string().optional(),
  RELAY_SERVER_MTLS: BoolishSchema,
  RELAY_SERVER_CLIENT_CERT_PATH: z.string().optional(),
  RELAY_SERVER_CLIENT_KEY_PATH: z.string().optional(),
  RELAY_SERVER_CLIENT_KEY_PASSPHRASE: z.string().optional(),
  RELAY_MAX_TOTAL_CONNECTIONS: z.string().optional(),
  RELAY_MAX_CONNECTIONS_PER_IP: z.string().optional(),
  RELAY_MAX_CLIENTS_PER_WORKSPACE: z.string().optional(),
  RELAY_MAX_FRAME_BYTES: z.string().optional(),
  RELAY_MAX_PENDING_BYTES: z.string().optional(),
  RELAY_UPGRADE_RATE_PER_MINUTE: z.string().optional(),
  RELAY_UPGRADE_BUCKET_MAX: z.string().optional(),
  RELAY_KEX_INIT_RATE_PER_MINUTE: z.string().optional(),
  RELAY_KEX_RATE_LIMITER_MAX_KEYS: z.string().optional(),
  RELAY_RUNTIME_RATE_PER_MINUTE: z.string().optional(),
  RELAY_RUNTIME_RATE_PER_MINUTE_WORKSPACE: z.string().optional(),
  RELAY_RUNTIME_RATE_LIMITER_MAX_KEYS: z.string().optional(),
  RELAY_RUNTIME_WORKSPACE_RATE_LIMITER_MAX_KEYS: z.string().optional(),
  RELAY_DAEMON_RUNTIME_RATE_PER_MINUTE: z.string().optional(),
  RELAY_DAEMON_RATE_LIMITER_MAX_KEYS: z.string().optional(),
  RELAY_PAIRING_RATE_PER_MINUTE: z.string().optional(),
  RELAY_PAIRING_RATE_LIMITER_MAX_KEYS: z.string().optional(),
  RELAY_PAIRING_REQUEST_TRACK_MAX: z.string().optional(),
  RELAY_SESSION_OWNER_TRACK_MAX: z.string().optional(),
  RELAY_PING_INTERVAL_MS: z.string().optional(),
  RELAY_PONG_TIMEOUT_MS: z.string().optional(),
  RELAY_IDLE_TIMEOUT_MS: z.string().optional(),
  RELAY_EMPTY_WORKSPACE_TTL_MS: z.string().optional(),
  RELAY_CLEANUP_INTERVAL_MS: z.string().optional(),
  RELAY_ID: z.string().optional(),
  RELAY_PUBLIC_WS_BASE_URL: z.string().optional(),
  RELAY_INTERNAL_KEY: z.string().optional(),
  RELAY_BACKPLANE_MODE: BackplaneModeSchema.optional(),
  RELAY_REDIS_URL: z.string().optional(),
  RELAY_REDIS_KEY_PREFIX: z.string().optional(),
  RELAY_REDIS_CONNECT_TIMEOUT_MS: z.string().optional(),
  RELAY_REDIS_PRESENCE_TTL_MS: z.string().optional(),
  RELAY_REDIS_QUEUE_MAX: z.string().optional(),
  RELAY_PRESENCE_SYNC_ENABLED: BoolishSchema,
  RELAY_PRESENCE_SYNC_INTERVAL_MS: z.string().optional(),
  RELAY_PRESENCE_RESOLVE_CACHE_MAX: z.string().optional(),
  RELAY_BUS_ENABLED: BoolishSchema,
  RELAY_BUS_HMAC_KEY: z.string().optional(),
  RELAY_BUS_POLL_INTERVAL_MS: z.string().optional(),
  RELAY_BUS_PULL_LIMIT: z.string().optional(),
  RELAY_BUS_PULL_WAIT_MS: z.string().optional(),
  RELAY_BUS_SIGNATURE_MAX_SKEW_MS: z.string().optional(),
  RELAY_BUS_FRESHNESS_TRACK_MAX: z.string().optional(),
  RELAY_CLIENT_REDIRECT_ENABLED: BoolishSchema,
  RELAY_REDIRECT_ALLOWED_HOSTS: z.string().optional(),
  RELAY_TRUSTED_PROXIES: z.string().optional(),
  RELAY_MODE: z.enum(['dev', 'staging', 'prod']).optional(),
});

export type RelayBackplaneMode = z.infer<typeof BackplaneModeSchema>;

export interface RelayConfig {
  relayMode: 'dev' | 'staging' | 'prod';
  backplaneMode: RelayBackplaneMode;
  host: string;
  port: number;
  serverUrl: string;
  maxLogs: number;
  tlsEnabled: boolean;
  tlsHost: string;
  tlsCertPath: string;
  tlsKeyPath: string;
  relayAdminTokenHash?: string;
  enableAdminHttp: boolean;
  healthVerbose: boolean;
  stateIncludeClientIds: boolean;
  admissionTimeoutMs: number;
  admissionMaxResponseBytes: number;
  internalApiTimeoutMs: number;
  internalApiMaxResponseBytes: number;
  serverTlsVerify: 'auto' | '0' | '1';
  serverCaCertPath?: string;
  serverMtlsEnabled: boolean;
  serverClientCertPath: string;
  serverClientKeyPath: string;
  serverClientKeyPassphrase?: string;
  maxTotalConnections: number;
  maxConnectionsPerIp: number;
  maxClientsPerWorkspace: number;
  maxFrameBytes: number;
  maxPendingBytes: number;
  maxUpgradeRatePerMinute: number;
  maxUpgradeRateBuckets: number;
  maxKeyExchangeInitPerMinute: number;
  kexRateLimiterMaxKeys: number;
  maxRuntimeFramesPerMinute: number;
  maxRuntimeFramesPerMinuteWorkspace: number;
  runtimeRateLimiterMaxKeys: number;
  runtimeWorkspaceRateLimiterMaxKeys: number;
  maxDaemonRuntimeFramesPerMinute: number;
  daemonRateLimiterMaxKeys: number;
  maxPairingFramesPerMinute: number;
  pairingRateLimiterMaxKeys: number;
  maxPairingRequestTrack: number;
  maxSessionOwnerTrack: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  idleTimeoutMs: number;
  emptyWorkspaceTtlMs: number;
  cleanupIntervalMs: number;
  relayId: string;
  publicWsBaseUrl: string;
  relayInternalKey?: string;
  redisUrl?: string;
  redisKeyPrefix: string;
  redisConnectTimeoutMs: number;
  redisPresenceTtlMs: number;
  redisQueueMax: number;
  presenceSyncEnabled: boolean;
  presenceSyncIntervalMs: number;
  presenceResolveCacheMax: number;
  busEnabled: boolean;
  busHmacKey?: string;
  busPollIntervalMs: number;
  busPullLimit: number;
  busPullWaitMs: number;
  busSignatureMaxSkewMs: number;
  busFreshnessTrackMax: number;
  clientRedirectEnabled: boolean;
  redirectAllowedHosts: string[];
  trustedProxies: string[];
}

function parseBoolish(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) return fallback;
  return parsed;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function hashToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim();
  if (!normalized) return undefined;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function looksLikePlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('change-me') ||
    normalized.includes('placeholder') ||
    normalized.includes('example') ||
    normalized.length < 24
  );
}

function certFilesExist(certPath: string, keyPath: string): boolean {
  return fs.existsSync(certPath) && fs.existsSync(keyPath);
}

function usesViewportLocalDefaults(serverUrl: string, publicWsBaseUrl: string): boolean {
  return serverUrl.includes('getviewport.test') || publicWsBaseUrl.includes('getviewport.test');
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function resolveTlsEnabled(mode: 'auto' | '0' | '1', certPath: string, keyPath: string): boolean {
  if (mode === '1') return true;
  if (mode === '0') return false;
  return certFilesExist(certPath, keyPath);
}

export function resolveServerTlsRejectUnauthorized(
  serverUrl: string,
  mode: 'auto' | '0' | '1',
): boolean {
  if (mode === '1') return true;
  if (mode === '0') return false;
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'https:') return true;
  return !(parsed.hostname.endsWith('.test') || parsed.hostname === 'localhost');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsedEnv = EnvSchema.parse(env);
  const relayMode = parsedEnv.RELAY_MODE ?? 'dev';

  const host = parsedEnv.HOST?.trim() || '127.0.0.1';
  const port = parsePositiveInt(parsedEnv.PORT, 7781);
  const serverUrl = parsedEnv.SERVER_URL?.trim() || 'https://getviewport.test';

  const tlsHost = parsedEnv.RELAY_TLS_HOST?.trim() || 'getviewport.test';
  const certDir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Herd',
    'config',
    'valet',
    'Certificates',
  );
  const tlsCertPath = parsedEnv.RELAY_TLS_CERT_PATH || path.join(certDir, `${tlsHost}.crt`);
  const tlsKeyPath = parsedEnv.RELAY_TLS_KEY_PATH || path.join(certDir, `${tlsHost}.key`);
  const tlsMode = TlsModeSchema.parse((parsedEnv.RELAY_TLS ?? 'auto').toLowerCase());
  const tlsEnabled = resolveTlsEnabled(tlsMode, tlsCertPath, tlsKeyPath);
  if (tlsEnabled && !certFilesExist(tlsCertPath, tlsKeyPath)) {
    throw new Error(
      `RELAY_TLS enabled but cert/key not found (cert=${tlsCertPath}, key=${tlsKeyPath})`,
    );
  }

  const protocol = tlsEnabled ? 'wss' : 'ws';
  const publicWsBaseUrl =
    parsedEnv.RELAY_PUBLIC_WS_BASE_URL?.trim() || `${protocol}://${tlsHost}:${port}/ws`;
  const relayId =
    parsedEnv.RELAY_ID?.trim() ||
    `${host}:${port}:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const serverClientCertPath = parsedEnv.RELAY_SERVER_CLIENT_CERT_PATH?.trim() || '';
  const serverClientKeyPath = parsedEnv.RELAY_SERVER_CLIENT_KEY_PATH?.trim() || '';
  const serverMtlsEnabled =
    parseBoolish(parsedEnv.RELAY_SERVER_MTLS, false) ||
    (serverClientCertPath.length > 0 && serverClientKeyPath.length > 0);
  if (serverMtlsEnabled) {
    if (!serverClientCertPath || !serverClientKeyPath) {
      throw new Error(
        'RELAY_SERVER_MTLS enabled but RELAY_SERVER_CLIENT_CERT_PATH or RELAY_SERVER_CLIENT_KEY_PATH is missing',
      );
    }
    if (!certFilesExist(serverClientCertPath, serverClientKeyPath)) {
      throw new Error(
        `RELAY_SERVER_MTLS enabled but client cert/key not found (cert=${serverClientCertPath}, key=${serverClientKeyPath})`,
      );
    }
  }

  const serverTlsVerify = parsedEnv.RELAY_SERVER_TLS_VERIFY ?? 'auto';
  const relayInternalKey = parsedEnv.RELAY_INTERNAL_KEY?.trim() || undefined;
  const explicitBackplaneMode = parsedEnv.RELAY_BACKPLANE_MODE;
  const inferredBackplaneMode: RelayBackplaneMode =
    explicitBackplaneMode ??
    (relayInternalKey ||
    parseBoolish(parsedEnv.RELAY_BUS_ENABLED, false) ||
    parseBoolish(parsedEnv.RELAY_PRESENCE_SYNC_ENABLED, false)
      ? 'server'
      : 'single');

  const backplaneMode = inferredBackplaneMode;
  const presenceSyncEnabled =
    backplaneMode === 'single' ? false : parseBoolish(parsedEnv.RELAY_PRESENCE_SYNC_ENABLED, true);
  const busEnabled =
    backplaneMode === 'single' ? false : parseBoolish(parsedEnv.RELAY_BUS_ENABLED, false);
  const clientRedirectEnabled =
    backplaneMode === 'single'
      ? false
      : parseBoolish(parsedEnv.RELAY_CLIENT_REDIRECT_ENABLED, true);
  const busHmacKey = parsedEnv.RELAY_BUS_HMAC_KEY?.trim() || undefined;

  if (backplaneMode === 'server') {
    if (!relayInternalKey) {
      throw new Error('RELAY_INTERNAL_KEY is required when RELAY_BACKPLANE_MODE=server');
    }
    if (busEnabled && !busHmacKey) {
      throw new Error('RELAY_BUS_HMAC_KEY is required when RELAY_BACKPLANE_MODE=server');
    }
  }
  const redisUrl = parsedEnv.RELAY_REDIS_URL?.trim() || undefined;
  if (backplaneMode === 'redis') {
    if (!relayInternalKey) {
      throw new Error('RELAY_INTERNAL_KEY is required when RELAY_BACKPLANE_MODE=redis');
    }
    if (!redisUrl) {
      throw new Error('RELAY_REDIS_URL is required when RELAY_BACKPLANE_MODE=redis');
    }
    if (busEnabled && !busHmacKey) {
      throw new Error('RELAY_BUS_HMAC_KEY is required when RELAY_BACKPLANE_MODE=redis');
    }
  }
  if (usesViewportLocalDefaults(serverUrl, publicWsBaseUrl) && !isLoopbackHost(host)) {
    throw new Error(
      'SERVER_URL and RELAY_PUBLIC_WS_BASE_URL must be set explicitly outside local loopback development',
    );
  }
  if (relayMode === 'prod') {
    if (!tlsEnabled) {
      throw new Error('RELAY_TLS must be enabled when RELAY_MODE=prod');
    }
    if (!relayInternalKey || looksLikePlaceholderSecret(relayInternalKey)) {
      throw new Error(
        'RELAY_INTERNAL_KEY must be configured with a high-entropy secret when RELAY_MODE=prod',
      );
    }
    if (!serverMtlsEnabled) {
      throw new Error('RELAY_SERVER_MTLS must be enabled when RELAY_MODE=prod');
    }
    if (serverTlsVerify !== '1') {
      throw new Error(
        'RELAY_SERVER_TLS_VERIFY must be 1 when RELAY_MODE=prod to prevent TLS downgrade',
      );
    }
  }

  return {
    relayMode,
    backplaneMode,
    host,
    port,
    serverUrl,
    maxLogs: parsePositiveInt(parsedEnv.MAX_LOGS, 400),
    tlsEnabled,
    tlsHost,
    tlsCertPath,
    tlsKeyPath,
    relayAdminTokenHash: hashToken(parsedEnv.RELAY_ADMIN_TOKEN),
    enableAdminHttp: parseBoolish(parsedEnv.RELAY_ENABLE_ADMIN_HTTP, false),
    healthVerbose: parseBoolish(parsedEnv.RELAY_HEALTH_VERBOSE, relayMode === 'dev'),
    stateIncludeClientIds: parseBoolish(
      parsedEnv.RELAY_STATE_INCLUDE_CLIENT_IDS,
      relayMode === 'dev',
    ),
    admissionTimeoutMs: parsePositiveInt(parsedEnv.RELAY_ADMISSION_TIMEOUT_MS, 2_000),
    admissionMaxResponseBytes: parsePositiveInt(
      parsedEnv.RELAY_ADMISSION_MAX_RESPONSE_BYTES,
      262_144,
    ),
    internalApiTimeoutMs: parsePositiveInt(parsedEnv.RELAY_INTERNAL_API_TIMEOUT_MS, 2_000),
    internalApiMaxResponseBytes: parsePositiveInt(
      parsedEnv.RELAY_INTERNAL_API_MAX_RESPONSE_BYTES,
      262_144,
    ),
    serverTlsVerify,
    serverCaCertPath: parsedEnv.RELAY_SERVER_CA_CERT_PATH?.trim() || undefined,
    serverMtlsEnabled,
    serverClientCertPath,
    serverClientKeyPath,
    serverClientKeyPassphrase: parsedEnv.RELAY_SERVER_CLIENT_KEY_PASSPHRASE?.trim() || undefined,
    maxTotalConnections: parsePositiveInt(parsedEnv.RELAY_MAX_TOTAL_CONNECTIONS, 2_000),
    maxConnectionsPerIp: parsePositiveInt(parsedEnv.RELAY_MAX_CONNECTIONS_PER_IP, 50),
    maxClientsPerWorkspace: parsePositiveInt(parsedEnv.RELAY_MAX_CLIENTS_PER_WORKSPACE, 100),
    maxFrameBytes: parsePositiveInt(parsedEnv.RELAY_MAX_FRAME_BYTES, 1_048_576),
    maxPendingBytes: parsePositiveInt(parsedEnv.RELAY_MAX_PENDING_BYTES, 4 * 1_048_576),
    maxUpgradeRatePerMinute: parsePositiveInt(parsedEnv.RELAY_UPGRADE_RATE_PER_MINUTE, 120),
    maxUpgradeRateBuckets: parsePositiveInt(parsedEnv.RELAY_UPGRADE_BUCKET_MAX, 50_000),
    maxKeyExchangeInitPerMinute: parsePositiveInt(parsedEnv.RELAY_KEX_INIT_RATE_PER_MINUTE, 60),
    kexRateLimiterMaxKeys: parsePositiveInt(parsedEnv.RELAY_KEX_RATE_LIMITER_MAX_KEYS, 20_000),
    maxRuntimeFramesPerMinute: parsePositiveInt(parsedEnv.RELAY_RUNTIME_RATE_PER_MINUTE, 240),
    maxRuntimeFramesPerMinuteWorkspace: parsePositiveInt(
      parsedEnv.RELAY_RUNTIME_RATE_PER_MINUTE_WORKSPACE,
      1_200,
    ),
    runtimeRateLimiterMaxKeys: parsePositiveInt(
      parsedEnv.RELAY_RUNTIME_RATE_LIMITER_MAX_KEYS,
      20_000,
    ),
    runtimeWorkspaceRateLimiterMaxKeys: parsePositiveInt(
      parsedEnv.RELAY_RUNTIME_WORKSPACE_RATE_LIMITER_MAX_KEYS,
      10_000,
    ),
    maxDaemonRuntimeFramesPerMinute: parsePositiveInt(
      parsedEnv.RELAY_DAEMON_RUNTIME_RATE_PER_MINUTE,
      2_400,
    ),
    daemonRateLimiterMaxKeys: parsePositiveInt(
      parsedEnv.RELAY_DAEMON_RATE_LIMITER_MAX_KEYS,
      10_000,
    ),
    maxPairingFramesPerMinute: parsePositiveInt(parsedEnv.RELAY_PAIRING_RATE_PER_MINUTE, 30),
    pairingRateLimiterMaxKeys: parsePositiveInt(
      parsedEnv.RELAY_PAIRING_RATE_LIMITER_MAX_KEYS,
      20_000,
    ),
    maxPairingRequestTrack: parsePositiveInt(parsedEnv.RELAY_PAIRING_REQUEST_TRACK_MAX, 2_048),
    maxSessionOwnerTrack: parsePositiveInt(parsedEnv.RELAY_SESSION_OWNER_TRACK_MAX, 4_096),
    pingIntervalMs: parsePositiveInt(parsedEnv.RELAY_PING_INTERVAL_MS, 30_000),
    pongTimeoutMs: parsePositiveInt(parsedEnv.RELAY_PONG_TIMEOUT_MS, 10_000),
    idleTimeoutMs: parsePositiveInt(parsedEnv.RELAY_IDLE_TIMEOUT_MS, 300_000),
    emptyWorkspaceTtlMs: parsePositiveInt(parsedEnv.RELAY_EMPTY_WORKSPACE_TTL_MS, 120_000),
    cleanupIntervalMs: parsePositiveInt(parsedEnv.RELAY_CLEANUP_INTERVAL_MS, 30_000),
    relayId,
    publicWsBaseUrl,
    relayInternalKey,
    redisUrl,
    redisKeyPrefix: parsedEnv.RELAY_REDIS_KEY_PREFIX?.trim() || 'viewport:relay',
    redisConnectTimeoutMs: parsePositiveInt(parsedEnv.RELAY_REDIS_CONNECT_TIMEOUT_MS, 5_000),
    redisPresenceTtlMs: parsePositiveInt(parsedEnv.RELAY_REDIS_PRESENCE_TTL_MS, 45_000),
    redisQueueMax: parsePositiveInt(parsedEnv.RELAY_REDIS_QUEUE_MAX, 10_000),
    presenceSyncEnabled,
    presenceSyncIntervalMs: parsePositiveInt(parsedEnv.RELAY_PRESENCE_SYNC_INTERVAL_MS, 20_000),
    presenceResolveCacheMax: parsePositiveInt(parsedEnv.RELAY_PRESENCE_RESOLVE_CACHE_MAX, 10_000),
    busEnabled,
    busHmacKey,
    busPollIntervalMs: parsePositiveInt(parsedEnv.RELAY_BUS_POLL_INTERVAL_MS, 250),
    busPullLimit: parsePositiveInt(parsedEnv.RELAY_BUS_PULL_LIMIT, 200),
    busPullWaitMs: parsePositiveInt(parsedEnv.RELAY_BUS_PULL_WAIT_MS, 1000),
    busSignatureMaxSkewMs: parsePositiveInt(parsedEnv.RELAY_BUS_SIGNATURE_MAX_SKEW_MS, 15_000),
    busFreshnessTrackMax: parsePositiveInt(parsedEnv.RELAY_BUS_FRESHNESS_TRACK_MAX, 20_000),
    clientRedirectEnabled,
    redirectAllowedHosts: parseCsv(parsedEnv.RELAY_REDIRECT_ALLOWED_HOSTS).map((entry) =>
      entry.toLowerCase(),
    ),
    trustedProxies: parseCsv(parsedEnv.RELAY_TRUSTED_PROXIES),
  };
}

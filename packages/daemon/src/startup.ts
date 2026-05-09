/**
 * Daemon startup and runtime lifecycle.
 *
 * Modes:
 * - `start` command: launches a dedicated supervisor (detached by default)
 * - `__supervisor`: supervisor process that owns pid-state and worker lifecycle
 * - `__worker`: daemon worker process (HTTP/WS runtime)
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { logger } from './core/output.js';
import { Daemon } from './core/daemon.js';
import { GitTracker } from './tracking/git-tracker.js';
import { registerHttpRoutes } from './server/http-server.js';
import { registerWsServer } from './server/ws-server.js';
import { HookRouter, SupervisionManager } from './hooks/index.js';
import { PlatformPlanHookSync } from './hooks/platform-plan-sync.js';
import { LocalAuthProvider } from './server/auth.js';
import type { AuthProvider } from './server/auth.js';
import type { GitTrackerConfig } from './core/types.js';
import { hasFlag } from './cli/args.js';
import {
  readDaemonRuntimeState,
  isPidRunning,
  clearDaemonRuntimeState,
  readProcessInfo,
  isOwnershipMatch,
  stopPid,
} from './cli/daemon-lifecycle.js';
import { daemonFetch } from './cli/daemon-client.js';
import {
  runSupervisorForeground,
  runSupervisorFromEnv,
  startSupervisorDetached,
  loadWorkerConfigFromEnv,
} from './cli/supervisor.js';
import { resolveLocalTlsState } from './cli/local-tls.js';
import {
  WORKER_EXIT_RESTART,
  WORKER_EXIT_SHUTDOWN,
  type RuntimeLaunchConfig,
} from './cli/supervisor-protocol.js';
import { buildSecurityProfile, isOriginAllowed } from './server/security.js';
import { resolveDaemonSettingsFromSources } from './cli/daemon-settings.js';
import { loadAgents, autoRegisterDirectories, decodeAutoRegisterEntry } from './startup-agents.js';
import { startDiscoveryWatchers } from './startup-watchers.js';
import { maybeOfferAgentPrerequisites } from './startup-prereqs.js';
import { setupSessionPersistence } from './startup-session-persistence.js';
import { validateRelayRuntimeSecurity } from './startup-relay-security.js';
import { DaemonRelayBridge } from './relay/daemon-relay-bridge.js';
import { configDir } from './core/config.js';

export { decodeAutoRegisterEntry };

function printStartJson(payload: Record<string, unknown>): void {
  logger.log(JSON.stringify(payload, null, 2));
}

export const HTTP_LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

async function readDaemonAuthToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(configDir(), 'auth-token'), 'utf-8');
    const token = raw.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function localDaemonWsUrl(config: RuntimeLaunchConfig): string | null {
  if (config.socketPath) {
    // ws+unix is not currently supported by the ws client in this relay bridge.
    return null;
  }
  const tls = resolveTlsOptions();
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return tls ? `wss://127.0.0.1:${config.port}/ws` : `ws://${host}:${config.port}/ws`;
}

export function localDaemonBridgeTlsOptions(): {
  daemonTlsVerify: '0';
} | null {
  const tls = resolveTlsOptions();
  if (!tls) return null;
  // The relay bridge is connecting back into the daemon's own local socket.
  // Use loopback transport and disable PKI verification for this self-connection.
  return {
    daemonTlsVerify: '0',
  };
}

export function missingRelayRuntimeConfig(config: RuntimeLaunchConfig): string[] {
  const missing: string[] = [];
  if (!config.relayEndpoint) missing.push('relay endpoint');
  if (!config.relayServerUrl) missing.push('relay server URL');
  if (!config.relayWorkspaceId) missing.push('relay workspace ID');
  if (!config.relayIssueToken) {
    missing.push('relay issue token');
  }
  if (!localDaemonWsUrl(config)) {
    missing.push(
      'tcp listen target (relay runtime currently requires tcp listen, not unix socket)',
    );
  }
  return missing;
}

function resolveTlsOptions(): { cert: Buffer; key: Buffer; tlsHost: string } | null {
  const tls = resolveLocalTlsState();
  if (!tls.enabled) return null;

  if (!tls.certPath || !tls.keyPath || !existsSync(tls.certPath) || !existsSync(tls.keyPath)) {
    const tlsEnv = (process.env['VIEWPORT_TLS'] ?? 'auto').toLowerCase();
    if (tlsEnv === '1' || tlsEnv === 'true' || tlsEnv === 'on') {
      throw new Error(
        `VIEWPORT_TLS enabled but certs not found (cert=${tls.certPath}, key=${tls.keyPath})`,
      );
    }
    return null;
  }

  return {
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
    tlsHost: tls.host,
  };
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

async function isRuntimeResponsive(): Promise<boolean> {
  const res = await daemonFetch('/health', { timeoutMs: 1_200 });
  return !!(res && res.ok);
}

export async function start(options?: { silent?: boolean; json?: boolean }): Promise<void> {
  const silent = options?.silent ?? false;
  const asJson = options?.json ?? hasFlag('json');
  const resolved = await resolveDaemonSettingsFromSources();
  await startWithLaunchConfig(resolved.launch, { silent, json: asJson });
}

export async function startWithLaunchConfig(
  config: RuntimeLaunchConfig,
  options?: { silent?: boolean; json?: boolean },
): Promise<void> {
  const silent = options?.silent ?? false;
  const asJson = options?.json ?? hasFlag('json');
  await maybeOfferAgentPrerequisites({ silent, asJson });

  const existingRuntime = await readDaemonRuntimeState();
  if (existingRuntime) {
    const running = isPidRunning(existingRuntime.ownerPid);
    if (running) {
      const processInfo = readProcessInfo(existingRuntime.ownerPid);
      if (isOwnershipMatch(existingRuntime, processInfo)) {
        const responsive = await isRuntimeResponsive();
        if (responsive) {
          throw new Error(
            `Daemon already running (owner pid ${existingRuntime.ownerPid}, listen ${existingRuntime.listen ?? `${existingRuntime.host}:${existingRuntime.port}`})`,
          );
        }

        // Auto-heal stale supervisor state: owner PID is present but daemon is unreachable.
        try {
          const result = await stopPid(existingRuntime.ownerPid, {
            timeoutMs: 1_500,
            force: true,
            useProcessGroup: true,
          });
          if (!silent) {
            logger.warn(
              `Auto-healed stale daemon supervisor (pid ${existingRuntime.ownerPid}, result: ${result}).`,
            );
          }
        } catch (err) {
          throw new Error(
            `Daemon owner pid ${existingRuntime.ownerPid} is unresponsive and could not be auto-healed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    await clearDaemonRuntimeState();
  }

  if (config.detached) {
    const startup = await startSupervisorDetached(config);
    if (!silent) {
      if (asJson) {
        printStartJson({
          command: 'start',
          ok: true,
          mode: 'detached',
          ownerPid: startup.pid,
          logPath: startup.logPath,
          listen: config.listen,
          socketPath: config.socketPath ?? null,
          host: config.host,
          port: config.port,
          profile: config.profile,
        });
      } else {
        logger.log(`Daemon starting in background (owner pid ${startup.pid ?? 'unknown'}).`);
        logger.log(`Logs: ${startup.logPath}`);
        logger.log(`Listen: ${config.listen}`);
      }
    }
    return;
  }

  const status = await runSupervisorForeground(config);
  if (!silent && asJson) {
    printStartJson({
      command: 'start',
      ok: status === 0,
      mode: 'foreground',
      exitCode: status,
      listen: config.listen,
      socketPath: config.socketPath ?? null,
      host: config.host,
      port: config.port,
      profile: config.profile,
    });
  }
  process.exit(status);
}

export async function runSupervisorCommand(): Promise<void> {
  const status = await runSupervisorFromEnv();
  process.exit(status);
}

// ---------------------------------------------------------------------------
// worker command
// ---------------------------------------------------------------------------

export async function runWorkerCommand(): Promise<void> {
  const config = loadWorkerConfigFromEnv();
  await runDaemonWorker(config);
}

export async function runDaemonWorker(config: RuntimeLaunchConfig): Promise<void> {
  const { port, host, version, socketPath } = config;
  const runtimeStartedAt = Date.now();
  const daemon = new Daemon();
  await daemon.initialize();

  const registry = await loadAgents(daemon);
  daemon.setModelProvider(() => registry.fetchAllModels());
  await autoRegisterDirectories(daemon, registry);

  daemon.setTrackerFactory(
    (trackerConfig: GitTrackerConfig, sessionId: string) =>
      new GitTracker(trackerConfig, sessionId),
  );

  const tls = resolveTlsOptions();

  // When TLS is enabled, automatically allow the configured TLS hostname and subdomains
  // so browser clients can reach the local daemon over WSS.
  const tlsHostAllowance = tls ? `,${tls.tlsHost},.${tls.tlsHost}` : '';
  const securityProfile = buildSecurityProfile({
    profile: config.profile,
    host: config.host,
    allowedHostsRaw: (config.allowedHostsRaw ?? '') + tlsHostAllowance,
    allowedOriginsRaw: (config.allowedOriginsRaw ?? '') + tlsHostAllowance,
    explicitAuthFlag: config.authEnabled,
  });

  // Auth
  let auth: AuthProvider | undefined;
  if (securityProfile.requireAuth) {
    const localAuth = new LocalAuthProvider();
    await localAuth.initialize();
    auth = localAuth;
    logger.log(`Daemon HTTP auth: token-based (local API guarded by auth-token)`);
  } else {
    logger.log(`Daemon HTTP auth: local profile (token auth not required on loopback)`);
  }

  // Hook system — enables remote supervision of terminal-started sessions
  const supervision = new SupervisionManager();
  const hookRouter = new HookRouter(daemon, supervision);
  const platformPlanHookSync = new PlatformPlanHookSync(daemon.configManager);
  daemon.on('hook:plan-proposed', (event) => {
    void platformPlanHookSync.send(event).catch((error) => {
      logger.warn(
        '[hooks] failed to sync plan proposal:',
        error instanceof Error ? error.message : String(error),
      );
    });
  });

  if (tls) {
    logger.log(`TLS:     enabled (host=${tls.tlsHost})`);
  }

  const app = Fastify({
    ...(tls ? { https: { cert: tls.cert, key: tls.key } } : {}),
    logger: {
      level: process.env['VIEWPORT_HTTP_LOG_LEVEL'] ?? 'info',
      // Prevent auth material from landing in request logs.
      redact: {
        paths: [...HTTP_LOG_REDACT_PATHS],
        censor: '[REDACTED]',
      },
    },
  });
  await app.register(fastifyCors, {
    origin: (origin, callback) => {
      const allowed = isOriginAllowed(origin, securityProfile);
      callback(null, allowed);
    },
  });
  await app.register(fastifyWebsocket);

  let shutdownExitCode = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let relayBridge: DaemonRelayBridge | null = null;
  let discoveryWatches: { stop: () => void } = { stop: () => undefined };
  let sessionPersistence: {
    flush: () => Promise<void>;
    clearPersistedState: () => Promise<void>;
  } = {
    flush: async () => undefined,
    clearPersistedState: async () => undefined,
  };

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownExitCode = exitCode;
    logger.log('\nShutting down...');

    await sessionPersistence.flush();
    discoveryWatches.stop();
    hookRouter.shutdown();
    if (relayBridge) {
      await relayBridge.stop();
      relayBridge = null;
    }
    await daemon.shutdown();
    await sessionPersistence.clearPersistedState();
    await app.close();
    if (socketPath) {
      await fs.rm(socketPath, { force: true }).catch(() => undefined);
    }
    process.exit(shutdownExitCode);
  };

  registerHttpRoutes(app, daemon, registry, {
    auth,
    hookRouter,
    securityProfile,
    runtime: {
      pid: process.pid,
      host,
      port,
      listen: config.listen,
      socketPath: config.socketPath,
      startedAt: runtimeStartedAt,
      version,
      relayEnabled: config.relayEnabled,
    },
    onLifecycleShutdown: async () => {
      if (!shutdownPromise) {
        shutdownPromise = shutdown(WORKER_EXIT_SHUTDOWN);
      }
      await shutdownPromise;
    },
    onLifecycleRestart: async () => {
      if (!shutdownPromise) {
        shutdownPromise = shutdown(WORKER_EXIT_RESTART);
      }
      await shutdownPromise;
    },
    getRelayStatus: () => relayBridge?.getStatus() ?? null,
  });
  registerWsServer(app, daemon, registry, { hookRouter, supervision, auth, securityProfile });

  let address = '';
  try {
    if (socketPath) {
      await fs.rm(socketPath, { force: true });
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      address = await app.listen({ path: socketPath });
    } else {
      address = await app.listen({ port, host });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (socketPath) {
        throw new Error(`Socket ${socketPath} is already in use. Try a different --listen path.`);
      }
      throw new Error(`Port ${port} is already in use. Try a different --listen target.`);
    }
    throw err;
  }

  const publicAddress = socketPath ? `unix://${socketPath}` : address;
  logger.log(`Viewport daemon listening at ${publicAddress}`);
  if (socketPath) {
    logger.log(`  HTTP:      unix://${socketPath}:/health`);
    logger.log(`  WebSocket: ws+unix://${socketPath}:/ws`);
  } else {
    logger.log(`  HTTP:      ${address}/health`);
    logger.log(`  WebSocket: ${address.replace('http', 'ws')}/ws`);
  }
  logger.log(`  Agents:    ${registry.getIds().join(', ') || 'none'}`);

  void (async () => {
    if (!config.relayEnabled) {
      return;
    }

    validateRelayRuntimeSecurity(config);
    const missing = missingRelayRuntimeConfig(config);
    const daemonWsUrl = localDaemonWsUrl(config);

    if (missing.length > 0) {
      logger.warn(`[relay] disabled due to incomplete config: ${missing.join(', ')}`);
      return;
    }

    try {
      const daemonToken = securityProfile.requireAuth ? await readDaemonAuthToken() : null;
      relayBridge = new DaemonRelayBridge({
        relayEndpoint: config.relayEndpoint!,
        relayServerUrl: config.relayServerUrl!,
        workspaceId: config.relayWorkspaceId!,
        runtimeTargetId: config.relayRuntimeTargetId,
        machineId: config.relayMachineId,
        issueToken: config.relayIssueToken,
        daemonWsUrl: daemonWsUrl!,
        daemonAuthToken: daemonToken ?? undefined,
        ...localDaemonBridgeTlsOptions(),
        relayTlsVerify: config.relayTlsVerify ?? 'auto',
        relayCaCertPath: config.relayCaCertPath,
        relayTlsPins: config.relayTlsPins,
        relayTokenIssuer: config.relayTokenIssuer,
        relayTokenAudience: config.relayTokenAudience,
        relayTokenJwksUrl: config.relayTokenJwksUrl,
        relayTokenSigningKeys: config.relayTokenSigningKeys,
        relayTokenClockSkewSec: config.relayTokenClockSkewSec,
        keyRotateAfterMessages: parsePositiveIntEnv('VIEWPORT_RELAY_KEY_ROTATE_AFTER_MESSAGES'),
      });
      await relayBridge.start();
      logger.log(
        `[relay] enabled (workspace=${config.relayWorkspaceId}, endpoint=${config.relayEndpoint})`,
      );
    } catch (err) {
      logger.warn('Relay bridge startup failed:', err);
    }
  })();

  void (async () => {
    try {
      sessionPersistence = await setupSessionPersistence(daemon);
    } catch (err) {
      logger.warn('Session persistence startup failed:', err);
    }

    try {
      const models = await registry.fetchAllModels();
      logger.log(`Models:  ${models.map((m) => m.displayName).join(', ') || 'none'}`);
    } catch {
      logger.log('Models:  fetch failed (will use fallback)');
    }

    try {
      await daemon.runDiscovery();
      daemon.emit('discovery:updated', {});
    } catch (err) {
      logger.warn('Initial discovery failed:', err);
    }

    try {
      discoveryWatches = await startDiscoveryWatchers(daemon, registry);
    } catch (err) {
      logger.warn('Discovery watcher startup failed:', err);
    }
  })();

  process.on('SIGINT', () => {
    if (!shutdownPromise) {
      shutdownPromise = shutdown(0);
    }
  });
  process.on('SIGTERM', () => {
    if (!shutdownPromise) {
      shutdownPromise = shutdown(0);
    }
  });
}
